#!/usr/bin/env node
// End-to-end smoke test on a throwaway embedded database.
// Runs migrate, seed, then every CLI command that matters, and asserts on the JSON.
// Passes on Windows and Linux. No network, no Postgres install.
// Set TEST_DATABASE_URL to run the same checks against a disposable Postgres.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'fuel-smoke-'));
const imp = path.join(dataDir, 'imports');
mkdirSync(imp);
const env = { ...process.env, DATA_DIR: path.join(dataDir, 'db') };
delete env.DATABASE_URL;
const pgUrl = process.env.TEST_DATABASE_URL;
if (pgUrl) env.DATABASE_URL = pgUrl;

let step = 0;
function run(label, args, { json = true, expectFail = false } = {}) {
  step++;
  const argv = [path.join(root, 'scripts', args[0]), ...args.slice(1), ...(json ? ['--json'] : [])];
  const res = spawnSync(process.execPath, argv, { cwd: root, env, encoding: 'utf8' });
  const ok = expectFail ? res.status !== 0 : res.status === 0;
  if (!ok) {
    console.error(`\nFAIL step ${step} (${label}): exit ${res.status}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`);
    process.exit(1);
  }
  console.log(`  ok  ${String(step).padStart(2)}  ${label}`);
  if (!json || expectFail) return { stdout: res.stdout, stderr: res.stderr };
  try {
    return JSON.parse(res.stdout);
  } catch {
    console.error(`\nFAIL step ${step} (${label}): output is not JSON\n${res.stdout}\n${res.stderr}`);
    process.exit(1);
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\nFAIL assertion: ${msg}`);
    process.exit(1);
  }
}

const n = (v) => Number(v ?? 0);
const F = 'fuel.mjs';

console.log(`smoke: ${pgUrl ? 'Postgres at TEST_DATABASE_URL' : `data dir ${dataDir}`}`);
try {
  if (pgUrl) {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: pgUrl });
    await c.connect();
    await c.query('drop schema public cascade; create schema public;');
    await c.end();
  }
  run('migrate', ['migrate.mjs'], { json: false });
  run('migrate again (idempotent)', ['migrate.mjs'], { json: false });
  run('seed', ['seed.mjs', '--demo-database'], { json: false });
  run('seed again (idempotent)', ['seed.mjs', '--demo-database'], { json: false });

  const stats = run('stats', [F, 'stats']);
  assert(stats.customers === 8 && stats.tanks === 14 && stats.compartments === 10, `8 customers, 14 tanks, 10 compartments (${JSON.stringify(stats)})`);
  assert(stats.dips > 200 && stats.deliveries > 20 && stats.runs > 10, 'sixty days of history');

  // ---- the attention list and the forecast -------------------------------------------------

  const att = run('attention', [F, 'attention']);
  const reasons = new Set(att.map((a) => a.reason));
  for (const r of ['runout', 'certificate_expired', 'driver_dg_expired', 'truck_expired', 'water', 'order_late', 'variance', 'debtor', 'dip_stale', 'no_price']) assert(reasons.has(r), `attention has ${r}`);
  const out = run('runout', [F, 'runout']);
  const kauri = out.find((r) => r.customer === 'Kauri Ridge Station');
  assert(kauri && n(kauri.days_to_empty) > 0 && n(kauri.days_to_empty) < 5 && !kauri.on_order, 'Kauri Ridge runs dry within days, nothing on order');
  assert(kauri.rate_from_dips && Math.abs(n(kauri.use_per_day) - 190) < 25, `usage measured from dips (${kauri.use_per_day})`);
  const all = run('runout --all', [F, 'runout', '--all']);
  assert(all.length === 14, 'every tank with --all');
  const usage = run('usage', [F, 'usage']);
  const puke = usage.find((u) => /Pukekohe/.test(u.label));
  assert(puke && n(puke.change_pct) > 25 && /USING MORE/.test(puke.read), 'the packhouse that started using more is flagged');
  const tank = run('tank card', [F, 'tank', 'woolshed']);
  assert(tank.dips.length > 3 && tank.forecast.tank_id === tank.tank.id, 'a tank card with dips and forecast');
  run('an ambiguous tank lists candidates', [F, 'tank', 'marina'], { expectFail: true });

  // ---- today's run: deliver, refuse, reconcile ----------------------------------------------

  const tooMuch = run('deliver past safe fill is refused', [F, 'deliver', 'ORD-7002', '--litres=5000', '--docket=DK9001'], { expectFail: true });
  assert(/safe fill/.test(tooMuch.stderr) && /No force flag/.test(tooMuch.stderr), 'refused on safe fill');
  run('deliver without a docket is refused', [F, 'deliver', 'ORD-7001', '--litres=9000'], { expectFail: true });
  const overBoard = run('deliver more than is on board is refused', [F, 'deliver', 'ORD-7001', '--litres=9500', '--docket=DK9002'], { expectFail: true });
  assert(/on board/.test(overBoard.stderr), 'refused: not on board');
  const prices = run('prices', [F, 'prices']);
  const mmDsl = prices.terminal_gate_prices.find((p) => p.terminal === 'Mount Maunganui Terminal' && p.product === 'DSL');
  const d1 = run('deliver ORD-7001', [F, 'deliver', '7001', '--litres=9000', '--docket=DK9003', '--signed=Depot supervisor']);
  assert(Math.abs(d1.price_cpl - (n(mmDsl.tgp_cpl) + 5.8)) < 0.001, `priced at the gate price plus margin (${d1.price_cpl})`);
  assert(Math.abs(d1.value_ex_gst - (9000 * d1.price_cpl) / 100) < 0.01, 'value is litres times price');
  run('deliver ORD-7002 within safe fill', [F, 'deliver', 'ORD-7002', '--litres=4800', '--docket=DK9004']);
  const done = run('complete the run', [F, 'complete', 'RUN-4025']);
  const pulp = done.reconcile.find((r) => r.product === 'PULP95');
  assert(n(pulp.variance_l) === 200 && n(pulp.variance_pct) === 4, '200 L of premium left on board');
  const att2 = run('attention after the run', [F, 'attention']);
  assert(att2.some((a) => a.reason === 'variance' && /RUN-4025/.test(a.label)), 'the unexplained variance is on the list');
  run('explain the variance', [F, 'complete', 'RUN-4025', '--note=200 L of premium retained on board for the next marina run']);
  const att3 = run('attention after the note', [F, 'attention']);
  assert(!att3.some((a) => a.reason === 'variance' && /RUN-4025/.test(a.label)), 'explained variance leaves the list');
  const recon = run('reconcile', [F, 'reconcile']);
  assert(recon.flagged.length >= 1 && recon.by_truck.length >= 2, 'reconcile by tanker, with the flagged run');

  // ---- planning tomorrow ----------------------------------------------------------------------

  const badPlan = run('plan with a lapsed driver is refused', [F, 'plan-run', '--truck=KMF101', '--driver=Mike Dawson'], { expectFail: true });
  assert(/endorsement lapsed/.test(badPlan.stderr), 'refused: driver');
  const badTruck = run('plan with a lapsed meter is refused', [F, 'plan-run', '--truck=KMF202', '--driver=Priya'], { expectFail: true });
  assert(/meter certification lapsed/.test(badTruck.stderr), 'refused: meter');
  const draft = run('plan-run dry run', [F, 'plan-run', '--truck=KMF101', '--driver=Priya', '--dry-run']);
  assert(draft.dry_run && draft.drops.some((d) => /Kauri/.test(d.label)) && draft.skipped.some((s) => /Brennan/.test(s.label) && /certificate/.test(s.why)), 'Kauri on, Brennan off for its certificate');
  assert(draft.drops.reduce((a, d) => a + d.litres, 0) <= 18000, 'never more than the tanker holds');
  assert(draft.drops.some((d) => /OVER LIMIT/.test(d.account)), 'the over-limit account is flagged on the run');
  const afterDry = run('dry run wrote nothing', [F, 'stats']);
  assert(afterDry.runs === stats.runs, 'no run written');
  run('hold Matamata Contractors', [F, 'hold', 'Matamata']);
  const plan = run('plan-run for real', [F, 'plan-run', '--truck=KMF101', '--driver=Priya']);
  assert(plan.ref && !plan.drops.some((d) => /Matamata/.test(d.label)) && plan.skipped.some((s) => /Matamata/.test(s.label) && /on_hold/.test(s.why)), 'the held customer is left off');
  const kDrop = plan.drops.find((d) => /Kauri/.test(d.label));
  run('load the tanker', [F, 'load', plan.ref, '--product=DSL', `--litres=${plan.lift[0].litres}`, '--bol=BOL-SMOKE-1', '--on=tomorrow']);
  const kd = run('deliver to Kauri Ridge', [F, 'deliver', kDrop.ref, `--litres=${kDrop.litres}`, '--docket=DK9010', '--on=tomorrow']);
  assert(kd.after <= 5700, 'within safe fill');
  run('the run card', [F, 'run', plan.ref]);

  // ---- certificates, endorsements, water ------------------------------------------------------

  run('order for the lapsed-certificate tank', [F, 'order', 'runoff', '--litres=2000', '--required=tomorrow']);
  const certPlan = run('plan skips the lapsed tank', [F, 'plan-run', '--truck=KMF101', '--driver=Aroha', '--dry-run']);
  assert(certPlan.skipped.some((s) => /Runoff/.test(s.label)), 'skipped for its certificate');
  run('record the new certificate', [F, 'cert', 'runoff', '--ref=LCC-22999', '--expires=2027-11-30']);
  const certPlan2 = run('now it plans', [F, 'plan-run', '--truck=KMF101', '--driver=Aroha', '--dry-run']);
  assert(certPlan2.drops.some((d) => /Runoff/.test(d.label)), 'planned once certified');
  const c3 = run('compliance before the renewals', [F, 'compliance', 'driver-dg']);
  assert(c3[0].breaches.some((b) => /RUN-4024/.test(b.label)), 'the run Mike drove while lapsed is found');
  run('renew the endorsement', [F, 'endorse', 'Mike', '--expires=2028-11-05']);
  run('certify the meter', [F, 'truck-cert', 'KMF202', '--meter=2027-11-10']);
  const c4 = run('compliance', [F, 'compliance']);
  const byKey = Object.fromEntries(c4.map((r) => [r.key, r]));
  assert(byKey.meter.breaches.length === 0, 'meter rule clears once certified');
  assert(byKey['bill-of-lading'].breaches.length === 1 && byKey.docket.breaches.length >= 1 && byKey.water.breaches.length === 1, 'the paperwork gaps are found');
  assert(byKey['safe-fill'].breaches.length === 0, 'no overfills');
  const dip = run('a dip with water', [F, 'dip', 'kauri', '--litres=5200', '--water=25', '--source=driver']);
  assert(dip.dip.water_mm === 25, 'water recorded');

  // ---- prices and money -----------------------------------------------------------------------

  const tgp = run('post today\'s ULP91 at Mount Maunganui', [F, 'tgp', '--terminal=Mount', '--product=ULP91', '--cpl=229.10']);
  assert(tgp.tgp_cpl === 229.1, 'posted');
  const att4 = run('attention after the post', [F, 'attention']);
  assert(!att4.some((a) => a.reason === 'no_price'), 'no stale price left');
  run('change a margin', [F, 'margin', 'Northline', '--cpl=6.2']);
  const margins = run('margins', [F, 'margins']);
  assert(margins.customers.length >= 6 && n(margins.total.margin) > 0, 'margin by customer');
  const debt = run('debtors', [F, 'debtors']);
  const mat = debt.find((d) => d.customer === 'Matamata Contractors');
  assert(mat && n(mat.owed_ex_gst) > n(mat.credit_limit), 'over its limit');
  const unpaid = run('unpaid deliveries', [F, 'deliveries', 'Matamata', '--days=90', '--unpaid']);
  run('mark one paid', [F, 'paid', unpaid[0].ref]);
  run('paid twice is refused', [F, 'paid', unpaid[0].ref], { expectFail: true });
  run('release the hold', [F, 'hold', 'Matamata', '--release']);

  // ---- housekeeping ---------------------------------------------------------------------------

  run('add a customer', [F, 'add', 'customer', 'Tirau Transport', '--code=C109', '--kind=transport', '--terminal=Wiri', '--margin=7']);
  run('add a site', [F, 'add', 'site', 'Depot', '--customer=Tirau Transport', '--region=Waikato']);
  run('add a tank', [F, 'add', 'tank', 'D1', '--customer=Tirau', '--site=Depot', '--product=DSL', '--capacity=25000', '--keep-full', '--use=900', '--cert=LCC-40001', '--cert-expires=2027-09-01']);
  run('add a driver', [F, 'add', 'driver', 'Sam Te Rangi', '--dg-expires=2027-08-01']);
  run('add a truck', [F, 'add', 'truck', 'kmf303', '--vehicle=2027-06-01', '--meter=2027-06-01', '--compartments=7000,6000,5000']);
  run('log a note', [F, 'log', 'Kauri', 'Jo asked to move to keep full on the runoff tank too.']);
  run('order a fill', [F, 'order', 'tirau d1', '--required=tomorrow']);

  // ---- import from PDI ------------------------------------------------------------------------

  writeFileSync(path.join(imp, 'customers.csv'), 'Customer ID,Customer Name,Contact,Phone,Email,Margin,Payment Terms,Credit Limit\r\nP2001,Okoroire Dairy,Ana Hill,021 1,ana@okoroire.example,13.5,Net 20,15000\r\nP2002,"Lichfield Haulage, Ltd",Ben Roe,021 2,,,20th of month,\r\n');
  writeFileSync(path.join(imp, 'tanks.csv'), 'Customer ID,Site Name,Tank Number,Product,Capacity,Keep Full,Telemetry,Daily Usage,Certificate,Certificate Expiry\r\nP2001,Dairy shed,T1,DSL,"6,000",Y,N,150,LCC-50001,2027-04-30\r\nP2002,Yard,T1,DSL,20000,Y,Y,800,,\r\nP2002,Yard,T2,JETA1,5000,N,N,,,\r\n');
  writeFileSync(path.join(imp, 'deliveries.csv'), 'Ticket Number,Delivery Date,Customer ID,Tank Number,Product,Quantity,Unit Price,Invoice Number,Paid\r\nT-7701,2026-10-01,P2001,T1,DSL,"4,200",1.62,INV-9901,Y\r\nT-7702,2026-10-03,P2002,T1,DSL,15000,158.4,INV-9902,N\r\nT-7703,2026-10-03,P9999,T1,DSL,100,1.6,INV-9903,N\r\n');
  const imports = ['import', 'pdi', `--customers=${path.join(imp, 'customers.csv')}`, `--tanks=${path.join(imp, 'tanks.csv')}`, `--deliveries=${path.join(imp, 'deliveries.csv')}`];
  const dryImp = run('import dry run', [F, ...imports, '--dry-run']);
  assert(dryImp.dry_run && dryImp.customers === 2 && dryImp.tanks === 2 && dryImp.deliveries === 2, `two customers, two tanks, two deliveries (${JSON.stringify(dryImp)})`);
  assert(dryImp.skipped.some((s) => /JETA1/.test(s)) && dryImp.skipped.some((s) => /P9999/.test(s)), 'unknown product and customer skipped');
  const before = run('dry run wrote nothing', [F, 'stats']);
  const realImp = run('import for real', [F, ...imports]);
  assert(realImp.customers === 2 && realImp.warnings.some((w) => /no certificate expiry/.test(w)) && realImp.warnings.some((w) => /no margin/.test(w)), 'the import is the first audit');
  const after = run('the records arrived', [F, 'stats']);
  assert(after.customers === before.customers + 2 && after.deliveries === before.deliveries + 2, 'two customers and two deliveries more');
  const dd = run('imported prices read as cents', [F, 'deliveries', 'Okoroire', '--days=400']);
  assert(dd.length === 1 && n(dd[0].price_cpl) === 162, 'dollars a litre became cents');
  const again = run('import twice skips what is there', [F, ...imports]);
  assert(again.customers === 0 && again.deliveries === 0, 'nothing duplicated');

  const outFile = path.join(dataDir, 'export.json');
  const dump = run('export', [F, 'export', `--out=${outFile}`]);
  const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
  assert(parsed.deliveries.length === n(dump.counts.deliveries), 'the counts match the file');

  // ---- the branded HTML -----------------------------------------------------------------------

  const views = run('npm run view', ['view.mjs'], { json: false });
  assert(/dispatch-board\.html/.test(views.stdout) && /stock-and-money\.html/.test(views.stdout), 'both views rendered');
  const board = readFileSync(path.join(root, 'views', 'dispatch-board.html'), 'utf8');
  assert(board.includes('Needs a decision') && board.includes('Tanks at reorder') && board.includes('Brennan Civil'), 'the board has its sections');
  const docsOut = run('npm run docs', ['docs.mjs'], { json: false });
  for (const d of ['delivery-docket', 'customer-statement', 'run-sheet']) assert(docsOut.stdout.includes(d), `${d} rendered`);

  // ---- the human readable side ----------------------------------------------------------------

  for (const args of [['attention'], ['week'], ['runout'], ['runout', '--all', '--region=Waikato'], ['tanks'], ['tank', 'kauri'], ['customers', '--all'], ['customer', 'Northline'], ['orders', '--all'], ['runs'], ['run', 'RUN-4025'], ['reconcile'], ['reconcile', 'RUN-4025'], ['prices'], ['margins'], ['usage'], ['debtors'], ['deliveries'], ['drivers'], ['trucks'], ['compliance'], ['compliance', 'water'], ['stats']]) {
    run(`${args.join(' ')} (text)`, [F, ...args], { json: false });
  }
  run('help', [F, 'help'], { json: false });
  run('an unknown command exits 1', [F, 'nonsense'], { json: false, expectFail: true });

  console.log(`\n${step} checks, PASS`);
} finally {
  if (existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows can hold the handle briefly; a leftover temp dir is harmless.
    }
  }
}
