#!/usr/bin/env node
// fuel-distribution-for-claude-code: the one CLI. Claude Code slash commands
// call this; so can you.
//
//   node scripts/fuel.mjs <command> [args] [--flags] [--json]
//
// Run with no arguments (or `help`) for the command list.
//
// This system is a fuel distributor's record: the terminals it lifts from and
// their posted terminal gate prices, the customers and the tanks on their
// sites, the dips that say how full each tank is, the orders, the tankers and
// their compartments, the drivers, the runs, the liftings at the terminal and
// the deliveries into each tank, and what each customer owes.
//
// The sharp edges are deliberate. A delivery cannot go into a tank past its
// safe fill, into a tank whose certificate has lapsed, from a tanker whose
// vehicle certificate or meter certification has lapsed, by a driver whose
// dangerous goods endorsement has lapsed, or for a customer on hold. A run
// cannot be planned with a lapsed driver or tanker. There is no force flag.
// Nothing here connects to a terminal, a telemetry provider, a bank or a
// customer, and nothing sends.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb, REPO_ROOT } from './lib/db.mjs';
import { parseCsv, pick, yesNo } from './lib/csv.mjs';
import { table, isoDate, short, heading, bar } from './lib/format.mjs';

// ---------------------------------------------------------------------------
// Argument parsing

const BOOL_FLAGS = new Set(['json', 'help', 'all', 'dry-run', 'keep-full', 'telemetry', 'no-certificate', 'unpaid', 'release']);

function parseArgv(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      flags.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name;
      let value;
      if (eq > -1) {
        name = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        name = a.slice(2);
        const next = argv[i + 1];
        if (BOOL_FLAGS.has(name) || next === undefined || next.startsWith('--')) value = true;
        else value = argv[++i];
      }
      flags[name] = value;
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const num = (v) => Number(v ?? 0);
const str = (v) => (v === true || v === undefined || v === null ? '' : String(v));
const money = (v) => (num(v) < 0 ? '-' : '') + '$' + Math.abs(num(v)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const litres = (v) => `${Math.round(num(v)).toLocaleString('en-NZ')} L`;
const cpl = (v) => (v === null || v === undefined ? '' : `${num(v).toFixed(2)}c`);
const VARIANCE_LIMIT = 0.5; // per cent, loaded against delivered per run and product

function need(flags, name, what) {
  const v = str(flags[name]);
  if (!v) throw new CliError(`Missing --${name}${what ? ` (${what})` : ''}.`);
  return v;
}

function wholeLitres(v, what = 'Litres') {
  const n = Number(String(v).replace(/[,\s]|l$/gi, ''));
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`${what} must be a number above zero ("${v}").`);
  return Math.round(n);
}

// ---------------------------------------------------------------------------
// Dates

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
}

function parseDate(v, what = 'date') {
  if (!v || v === true) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const lower = s.toLowerCase();
  if (lower === 'today') return today();
  if (lower === 'yesterday') return addDays(today(), -1);
  if (lower === 'tomorrow') return addDays(today(), 1);
  // New Zealand and Australia write DD/MM/YYYY.
  const slash = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const [day, month] = b > 12 ? [b, a] : [a, b];
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new CliError(`"${v}" is not a ${what}. Use YYYY-MM-DD.`);
  return isoDate(d);
}

// ---------------------------------------------------------------------------
// Lookups: id prefix, exact ref or name, then every word contained. One hit
// wins; several list the candidates and exit 1.

const TANK_LABEL = "c.name || ' / ' || s.name || ' / ' || t.tank_no";

const RESOLVERS = {
  customer: {
    from: 'customers c',
    cols: 'c.*',
    exact: "lower(c.name) = lower($1) or lower(coalesce(c.code, '')) = lower($1) or lower(coalesce(c.external_ref, '')) = lower($1)",
    haystack: "c.name || ' ' || coalesce(c.code, '') || ' ' || coalesce(c.contact_name, '')",
    label: (r) => `${r.name} (${r.code || 'no code'}, ${r.status})`,
    order: 'c.name',
    listing: 'customers --all',
  },
  tank: {
    from: 'tanks t join sites s on s.id = t.site_id join customers c on c.id = s.customer_id join products p on p.id = t.product_id',
    cols: `t.*, s.name as site, s.access_notes, c.id as customer_id, c.name as customer, c.status as customer_status, c.margin_cpl, c.home_terminal_id, p.code as product, ${TANK_LABEL} as label`,
    exact: "lower(coalesce(t.external_ref, '')) = lower($1) or lower(" + TANK_LABEL + ') = lower($1)',
    haystack: "c.name || ' ' || coalesce(c.code, '') || ' ' || s.name || ' ' || t.tank_no || ' ' || p.code",
    label: (r) => `${r.label} (${r.product}, ${num(r.capacity_l).toLocaleString('en-NZ')} L)`,
    order: 'c.name, s.name, t.tank_no',
    listing: 'tanks',
  },
  order: {
    from: 'orders o join tanks t on t.id = o.tank_id join sites s on s.id = t.site_id join customers c on c.id = s.customer_id join products p on p.id = t.product_id',
    cols: `o.*, ${TANK_LABEL} as tank_label, c.name as customer, c.status as customer_status, p.code as product`,
    exact: "lower(o.ref) = lower($1) or lower(o.ref) = lower('ORD-' || $1) or lower(coalesce(o.po_number, '')) = lower($1) or lower(coalesce(o.external_ref, '')) = lower($1)",
    haystack: "o.ref || ' ' || c.name || ' ' || s.name || ' ' || coalesce(o.po_number, '')",
    label: (r) => `${r.ref}  ${r.tank_label}, required ${isoDate(r.required_on)} (${r.status})`,
    order: 'o.required_on',
    listing: 'orders --all',
  },
  run: {
    from: 'runs r join trucks tr on tr.id = r.truck_id join drivers d on d.id = r.driver_id join terminals tm on tm.id = r.terminal_id',
    cols: 'r.*, tr.rego, tr.dg_vehicle_expires_on, tr.meter_certified_until, d.name as driver, d.dg_endorsement_expires_on, tm.name as terminal',
    exact: "lower(r.ref) = lower($1) or lower(r.ref) = lower('RUN-' || $1)",
    haystack: "r.ref || ' ' || tr.rego || ' ' || d.name",
    label: (r) => `${r.ref}  ${isoDate(r.run_on)}, ${r.rego}, ${r.driver} (${r.status})`,
    order: 'r.run_on desc',
    listing: 'runs',
  },
  driver: {
    from: 'drivers d',
    cols: 'd.*',
    exact: 'lower(d.name) = lower($1)',
    haystack: 'd.name',
    label: (r) => `${r.name} (${r.status})`,
    order: 'd.name',
    listing: 'drivers',
  },
  truck: {
    from: 'trucks tr',
    cols: 'tr.*',
    exact: 'lower(tr.rego) = lower($1) or lower(coalesce(tr.name, \'\')) = lower($1)',
    haystack: "tr.rego || ' ' || coalesce(tr.name, '')",
    label: (r) => `${r.rego} ${r.name || ''} (${r.status})`,
    order: 'tr.rego',
    listing: 'trucks',
  },
  terminal: {
    from: 'terminals tm',
    cols: 'tm.*',
    exact: 'lower(tm.name) = lower($1)',
    haystack: "tm.name || ' ' || coalesce(tm.supplier, '') || ' ' || coalesce(tm.region, '')",
    label: (r) => `${r.name} (${r.region || ''})`,
    order: 'tm.name',
    listing: 'prices',
  },
  product: {
    from: 'products p',
    cols: 'p.*',
    exact: 'lower(p.code) = lower($1) or lower(p.name) = lower($1)',
    haystack: "p.code || ' ' || p.name",
    label: (r) => `${r.code} ${r.name}`,
    order: 'p.code',
    listing: 'prices',
  },
  delivery: {
    from: 'deliveries dv',
    cols: 'dv.*',
    exact: "lower(dv.ref) = lower($1) or lower(dv.ref) = lower('DEL-' || $1) or lower(coalesce(dv.invoice_no, '')) = lower($1) or lower(coalesce(dv.docket_no, '')) = lower($1)",
    haystack: "dv.ref || ' ' || coalesce(dv.invoice_no, '') || ' ' || coalesce(dv.docket_no, '')",
    label: (r) => `${r.ref} ${isoDate(r.delivered_on)} ${r.litres} L`,
    order: 'dv.delivered_on desc',
    listing: 'deliveries',
  },
};

const ID_RE = /^[0-9a-f]{4,8}(-[0-9a-f-]*)?$/i;

async function resolve(db, kind, q, { optional = false } = {}) {
  const spec = RESOLVERS[kind];
  q = String(q ?? '').trim();
  if (!q || q === 'true') {
    if (optional) return null;
    throw new CliError(`Give me a ${kind} name, reference or id.`);
  }
  const select = `select ${spec.cols} from ${spec.from}`;
  let rows = [];
  if (ID_RE.test(q)) {
    const alias = spec.from.split(' ')[1];
    rows = await db.query(`${select} where ${alias}.id::text like $1 order by ${spec.order}`, [q.toLowerCase() + '%']);
    if (rows.length === 1) return rows[0];
  }
  rows = await db.query(`${select} where ${spec.exact} order by ${spec.order}`, [q]);
  if (rows.length === 1) return rows[0];
  if (!rows.length) {
    const words = q.split(/[\s/]+/).filter(Boolean);
    const where = words.map((_, i) => `(${spec.haystack}) ilike $${i + 1}`).join(' and ');
    rows = await db.query(`${select} where ${where} order by ${spec.order}`, words.map((w) => `%${w}%`));
  }
  if (rows.length === 1) return rows[0];
  if (!rows.length) {
    if (optional) return null;
    throw new CliError(`No ${kind} matches "${q}". Run \`${spec.listing}\` to see what exists.`);
  }
  throw new CliError(
    `"${q}" matches ${rows.length} ${kind} records. Use a reference, an id, or more words:\n` +
      rows.map((r) => `  ${short(r.id)}  ${spec.label(r)}`).join('\n'),
  );
}

async function nextRef(db, prefix, tableName, start) {
  const [r] = await db.query(
    `select coalesce(max(substring(ref from ${prefix.length + 2})::int), ${start}) + 1 as n from ${tableName} where ref ~ '^${prefix}-[0-9]+$'`,
  );
  return `${prefix}-${r.n}`;
}

async function note(db, kind, id, label, body) {
  await db.query('insert into notes (target_kind, target_id, target_label, body) values ($1, $2, $3, $4)', [kind, id, label, body]);
}

async function setting(db, key, dflt) {
  const [r] = await db.query('select value from settings where key = $1', [key]);
  return r ? r.value : dflt;
}

// The terminal gate price for a product at a terminal on a date: that day's post, or the last one before it.
async function tgpOn(db, terminalId, productId, on) {
  const [r] = await db.query(
    'select tgp_cpl, effective_on from terminal_prices where terminal_id = $1 and product_id = $2 and effective_on <= $3 order by effective_on desc limit 1',
    [terminalId, productId, on],
  );
  return r || null;
}

// ---------------------------------------------------------------------------
// Column sets

const RUNOUT_COLS = [
  { key: 'label', label: 'tank', width: 44 },
  { key: 'product', label: 'product' },
  { key: 'pct_full', label: 'full', format: (v) => `${bar(v, 8)} ${num(v)}%` },
  { key: 'est_l', label: 'about', align: 'right', format: (v) => (v === null ? '?' : num(v).toLocaleString('en-NZ')) },
  { key: 'use_per_day', label: 'L/day', align: 'right', format: (v, r) => `${num(v)}${r.rate_from_dips ? '' : '*'}` },
  { key: 'days_to_reorder', label: 'reorder in', align: 'right', format: (v) => (v === null ? '?' : num(v) <= 0 ? 'NOW' : `${num(v)}d`) },
  { key: 'days_to_empty', label: 'empty in', align: 'right', format: (v) => (v === null ? '?' : `${num(v)}d`) },
  { key: 'room_l', label: 'room', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
  { key: 'on_order', label: 'order', format: (v) => (v ? 'on order' : '') },
  { key: 'dip_age_days', label: 'dipped', align: 'right', format: (v, r) => (v === null ? 'never' : `${v}d ago${r.telemetry ? ' (sensor)' : ''}`) },
];

const ORDER_COLS = [
  { key: 'ref', label: 'order' },
  { key: 'tank', label: 'tank', width: 44 },
  { key: 'product', label: 'product' },
  { key: 'litres_requested', label: 'asked', align: 'right', format: (v) => (v ? num(v).toLocaleString('en-NZ') : 'fill') },
  { key: 'required_on', label: 'required', format: (v) => isoDate(v) },
  { key: 'source', label: 'from' },
  { key: 'run_ref', label: 'run', format: (v) => v || '' },
  { key: 'planned_litres', label: 'planned', align: 'right', format: (v) => (v ? num(v).toLocaleString('en-NZ') : '') },
  { key: 'status', label: 'status', format: (v, r) => (['open', 'planned'].includes(v) && isoDate(r.required_on) < today() ? `${v} LATE` : v) },
];

const DELIVERY_COLS = [
  { key: 'ref', label: 'delivery' },
  { key: 'delivered_on', label: 'date', format: (v) => isoDate(v) },
  { key: 'customer', label: 'customer', width: 24 },
  { key: 'site', label: 'site', width: 22 },
  { key: 'tank_no', label: 'tank' },
  { key: 'product', label: 'product' },
  { key: 'litres', label: 'litres', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
  { key: 'price_cpl', label: 'c/L', align: 'right', format: (v) => num(v).toFixed(2) },
  { key: 'value_ex_gst', label: 'ex GST', align: 'right', format: (v) => money(v) },
  { key: 'docket_no', label: 'docket', format: (v) => v || 'NONE' },
  { key: 'run_ref', label: 'run', format: (v) => v || '' },
];

// ---------------------------------------------------------------------------
// Reads

async function cmdRunout(db, args, flags) {
  const within = flags.days ? Number(flags.days) : 7;
  const where = [];
  const params = [];
  if (!flags.all) {
    params.push(within);
    where.push(`(days_to_empty is null or days_to_reorder <= $${params.length})`);
  }
  if (flags.region) {
    params.push(`%${str(flags.region)}%`);
    where.push(`region ilike $${params.length}`);
  }
  if (args.length) {
    const c = await resolve(db, 'customer', args.join(' '));
    params.push(c.id);
    where.push(`customer_id = $${params.length}`);
  }
  const rows = await db.query(
    `select *, customer || ' / ' || site || ' / ' || tank_no as label from v_runout ${where.length ? 'where ' + where.join(' and ') : ''}
     order by days_to_empty nulls first, customer`,
    params,
  );
  const text =
    heading(flags.all ? `Every tank (${rows.length})` : `Tanks at or below reorder within ${within} days (${rows.length})`) +
    '\n' +
    table(rows, RUNOUT_COLS) +
    '\n\nThe level is the last dip, plus what we delivered since, less the usage rate for the days since.' +
    '\n* no usage rate from dips yet: the tank\'s set daily use stands in. A tank never dipped shows ? and is a guess.';
  return { json: rows, text };
}

async function cmdTanks(db, args, flags) {
  const params = [];
  let where = "where t.status = 'active'";
  if (flags.all) where = '';
  if (args.length) {
    const c = await resolve(db, 'customer', args.join(' '));
    params.push(c.id);
    where += `${where ? ' and' : 'where'} t.customer_id = $${params.length}`;
  }
  const rows = await db.query(
    `select t.*, t.customer || ' / ' || t.site || ' / ' || t.tank_no as label from v_tanks t ${where} order by t.customer, t.site, t.tank_no`,
    params,
  );
  const text =
    heading(`Tanks (${rows.length})`) +
    '\n' +
    table(rows, [
      { key: 'label', label: 'tank', width: 46 },
      { key: 'product', label: 'product' },
      { key: 'capacity_l', label: 'capacity', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
      { key: 'safe_fill_l', label: 'safe fill', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
      { key: 'est_l', label: 'about now', align: 'right', format: (v) => (v === null ? '?' : num(v).toLocaleString('en-NZ')) },
      { key: 'keep_full', label: 'keep full', format: (v, r) => `${v ? 'yes' : ''}${r.telemetry ? ' sensor' : ''}` },
      { key: 'certificate_expires_on', label: 'certificate', format: (v, r) => (!r.certificate_required ? 'not needed' : !v ? 'NONE' : `${isoDate(v)}${isoDate(v) < today() ? ' EXPIRED' : ''}`) },
    ]);
  return { json: rows, text };
}

async function cmdTank(db, args) {
  const t = await resolve(db, 'tank', args.join(' '));
  const [v] = await db.query('select * from v_runout where tank_id = $1', [t.id]);
  const dips = await db.query('select dipped_on, litres, water_mm, source, by_name from dips where tank_id = $1 order by dipped_on desc, created_at desc limit 10', [t.id]);
  const dels = await db.query('select * from v_deliveries where tank_id = $1 order by delivered_on desc limit 8', [t.id]);
  const orders = await db.query("select o.*, r.ref as run_ref from orders o left join runs r on r.id = o.run_id where o.tank_id = $1 and o.status in ('open', 'planned') order by o.required_on", [t.id]);
  const notes = await db.query("select created_at, body from notes where target_id = $1 order by created_at desc limit 5", [t.id]);
  let text = heading(t.label);
  text += `\n  Product:      ${t.product}, ${litres(t.capacity_l)} tank, safe fill ${t.safe_fill_pct}% (${litres(Math.floor((t.capacity_l * t.safe_fill_pct) / 100))}), reorder at ${t.reorder_pct}%`;
  text += `\n  Watching:     ${t.keep_full ? 'keep full (we fill it without an order)' : 'fills on order'}${t.telemetry ? ', level sensor' : ''}`;
  text += `\n  Certificate:  ${!t.certificate_required ? 'not needed for this tank' : t.certificate_ref ? `${t.certificate_ref}, expires ${isoDate(t.certificate_expires_on)}${isoDate(t.certificate_expires_on) < today() ? ' (EXPIRED: no deliveries)' : ''}` : 'NONE on file (no deliveries)'}`;
  if (v) text += `\n  Now:          about ${v.est_l === null ? '?' : litres(v.est_l)}, using ${litres(v.use_per_day)} a day${v.rate_from_dips ? '' : ' (set, not measured)'}, ${v.days_to_reorder === null ? 'reorder date unknown' : num(v.days_to_reorder) <= 0 ? 'AT REORDER NOW' : `reorder in ${v.days_to_reorder} days`}, empty in ${v.days_to_empty ?? '?'} days, room for ${litres(v.room_l)}`;
  if (t.access_notes) text += `\n  Access:       ${t.access_notes}`;
  text += '\n\nDips\n' + table(dips, [{ key: 'dipped_on', label: 'date', format: (x) => isoDate(x) }, { key: 'litres', label: 'litres', align: 'right' }, { key: 'water_mm', label: 'water mm', align: 'right', format: (x) => (num(x) ? `${x} !` : '0') }, { key: 'source', label: 'source' }, { key: 'by_name', label: 'by' }]);
  text += '\n\nDeliveries\n' + table(dels, [{ key: 'ref', label: 'delivery' }, { key: 'delivered_on', label: 'date', format: (x) => isoDate(x) }, { key: 'litres', label: 'litres', align: 'right' }, { key: 'before_litres', label: 'before', align: 'right' }, { key: 'after_litres', label: 'after', align: 'right' }, { key: 'price_cpl', label: 'c/L', align: 'right' }, { key: 'docket_no', label: 'docket' }]);
  if (orders.length) text += '\n\nOn order\n' + table(orders.map((o) => ({ ...o, tank: t.label, product: t.product })), ORDER_COLS);
  if (notes.length) text += '\n\nNotes\n' + notes.map((n) => `  ${isoDate(n.created_at)}  ${n.body}`).join('\n');
  return { json: { tank: t, forecast: v, dips, deliveries: dels, orders, notes }, text };
}

async function cmdCustomers(db, args, flags) {
  const rows = await db.query(
    `select c.*, d.owed_ex_gst, d.overdue_ex_gst, (select count(*) from tanks t join sites s on s.id = t.site_id where s.customer_id = c.id and t.status = 'active') as tanks,
       (select coalesce(sum(dv.litres), 0) from deliveries dv join tanks t on t.id = dv.tank_id join sites s on s.id = t.site_id where s.customer_id = c.id and dv.delivered_on > current_date - 30) as litres_30d
     from customers c join v_debtors d on d.customer_id = c.id ${flags.all ? '' : "where c.status <> 'closed'"} order by c.name`,
  );
  const text =
    heading(`Customers (${rows.length})`) +
    '\n' +
    table(rows, [
      { key: 'name', label: 'customer', width: 26 },
      { key: 'code', label: 'code' },
      { key: 'kind', label: 'kind' },
      { key: 'tanks', label: 'tanks', align: 'right' },
      { key: 'litres_30d', label: 'L 30 days', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
      { key: 'margin_cpl', label: 'margin', align: 'right', format: (v) => cpl(v) },
      { key: 'owed_ex_gst', label: 'owed', align: 'right', format: (v) => money(v) },
      { key: 'overdue_ex_gst', label: 'overdue', align: 'right', format: (v) => (num(v) ? money(v) : '') },
      { key: 'credit_limit', label: 'limit', align: 'right', format: (v, r) => (v === null ? '' : `${money(v)}${num(r.owed_ex_gst) > num(v) ? ' OVER' : ''}`) },
      { key: 'status', label: 'status' },
    ]);
  return { json: rows, text };
}

async function cmdCustomer(db, args) {
  const c = await resolve(db, 'customer', args.join(' '));
  const [d] = await db.query('select * from v_debtors where customer_id = $1', [c.id]);
  const tanks = await db.query("select *, site || ' / ' || tank_no as label from v_runout where customer_id = $1 order by site, tank_no", [c.id]);
  const dels = await db.query('select * from v_deliveries where customer_id = $1 order by delivered_on desc limit 10', [c.id]);
  const notes = await db.query('select created_at, body from notes where target_id = $1 order by created_at desc limit 5', [c.id]);
  const [term] = await db.query('select name from terminals where id = $1', [c.home_terminal_id]);
  let text = heading(`${c.name} (${c.code || 'no code'})`);
  text += `\n  Contact:   ${c.contact_name || ''} ${c.phone || ''} ${c.email || ''}`;
  text += `\n  Price:     terminal gate price at ${term ? term.name : 'no home terminal'} plus ${cpl(c.margin_cpl)} a litre, ${c.terms_days} day terms`;
  text += `\n  Account:   ${money(d.owed_ex_gst)} ex GST owed, ${money(d.overdue_ex_gst)} overdue${c.credit_limit ? `, limit ${money(c.credit_limit)}` : ''}${c.status !== 'active' ? `  (${c.status.toUpperCase()})` : ''}`;
  text += '\n\nTanks\n' + table(tanks, RUNOUT_COLS);
  text += '\n\nRecent deliveries\n' + table(dels, DELIVERY_COLS.filter((col) => !['customer'].includes(col.key)));
  if (notes.length) text += '\n\nNotes\n' + notes.map((n) => `  ${isoDate(n.created_at)}  ${n.body}`).join('\n');
  return { json: { customer: c, account: d, tanks, deliveries: dels, notes }, text };
}

async function cmdOrders(db, args, flags) {
  const rows = await db.query(
    `select o.*, c.name || ' / ' || s.name || ' / ' || t.tank_no as tank, p.code as product, r.ref as run_ref
     from orders o join tanks t on t.id = o.tank_id join sites s on s.id = t.site_id join customers c on c.id = s.customer_id
     join products p on p.id = t.product_id left join runs r on r.id = o.run_id
     ${flags.all ? '' : "where o.status in ('open', 'planned')"} order by o.required_on, o.ref`,
  );
  return { json: rows, text: heading(`${flags.all ? 'Orders' : 'Open and planned orders'} (${rows.length})`) + '\n' + table(rows, ORDER_COLS) };
}

async function cmdRuns(db, args, flags) {
  const days = flags.days ? Number(flags.days) : 14;
  const rows = await db.query(
    `select r.*, tr.rego, d.name as driver, tm.name as terminal,
       (select coalesce(sum(litres), 0) from liftings l where l.run_id = r.id) as loaded_l,
       (select coalesce(sum(litres), 0) from deliveries dv where dv.run_id = r.id) as delivered_l,
       (select count(*) from deliveries dv where dv.run_id = r.id) as drops,
       (select count(*) from orders o where o.run_id = r.id and o.status = 'planned') as drops_left
     from runs r join trucks tr on tr.id = r.truck_id join drivers d on d.id = r.driver_id join terminals tm on tm.id = r.terminal_id
     where r.run_on > current_date - $1::int order by r.run_on desc, r.ref desc`,
    [days],
  );
  const text =
    heading(`Runs in the last ${days} days and ahead (${rows.length})`) +
    '\n' +
    table(rows, [
      { key: 'ref', label: 'run' },
      { key: 'run_on', label: 'date', format: (v) => isoDate(v) },
      { key: 'rego', label: 'tanker' },
      { key: 'driver', label: 'driver' },
      { key: 'terminal', label: 'terminal', width: 24 },
      { key: 'drops', label: 'drops', align: 'right', format: (v, r) => `${v}${num(r.drops_left) ? ` +${r.drops_left} to go` : ''}` },
      { key: 'loaded_l', label: 'loaded', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
      { key: 'delivered_l', label: 'delivered', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
      { key: 'status', label: 'status' },
    ]);
  return { json: rows, text };
}

async function cmdRun(db, args) {
  const r = await resolve(db, 'run', args.join(' '));
  const drops = await db.query(
    `select o.ref, c.name || ' / ' || s.name || ' / ' || t.tank_no as tank, p.code as product, o.planned_litres, o.status, s.access_notes,
       (select dv.litres from deliveries dv where dv.order_id = o.id limit 1) as delivered
     from orders o join tanks t on t.id = o.tank_id join sites s on s.id = t.site_id join customers c on c.id = s.customer_id join products p on p.id = t.product_id
     where o.run_id = $1 order by o.ref`,
    [r.id],
  );
  const lifts = await db.query('select p.code as product, l.litres, l.bol_ref, l.lifted_on from liftings l join products p on p.id = l.product_id where l.run_id = $1 order by p.code', [r.id]);
  const recon = await db.query('select * from v_reconcile where run_id = $1 order by product', [r.id]);
  const dels = await db.query('select * from v_deliveries where run_ref = $1 order by ref', [r.ref]);
  let text = heading(`${r.ref}: ${isoDate(r.run_on)}, ${r.rego} with ${r.driver}, lifting at ${r.terminal} (${r.status})`);
  text += '\n\nThe run sheet\n' + table(drops, [{ key: 'ref', label: 'order' }, { key: 'tank', label: 'tank', width: 44 }, { key: 'product', label: 'product' }, { key: 'planned_litres', label: 'planned', align: 'right' }, { key: 'delivered', label: 'delivered', align: 'right', format: (v) => v || '' }, { key: 'status', label: 'status' }, { key: 'access_notes', label: 'access', width: 40, format: (v) => v || '' }]);
  text += '\n\nLifted at the terminal\n' + table(lifts, [{ key: 'product', label: 'product' }, { key: 'litres', label: 'litres', align: 'right' }, { key: 'bol_ref', label: 'bill of lading', format: (v) => v || 'MISSING' }, { key: 'lifted_on', label: 'date', format: (v) => isoDate(v) }]);
  if (dels.length) text += '\n\nDelivered\n' + table(dels, DELIVERY_COLS.filter((c) => c.key !== 'run_ref'));
  text += '\n\nLoaded against delivered\n' + table(recon, RECON_COLS);
  if (r.variance_note) text += `\n  Variance note: ${r.variance_note}`;
  return { json: { run: r, drops, liftings: lifts, deliveries: dels, reconcile: recon }, text };
}

const RECON_COLS = [
  { key: 'run_ref', label: 'run' },
  { key: 'run_on', label: 'date', format: (v) => isoDate(v) },
  { key: 'rego', label: 'tanker' },
  { key: 'driver', label: 'driver' },
  { key: 'product', label: 'product' },
  { key: 'loaded_l', label: 'loaded', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
  { key: 'delivered_l', label: 'delivered', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
  { key: 'variance_l', label: 'left over', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') },
  { key: 'variance_pct', label: '%', align: 'right', format: (v, r) => (v === null ? '' : `${num(v).toFixed(2)}${r.status === 'completed' && Math.abs(num(v)) > VARIANCE_LIMIT && !r.variance_note ? ' !' : ''}`) },
  { key: 'liftings_without_bol', label: 'no BOL', align: 'right', format: (v) => (num(v) ? v : '') },
];

async function cmdReconcile(db, args, flags) {
  if (args.length) {
    const r = await resolve(db, 'run', args.join(' '));
    const rows = await db.query('select * from v_reconcile where run_id = $1 order by product', [r.id]);
    return { json: rows, text: heading(`${r.ref}: loaded against delivered`) + '\n' + table(rows, RECON_COLS) };
  }
  const days = flags.days ? Number(flags.days) : 30;
  const rows = await db.query("select * from v_reconcile where status = 'completed' and run_on > current_date - $1::int order by run_on desc, product", [days]);
  const byTruck = await db.query(
    `select rego, product, sum(loaded_l) as loaded_l, sum(delivered_l) as delivered_l, sum(variance_l) as variance_l,
       round(100.0 * sum(variance_l) / nullif(sum(loaded_l), 0), 3) as variance_pct, count(*) as runs
     from v_reconcile where status = 'completed' and run_on > current_date - $1::int group by rego, product order by rego, product`,
    [days],
  );
  const flagged = rows.filter((r) => Math.abs(num(r.variance_pct)) > VARIANCE_LIMIT && !r.variance_note);
  let text = heading(`Stock reconciliation, last ${days} days`);
  text += '\n\nBy tanker and product\n' + table(byTruck, [{ key: 'rego', label: 'tanker' }, { key: 'product', label: 'product' }, { key: 'runs', label: 'runs', align: 'right' }, { key: 'loaded_l', label: 'loaded', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }, { key: 'delivered_l', label: 'delivered', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }, { key: 'variance_l', label: 'lost', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }, { key: 'variance_pct', label: '%', align: 'right' }]);
  text += `\n\nRuns past the ${VARIANCE_LIMIT}% limit with no explanation (${flagged.length})\n` + table(flagged, RECON_COLS);
  text += '\n\nExplain one with: complete <run> --note="..." (a meter fault, a retain left on board, a temperature swing).';
  return { json: { by_truck: byTruck, runs: rows, flagged }, text };
}

async function cmdPrices(db, args, flags) {
  const on = parseDate(flags.on) || today();
  const tgp = await db.query(
    `select distinct on (tm.id, p.id) tm.name as terminal, p.code as product, tp.effective_on, tp.tgp_cpl,
       (select x.tgp_cpl from terminal_prices x where x.terminal_id = tm.id and x.product_id = p.id and x.effective_on < tp.effective_on order by x.effective_on desc limit 1) as prev_cpl
     from terminal_prices tp join terminals tm on tm.id = tp.terminal_id join products p on p.id = tp.product_id
     where tp.effective_on <= $1 order by tm.id, p.id, tp.effective_on desc`,
    [on],
  );
  const cust = await db.query(
    `select c.name as customer, c.margin_cpl, tm.name as terminal, p.code as product,
       (select tp.tgp_cpl from terminal_prices tp where tp.terminal_id = tm.id and tp.product_id = p.id and tp.effective_on <= $1 order by tp.effective_on desc limit 1) as tgp_cpl
     from customers c join terminals tm on tm.id = c.home_terminal_id
     join (select distinct s.customer_id, t.product_id from tanks t join sites s on s.id = t.site_id where t.status = 'active') ct on ct.customer_id = c.id
     join products p on p.id = ct.product_id where c.status <> 'closed' order by c.name, p.code`,
    [on],
  );
  for (const r of cust) r.price_cpl = r.tgp_cpl === null ? null : Math.round((num(r.tgp_cpl) + num(r.margin_cpl)) * 100) / 100;
  const gst = Number(await setting(db, 'gst_rate', '0.15'));
  let text = heading(`Terminal gate prices on ${on} (cents a litre, ex GST)`);
  text += '\n' + table(tgp, [{ key: 'terminal', label: 'terminal' }, { key: 'product', label: 'product' }, { key: 'tgp_cpl', label: 'TGP', align: 'right', format: (v) => num(v).toFixed(2) }, { key: 'prev_cpl', label: 'move', align: 'right', format: (v, r) => (v === null ? '' : (num(r.tgp_cpl) - num(v) >= 0 ? '+' : '') + (num(r.tgp_cpl) - num(v)).toFixed(2)) }, { key: 'effective_on', label: 'posted', format: (v) => `${isoDate(v)}${isoDate(v) < on ? ' STALE' : ''}` }]);
  text += `\n\nWhat each customer pays (TGP plus margin; GST of ${(gst * 100).toFixed(0)}% goes on top)\n` + table(cust, [{ key: 'customer', label: 'customer', width: 26 }, { key: 'product', label: 'product' }, { key: 'terminal', label: 'terminal', width: 24 }, { key: 'tgp_cpl', label: 'TGP', align: 'right', format: (v) => (v === null ? 'none' : num(v).toFixed(2)) }, { key: 'margin_cpl', label: 'margin', align: 'right', format: (v) => num(v).toFixed(2) }, { key: 'price_cpl', label: 'price', align: 'right', format: (v) => (v === null ? '' : num(v).toFixed(2)) }, { key: 'price_cpl', label: 'incl GST', align: 'right', format: (v) => (v === null ? '' : (num(v) * (1 + gst)).toFixed(2)) }]);
  return { json: { on, terminal_gate_prices: tgp, customer_prices: cust }, text };
}

async function cmdMargin(db, args, flags) {
  const days = flags.days ? Number(flags.days) : 30;
  const rows = await db.query(
    `select customer, count(*) as drops, sum(litres) as litres, round(avg(litres)) as avg_drop,
       round(sum(margin) * 100.0 / nullif(sum(litres), 0), 2) as margin_cpl, sum(margin) as margin, round(sum(margin) / count(*), 2) as margin_per_drop
     from v_deliveries where delivered_on > current_date - $1::int group by customer order by margin_per_drop`,
    [days],
  );
  const total = rows.reduce((a, r) => ({ litres: a.litres + num(r.litres), margin: a.margin + num(r.margin), drops: a.drops + num(r.drops) }), { litres: 0, margin: 0, drops: 0 });
  let text = heading(`Margin by customer, last ${days} days (smallest margin per drop first)`);
  text += '\n' + table(rows, [{ key: 'customer', label: 'customer', width: 26 }, { key: 'drops', label: 'drops', align: 'right' }, { key: 'litres', label: 'litres', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }, { key: 'avg_drop', label: 'avg drop', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }, { key: 'margin_cpl', label: 'c/L', align: 'right' }, { key: 'margin', label: 'margin', align: 'right', format: (v) => money(v) }, { key: 'margin_per_drop', label: 'per drop', align: 'right', format: (v) => money(v) }]);
  text += `\n\n  ${total.drops} drops, ${litres(total.litres)}, ${money(total.margin)} margin over the terminal gate price.`;
  text += '\n  A drop costs a truck, a driver and an hour whatever its size. The top of this list is where small drops eat the margin.';
  return { json: { days, customers: rows, total }, text };
}

async function cmdUsage(db, args, flags) {
  const rows = await db.query(
    `with recent as (select tank_id, sum(used_l)::numeric / nullif(sum(days), 0) as per_day from v_tank_use where dipped_on > current_date - 14 and used_l >= 0 group by tank_id),
     prior as (select tank_id, sum(used_l)::numeric / nullif(sum(days), 0) as per_day from v_tank_use where dipped_on <= current_date - 14 and dipped_on > current_date - 60 and used_l >= 0 group by tank_id),
     fills as (select tank_id, count(*) as fills from deliveries where delivered_on > current_date - 28 group by tank_id)
     select v.tank_id, v.customer || ' / ' || v.site || ' / ' || v.tank_no as label, v.product, v.capacity_l,
       round(r.per_day) as recent_per_day, round(p.per_day) as prior_per_day,
       case when p.per_day > 0 then round(100.0 * (r.per_day - p.per_day) / p.per_day) end as change_pct,
       coalesce(f.fills, 0) as fills_28d,
       round(coalesce(r.per_day, p.per_day, 0) * 7) as litres_week
     from v_tanks v left join recent r on r.tank_id = v.tank_id left join prior p on p.tank_id = v.tank_id left join fills f on f.tank_id = v.tank_id
     where v.status = 'active' order by abs(coalesce(round(100.0 * (r.per_day - p.per_day) / nullif(p.per_day, 0)), 0)) desc`,
  );
  for (const r of rows) {
    const flagsOut = [];
    if (r.change_pct !== null && num(r.change_pct) >= 25) flagsOut.push('USING MORE: leak, theft or a new machine?');
    if (r.change_pct !== null && num(r.change_pct) <= -40) flagsOut.push('using much less: lost the work, or a second supplier?');
    if (num(r.fills_28d) >= 3) flagsOut.push(`filled ${r.fills_28d} times in 4 weeks: a bigger tank, or a second one, cuts the drops`);
    r.read = flagsOut.join('; ');
  }
  const text =
    heading('Usage: the last 14 days against the 45 days before') +
    '\n' +
    table(rows, [{ key: 'label', label: 'tank', width: 46 }, { key: 'product', label: 'product' }, { key: 'prior_per_day', label: 'was L/day', align: 'right', format: (v) => v ?? '?' }, { key: 'recent_per_day', label: 'now L/day', align: 'right', format: (v) => v ?? '?' }, { key: 'change_pct', label: 'change', align: 'right', format: (v) => (v === null ? '' : `${num(v) > 0 ? '+' : ''}${v}%`) }, { key: 'fills_28d', label: 'fills 4wk', align: 'right' }, { key: 'read', label: 'read', width: 70 }]);
  return { json: rows, text };
}

async function cmdDebtors(db) {
  const rows = await db.query("select * from v_debtors where owed_ex_gst > 0 order by overdue_ex_gst desc, owed_ex_gst desc");
  const gst = Number(await setting(db, 'gst_rate', '0.15'));
  const text =
    heading('Who owes what') +
    '\n' +
    table(rows, [{ key: 'customer', label: 'customer', width: 26 }, { key: 'owed_ex_gst', label: 'owed ex GST', align: 'right', format: (v) => money(v) }, { key: 'owed_ex_gst', label: 'incl GST', align: 'right', format: (v) => money(num(v) * (1 + gst)) }, { key: 'overdue_ex_gst', label: 'overdue', align: 'right', format: (v) => (num(v) ? money(v) : '') }, { key: 'over_30_ex_gst', label: '30+ late', align: 'right', format: (v) => (num(v) ? money(v) : '') }, { key: 'oldest_overdue_days', label: 'oldest', align: 'right', format: (v) => (num(v) ? `${v}d` : '') }, { key: 'credit_limit', label: 'limit', align: 'right', format: (v, r) => (v === null ? '' : `${money(v)}${num(r.owed_ex_gst) > num(v) ? ' OVER' : ''}`) }, { key: 'status', label: 'status' }]) +
    '\n\nPut a customer on hold with: hold <customer>. Deliveries to a held customer are refused.';
  return { json: rows, text };
}

async function cmdDeliveries(db, args, flags) {
  const days = flags.days ? Number(flags.days) : 7;
  const params = [days];
  let where = 'where delivered_on > current_date - $1::int';
  if (args.length) {
    const c = await resolve(db, 'customer', args.join(' '));
    params.push(c.id);
    where += ` and customer_id = $${params.length}`;
  }
  if (flags.unpaid) where += ' and paid_on is null';
  const rows = await db.query(`select * from v_deliveries ${where} order by delivered_on desc, ref desc`, params);
  return { json: rows, text: heading(`Deliveries, last ${days} days (${rows.length})`) + '\n' + table(rows, DELIVERY_COLS) };
}

async function cmdDrivers(db) {
  const rows = await db.query("select d.*, (select max(run_on) from runs r where r.driver_id = d.id) as last_run from drivers d order by d.status, d.name");
  return {
    json: rows,
    text: heading('Drivers') + '\n' + table(rows, [{ key: 'name', label: 'driver' }, { key: 'licence_class', label: 'licence' }, { key: 'dg_endorsement_expires_on', label: 'DG endorsement', format: (v) => (!v ? 'NONE' : `${isoDate(v)}${isoDate(v) < today() ? ' EXPIRED' : isoDate(v) < addDays(today(), 30) ? ' due soon' : ''}`) }, { key: 'last_run', label: 'last run', format: (v) => isoDate(v) }, { key: 'status', label: 'status' }]),
  };
}

async function cmdTrucks(db) {
  const rows = await db.query(
    "select tr.*, (select string_agg(capacity_l::text, ' + ' order by comp_no) from compartments c where c.truck_id = tr.id) as comps, (select sum(capacity_l) from compartments c where c.truck_id = tr.id) as total_l from trucks tr order by tr.rego",
  );
  const flag = (v) => (!v ? 'NONE' : `${isoDate(v)}${isoDate(v) < today() ? ' LAPSED' : isoDate(v) < addDays(today(), 30) ? ' due soon' : ''}`);
  return {
    json: rows,
    text: heading('Tankers') + '\n' + table(rows, [{ key: 'rego', label: 'rego' }, { key: 'name', label: 'name' }, { key: 'comps', label: 'compartments (L)' }, { key: 'total_l', label: 'total', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }, { key: 'dg_vehicle_expires_on', label: 'vehicle cert', format: flag }, { key: 'meter_certified_until', label: 'meter cert', format: flag }, { key: 'status', label: 'status' }]),
  };
}

const ATTENTION_ORDER = ['runout', 'certificate_expired', 'driver_dg_expired', 'truck_expired', 'water', 'order_late', 'variance', 'debtor', 'dip_stale', 'no_price'];
const ATTENTION_LABEL = {
  runout: 'Runs dry soon, nothing on order',
  certificate_expired: 'Tank certificate lapsed',
  driver_dg_expired: 'Driver DG endorsement lapsed',
  truck_expired: 'Tanker certificate lapsed',
  water: 'Water in the tank',
  order_late: 'Order past its date',
  variance: 'Stock lost on a run',
  debtor: 'Account overdue or over limit',
  dip_stale: 'Keep-full tank not dipped',
  no_price: 'No terminal price today',
};

async function cmdAttention(db) {
  const rows = await db.query('select * from v_attention');
  rows.sort((a, b) => ATTENTION_ORDER.indexOf(a.reason) - ATTENTION_ORDER.indexOf(b.reason) || num(a.days) - num(b.days));
  const text =
    heading(`Needs a decision (${rows.length})`) +
    '\n' +
    table(rows, [
      { key: 'reason', label: 'what', format: (v) => ATTENTION_LABEL[v] || v },
      { key: 'label', label: 'record', width: 48 },
      { key: 'detail', label: 'detail', width: 90 },
    ]) +
    '\n\nWorst first: a customer about to run dry, then what makes a delivery illegal, then fuel quality, then stock and money.';
  return { json: rows, text };
}

async function cmdWeek(db) {
  const byProduct = await db.query("select product, count(*) as drops, sum(litres) as litres, sum(value_ex_gst) as value, sum(margin) as margin from v_deliveries where delivered_on > current_date - 7 group by product order by sum(litres) desc");
  const [runs] = await db.query("select count(*) as runs, count(*) filter (where status = 'completed') as completed from runs where run_on > current_date - 7 and run_on <= current_date");
  const [recon] = await db.query("select coalesce(sum(variance_l), 0) as lost_l, coalesce(sum(loaded_l), 0) as loaded_l from v_reconcile where status = 'completed' and run_on > current_date - 7");
  const [tanks] = await db.query("select count(*) as tanks, count(*) filter (where days_to_reorder <= 2) as due, count(*) filter (where days_to_empty <= 3 and not on_order) as at_risk from v_runout");
  const [orders] = await db.query("select count(*) filter (where status = 'open') as open, count(*) filter (where status in ('open', 'planned') and required_on < current_date) as late from orders");
  const [money_] = await db.query('select coalesce(sum(owed_ex_gst), 0) as owed, coalesce(sum(overdue_ex_gst), 0) as overdue from v_debtors');
  const [att] = await db.query('select count(*) as n from v_attention');
  const tot = byProduct.reduce((a, r) => ({ drops: a.drops + num(r.drops), litres: a.litres + num(r.litres), value: a.value + num(r.value), margin: a.margin + num(r.margin) }), { drops: 0, litres: 0, value: 0, margin: 0 });
  const json = { delivered: { ...tot, by_product: byProduct }, runs, reconcile: recon, tanks, orders, accounts: money_, attention: num(att.n) };
  let text = heading('The last seven days');
  text += `\n  Delivered:  ${tot.drops} drops, ${litres(tot.litres)}, ${money(tot.value)} ex GST, ${money(tot.margin)} margin`;
  text += `\n  Runs:       ${runs.runs} runs, ${runs.completed} completed; ${litres(recon.lost_l)} left between terminal and tank (${num(recon.loaded_l) ? ((100 * num(recon.lost_l)) / num(recon.loaded_l)).toFixed(2) : '0.00'}%)`;
  text += `\n  Tanks:      ${tanks.tanks} watched, ${tanks.due} at reorder within two days, ${tanks.at_risk} could run dry with nothing on order`;
  text += `\n  Orders:     ${orders.open} open, ${orders.late} late`;
  text += `\n  Accounts:   ${money(money_.owed)} owed ex GST, ${money(money_.overdue)} overdue`;
  text += `\n  Attention:  ${att.n} items (attention)`;
  text += '\n\nBy product\n' + table(byProduct, [{ key: 'product', label: 'product' }, { key: 'drops', label: 'drops', align: 'right' }, { key: 'litres', label: 'litres', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }, { key: 'value', label: 'ex GST', align: 'right', format: (v) => money(v) }, { key: 'margin', label: 'margin', align: 'right', format: (v) => money(v) }]);
  return { json, text };
}

const TABLES = ['settings', 'products', 'terminals', 'terminal_prices', 'customers', 'sites', 'tanks', 'dips', 'drivers', 'trucks', 'compartments', 'runs', 'orders', 'liftings', 'deliveries', 'notes'];

async function cmdStats(db) {
  const out = {};
  for (const t of TABLES) out[t] = num((await db.query(`select count(*) as n from ${t}`))[0].n);
  return { json: out, text: heading('Records') + '\n' + Object.entries(out).map(([k, v]) => `  ${k.padEnd(16)} ${v}`).join('\n') };
}

// ---------------------------------------------------------------------------
// Writes: tanks and orders

async function cmdDip(db, args, flags) {
  const t = await resolve(db, 'tank', args.join(' '));
  const l = Math.round(Number(need(flags, 'litres', 'what the dip reads, in litres')));
  if (!Number.isFinite(l) || l < 0) throw new CliError('--litres must be zero or more.');
  if (l > t.capacity_l) throw new CliError(`${l} L is more than the ${t.capacity_l} L tank holds. Check the dip chart.`);
  const water = flags.water ? Math.round(Number(flags.water)) : 0;
  const on = parseDate(flags.on) || today();
  const source = str(flags.source) || 'customer';
  if (!['customer', 'driver', 'telemetry', 'office'].includes(source)) throw new CliError('--source is customer, driver, telemetry or office.');
  await db.query('insert into dips (tank_id, dipped_on, litres, water_mm, source, by_name) values ($1, $2, $3, $4, $5, $6)', [t.id, on, l, water, source, str(flags.by) || null]);
  const [v] = await db.query('select * from v_runout where tank_id = $1', [t.id]);
  let text = `Dip recorded: ${t.label}, ${litres(l)} on ${on}${water ? `, ${water} mm of water` : ''}.`;
  text += `\n  Using about ${litres(v.use_per_day)} a day: ${v.days_to_reorder !== null && num(v.days_to_reorder) <= 0 ? 'at reorder now' : `reorder in ${v.days_to_reorder ?? '?'} days`}, empty in ${v.days_to_empty ?? '?'} days.${v.on_order ? ' Already on order.' : ''}`;
  if (water > 10) text += '\n  WATER: more than 10 mm. Do not deliver on top of it until the tank is drained or checked. It is on the attention list.';
  return { json: { tank: t.label, dip: { on, litres: l, water_mm: water }, forecast: v }, text };
}

async function cmdOrder(db, args, flags) {
  if (args[0] === 'cancel') {
    const o = await resolve(db, 'order', args.slice(1).join(' '));
    if (o.status === 'delivered') throw new CliError(`${o.ref} is already delivered.`);
    await db.query("update orders set status = 'cancelled', run_id = null, planned_litres = null where id = $1", [o.id]);
    if (flags.note) await note(db, 'order', o.id, o.ref, `Cancelled: ${str(flags.note)}`);
    return { json: { ref: o.ref, status: 'cancelled' }, text: `${o.ref} cancelled.` };
  }
  const t = await resolve(db, 'tank', args.join(' '));
  if (t.status !== 'active') throw new CliError(`${t.label} is ${t.status}.`);
  const req = flags.litres ? wholeLitres(flags.litres) : null;
  const safe = Math.floor((t.capacity_l * t.safe_fill_pct) / 100);
  if (req && req > safe) throw new CliError(`${req} L will not fit: the tank's safe fill is ${safe} L.`);
  const on = parseDate(flags.required) || addDays(today(), 1);
  const ref = await nextRef(db, 'ORD', 'orders', 7000);
  await db.query('insert into orders (ref, tank_id, litres_requested, required_on, source, po_number) values ($1, $2, $3, $4, $5, $6)', [ref, t.id, req, on, str(flags.source) || 'phone', str(flags.po) || null]);
  let text = `${ref}: ${req ? litres(req) : 'a fill'} of ${t.product} for ${t.label}, required ${on}.`;
  if (t.customer_status !== 'active') text += `\n  ${t.customer} is ${t.customer_status.toUpperCase()}: plan-run will skip it and deliver will refuse it until the account is cleared.`;
  if (t.certificate_required && (!t.certificate_expires_on || isoDate(t.certificate_expires_on) < on)) text += `\n  The tank certificate ${t.certificate_expires_on ? `lapses ${isoDate(t.certificate_expires_on)}` : 'is not on file'}: delivery will be refused until it is recorded (cert <tank> --ref= --expires=).`;
  return { json: { ref, tank: t.label, litres_requested: req, required_on: on }, text };
}

async function cmdCert(db, args, flags) {
  const t = await resolve(db, 'tank', args.join(' '));
  const ref = need(flags, 'ref', 'the certificate number');
  const exp = parseDate(need(flags, 'expires', 'YYYY-MM-DD'));
  await db.query('update tanks set certificate_ref = $1, certificate_expires_on = $2, certificate_required = true where id = $3', [ref, exp, t.id]);
  return { json: { tank: t.label, certificate_ref: ref, expires: exp }, text: `${t.label}: certificate ${ref} recorded, expires ${exp}.` };
}

// ---------------------------------------------------------------------------
// Writes: runs

async function legalToRun(db, truck, driver, on) {
  const problems = [];
  if (!driver.dg_endorsement_expires_on || isoDate(driver.dg_endorsement_expires_on) < on) problems.push(`${driver.name}'s dangerous goods endorsement ${driver.dg_endorsement_expires_on ? `lapsed ${isoDate(driver.dg_endorsement_expires_on)}` : 'is not on file'}`);
  if (driver.status !== 'active') problems.push(`${driver.name} is marked ${driver.status}`);
  if (!truck.dg_vehicle_expires_on || isoDate(truck.dg_vehicle_expires_on) < on) problems.push(`${truck.rego}'s vehicle certificate ${truck.dg_vehicle_expires_on ? `lapsed ${isoDate(truck.dg_vehicle_expires_on)}` : 'is not on file'}`);
  if (!truck.meter_certified_until || isoDate(truck.meter_certified_until) < on) problems.push(`${truck.rego}'s meter certification ${truck.meter_certified_until ? `lapsed ${isoDate(truck.meter_certified_until)}` : 'is not on file'}`);
  if (truck.status !== 'active') problems.push(`${truck.rego} is ${truck.status}`);
  return problems;
}

function accountFlag(d) {
  if (!d) return '';
  const out = [];
  if (d.credit_limit !== null && num(d.owed_ex_gst) > num(d.credit_limit)) out.push(`OVER LIMIT (${money(d.owed_ex_gst)} of ${money(d.credit_limit)})`);
  if (num(d.over_30_ex_gst) > 0) out.push(`${money(d.over_30_ex_gst)} 30+ days late`);
  return out.join(', ');
}

// Put a drop on the truck: same-product compartments first, then empty ones. Returns litres placed.
function stow(comps, product, want) {
  let left = want;
  for (const c of comps) {
    if (left <= 0) break;
    if (c.product !== product) continue;
    const take = Math.min(c.capacity_l - c.used, left);
    c.used += take;
    left -= take;
  }
  for (const c of comps) {
    if (left <= 0) break;
    if (c.product) continue;
    c.product = product;
    const take = Math.min(c.capacity_l, left);
    c.used += take;
    left -= take;
  }
  return want - left;
}

async function cmdPlanRun(db, args, flags) {
  const on = parseDate(flags.on) || addDays(today(), 1);
  const truck = await resolve(db, 'truck', need(flags, 'truck', 'a rego'));
  const driver = await resolve(db, 'driver', need(flags, 'driver', 'a name'));
  const problems = await legalToRun(db, truck, driver, on);
  if (problems.length) throw new CliError(`Cannot plan a run on ${on}:\n  - ${problems.join('\n  - ')}\nNo force flag. Fix the record (endorse, truck-cert) or pick another driver or tanker.`);
  const terminal = flags.terminal ? await resolve(db, 'terminal', flags.terminal) : null;
  const ahead = Math.max(0, daysBetween(today(), on));
  const region = str(flags.region);

  // Candidates: open orders due by the run date, then keep-full tanks that reach reorder by the day after.
  const orders = await db.query(
    `select o.id as order_id, o.ref, o.litres_requested, o.required_on, v.*, v.customer || ' / ' || v.site || ' / ' || v.tank_no as label
     from orders o join v_runout v on v.tank_id = o.tank_id
     where o.status = 'open' and o.run_id is null and o.required_on <= $1 ${region ? 'and v.region ilike $2' : ''}
     order by o.required_on, v.days_to_empty nulls first`,
    region ? [on, `%${region}%`] : [on],
  );
  const keepFull = await db.query(
    `select null::uuid as order_id, null as ref, null::int as litres_requested, null::date as required_on, v.*, v.customer || ' / ' || v.site || ' / ' || v.tank_no as label
     from v_runout v where v.keep_full and not v.on_order and v.days_to_reorder is not null and v.days_to_reorder <= $1 ${region ? 'and v.region ilike $2' : ''}
     order by v.days_to_empty`,
    region ? [ahead + 1, `%${region}%`] : [ahead + 1],
  );
  const comps = (await db.query('select comp_no, capacity_l from compartments where truck_id = $1 order by capacity_l desc', [truck.id])).map((c) => ({ ...c, product: null, used: 0 }));
  const drops = [];
  const skipped = [];
  // Late orders first, then whoever runs dry soonest, whether they ordered or we watch the tank.
  const late = (c) => c.ref && isoDate(c.required_on) < today();
  const candidates = [...orders, ...keepFull].sort((a, b) => Number(late(b)) - Number(late(a)) || num(a.days_to_empty ?? -1) - num(b.days_to_empty ?? -1));
  const accounts = Object.fromEntries((await db.query('select * from v_debtors')).map((d) => [d.customer_id, d]));
  for (const c of candidates) {
    const label = c.label;
    if (c.customer_status !== 'active') { skipped.push({ label, why: `customer ${c.customer_status}` }); continue; }
    if (c.certificate_required && (!c.certificate_expires_on || isoDate(c.certificate_expires_on) < on)) { skipped.push({ label, why: c.certificate_expires_on ? `tank certificate lapsed ${isoDate(c.certificate_expires_on)}` : 'no tank certificate on file' }); continue; }
    if (num(c.water_mm) > 10) { skipped.push({ label, why: `${c.water_mm} mm of water on the last dip` }); continue; }
    const levelOnDay = Math.max(0, num(c.est_l) - num(c.use_per_day) * ahead);
    const room = Math.floor((num(c.safe_fill_l) - levelOnDay) / 100) * 100;
    let want = c.litres_requested ? Math.min(num(c.litres_requested), room) : room;
    if (want < 500) { skipped.push({ label, why: `only ${Math.max(0, room)} L of room by ${on}` }); continue; }
    const placed = Math.floor(stow(comps, c.product, want) / 100) * 100;
    if (placed < 500) { skipped.push({ label, why: 'no room left on the tanker' }); continue; }
    drops.push({ order_id: c.order_id, ref: c.ref, tank_id: c.tank_id, label, product: c.product, litres: placed, why: (c.ref ? `order ${c.ref}${late(c) ? ' (LATE)' : ''}` : num(c.days_to_reorder) <= 0 ? 'keep full: at reorder now' : `keep full: reorder in ${c.days_to_reorder} days`) + `, empty in ${c.days_to_empty ?? '?'}d`, account: accountFlag(accounts[c.customer_id]) });
  }
  const loading = comps.slice().sort((a, b) => a.comp_no - b.comp_no).map((c) => ({ comp_no: c.comp_no, capacity_l: c.capacity_l, product: c.product || 'empty', litres: c.used }));
  const homeTerminal = terminal || (drops.length ? (await db.query('select tm.* from terminals tm join customers c on c.home_terminal_id = tm.id join sites s on s.customer_id = c.id join tanks t on t.site_id = s.id where t.id = $1', [drops[0].tank_id]))[0] : null);
  const liftAt = homeTerminal || (await db.query('select * from terminals order by name limit 1'))[0];
  if (!liftAt) throw new CliError('No terminals yet. Add one: add terminal "<name>".');

  let ref = null;
  if (!flags['dry-run'] && drops.length) {
    ref = await nextRef(db, 'RUN', 'runs', 4000);
    const [run] = await db.query('insert into runs (ref, run_on, truck_id, driver_id, terminal_id) values ($1, $2, $3, $4, $5) returning id', [ref, on, truck.id, driver.id, liftAt.id]);
    for (const d of drops) {
      if (d.order_id) {
        await db.query("update orders set run_id = $1, planned_litres = $2, status = 'planned' where id = $3", [run.id, d.litres, d.order_id]);
      } else {
        d.ref = await nextRef(db, 'ORD', 'orders', 7000);
        await db.query("insert into orders (ref, tank_id, required_on, source, run_id, planned_litres, status) values ($1, $2, $3, 'keep_full', $4, $5, 'planned')", [d.ref, d.tank_id, on, run.id, d.litres]);
      }
    }
  }
  const lift = Object.values(drops.reduce((a, d) => ((a[d.product] = { product: d.product, litres: (a[d.product]?.litres || 0) + d.litres }), a), {}));
  let text = heading(`${flags['dry-run'] ? 'Draft run' : ref || 'Nothing planned'}: ${on}, ${truck.rego} with ${driver.name}, lifting at ${liftAt.name}`);
  text += '\n\nDrops (late orders first, then by days to empty)\n' + table(drops, [{ key: 'ref', label: 'order', format: (v) => v || 'new' }, { key: 'label', label: 'tank', width: 46 }, { key: 'product', label: 'product' }, { key: 'litres', label: 'litres', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }, { key: 'why', label: 'why' }, { key: 'account', label: 'account' }]);
  if (drops.some((d) => d.account)) text += '\n  An account flag does not stop the run. Put the customer on hold (hold <customer>) if it should.';
  text += '\n\nLift at the terminal\n' + table(lift, [{ key: 'product', label: 'product' }, { key: 'litres', label: 'litres', align: 'right', format: (v) => num(v).toLocaleString('en-NZ') }]);
  text += '\n\nCompartments\n' + table(loading, [{ key: 'comp_no', label: 'comp' }, { key: 'capacity_l', label: 'holds', align: 'right' }, { key: 'product', label: 'product' }, { key: 'litres', label: 'load', align: 'right' }]);
  if (skipped.length) text += '\n\nLeft off\n' + table(skipped, [{ key: 'label', label: 'tank', width: 46 }, { key: 'why', label: 'why' }]);
  if (flags['dry-run']) text += '\n\nDry run: nothing written. Run again without --dry-run to book it.';
  else if (ref) text += `\n\nBooked. At the terminal: load ${ref} --product= --litres= --bol=. At each tank: deliver <order> --litres= --docket=.`;
  return { json: { ref, on, truck: truck.rego, driver: driver.name, terminal: liftAt.name, drops, lift, compartments: loading, skipped, dry_run: Boolean(flags['dry-run']) }, text };
}

async function cmdLoad(db, args, flags) {
  const r = await resolve(db, 'run', args.join(' '));
  if (['completed', 'cancelled'].includes(r.status)) throw new CliError(`${r.ref} is ${r.status}.`);
  const p = await resolve(db, 'product', need(flags, 'product', 'DSL, ULP91, PULP95'));
  const l = wholeLitres(need(flags, 'litres', 'litres lifted, from the bill of lading'));
  const bol = need(flags, 'bol', 'the bill of lading number: it is the dangerous goods transport document');
  await db.query('insert into liftings (run_id, product_id, litres, bol_ref, lifted_on) values ($1, $2, $3, $4, $5)', [r.id, p.id, l, bol, parseDate(flags.on) || isoDate(r.run_on)]);
  await db.query("update runs set status = 'loaded' where id = $1", [r.id]);
  return { json: { run: r.ref, product: p.code, litres: l, bol }, text: `${r.ref}: lifted ${litres(l)} ${p.code} at ${r.terminal} on bill of lading ${bol}.` };
}

async function cmdDeliver(db, args, flags) {
  const o = await resolve(db, 'order', args.join(' '));
  if (o.status === 'delivered') throw new CliError(`${o.ref} is already delivered.`);
  if (o.status === 'cancelled') throw new CliError(`${o.ref} was cancelled.`);
  if (!o.run_id) throw new CliError(`${o.ref} is not on a run. Plan one first: plan-run --on= --truck= --driver=.`);
  const t = await resolve(db, 'tank', o.tank_id);
  const [r] = await db.query('select r.*, tr.rego, tr.dg_vehicle_expires_on, tr.meter_certified_until, tr.status as truck_status, d.name as driver, d.dg_endorsement_expires_on, d.status as driver_status from runs r join trucks tr on tr.id = r.truck_id join drivers d on d.id = r.driver_id where r.id = $1', [o.run_id]);
  const on = parseDate(flags.on) || today();
  const l = wholeLitres(need(flags, 'litres', 'litres off the meter'));
  const docket = need(flags, 'docket', 'the delivery docket number');
  const refusals = [];
  if (o.customer_status !== 'active') refusals.push(`${o.customer} is ${o.customer_status.toUpperCase()}`);
  if (t.certificate_required && (!t.certificate_expires_on || isoDate(t.certificate_expires_on) < on)) refusals.push(`the tank certificate ${t.certificate_expires_on ? `lapsed ${isoDate(t.certificate_expires_on)}` : 'is not on file'}`);
  refusals.push(...(await legalToRun(db, { rego: r.rego, dg_vehicle_expires_on: r.dg_vehicle_expires_on, meter_certified_until: r.meter_certified_until, status: r.truck_status }, { name: r.driver, dg_endorsement_expires_on: r.dg_endorsement_expires_on, status: r.driver_status }, on)));
  const [v] = await db.query('select * from v_runout where tank_id = $1', [t.id]);
  // No --before: the forecast level on the delivery day (today's estimate, less the days of use until then).
  const before = flags.before !== undefined ? Math.round(Number(flags.before)) : v.est_l === null ? null : Math.max(0, Math.round(num(v.est_l) - num(v.use_per_day) * Math.max(0, daysBetween(today(), on))));
  const safe = Math.floor((t.capacity_l * t.safe_fill_pct) / 100);
  if (before !== null && before + l > safe) refusals.push(`${l} L on top of ${before} L passes the safe fill of ${safe} L (room for ${Math.max(0, safe - before)} L)`);
  const [onBoard] = await db.query(
    "select coalesce((select sum(litres) from liftings where run_id = $1 and product_id = $2), 0) - coalesce((select sum(litres) from deliveries where run_id = $1 and product_id = $2), 0) as left_l",
    [o.run_id, t.product_id],
  );
  if (num(onBoard.left_l) < l) refusals.push(`only ${num(onBoard.left_l)} L of ${t.product} is on board for ${r.ref} (record the lifting first: load ${r.ref} --product=${t.product} --litres= --bol=)`);
  if (refusals.length) throw new CliError(`Delivery refused for ${o.ref} (${t.label}):\n  - ${refusals.join('\n  - ')}\nNo force flag.`);
  const tgp = await tgpOn(db, r.terminal_id, t.product_id, on);
  if (!tgp) throw new CliError(`No terminal gate price for ${t.product} at the run's terminal on or before ${on}. Record it: tgp --terminal= --product=${t.product} --cpl=`);
  const price = Math.round((num(tgp.tgp_cpl) + num(t.margin_cpl)) * 100) / 100;
  const ref = await nextRef(db, 'DEL', 'deliveries', 81000);
  const after = flags.after !== undefined ? Math.round(Number(flags.after)) : before === null ? null : before + l;
  await db.query(
    'insert into deliveries (ref, run_id, order_id, tank_id, product_id, delivered_on, litres, before_litres, after_litres, tgp_cpl, price_cpl, docket_no, signed_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    [ref, o.run_id, o.id, t.id, t.product_id, on, l, before, after, tgp.tgp_cpl, price, docket, str(flags.signed) || null],
  );
  await db.query("update orders set status = 'delivered' where id = $1", [o.id]);
  if (after !== null) await db.query("insert into dips (tank_id, dipped_on, litres, source, by_name) values ($1, $2, $3, 'driver', $4)", [t.id, on, after, r.driver]);
  const value = Math.round(l * price) / 100;
  let text = `${ref}: ${litres(l)} ${t.product} into ${t.label} on docket ${docket}.`;
  text += `\n  Price ${price.toFixed(2)}c a litre ex GST (terminal gate price ${num(tgp.tgp_cpl).toFixed(2)}c posted ${isoDate(tgp.effective_on)}${isoDate(tgp.effective_on) < on ? ', the last post before today' : ''}, plus ${num(t.margin_cpl).toFixed(2)}c), ${money(value)} ex GST.`;
  if (after !== null) text += `\n  Tank now about ${litres(after)} of ${litres(safe)} safe fill.`;
  return { json: { ref, order: o.ref, tank: t.label, litres: l, price_cpl: price, value_ex_gst: value, before, after }, text };
}

async function cmdComplete(db, args, flags) {
  const r = await resolve(db, 'run', args.join(' '));
  const left = await db.query("select ref from orders where run_id = $1 and status = 'planned'", [r.id]);
  if (left.length && !flags.note) throw new CliError(`${r.ref} still has ${left.length} drop(s) not delivered (${left.map((x) => x.ref).join(', ')}). Deliver them, cancel them (order cancel <ref>), or complete with --note= saying why.`);
  for (const x of left) await db.query("update orders set status = 'open', run_id = null, planned_litres = null where ref = $1", [x.ref]);
  await db.query("update runs set status = 'completed', variance_note = coalesce($2, variance_note) where id = $1", [r.id, str(flags.note) || null]);
  const recon = await db.query('select * from v_reconcile where run_id = $1 order by product', [r.id]);
  const over = recon.filter((x) => Math.abs(num(x.variance_pct)) > VARIANCE_LIMIT);
  let text = `${r.ref} completed.${left.length ? ` ${left.length} drop(s) went back to open orders.` : ''}\n` + table(recon, RECON_COLS);
  if (over.length && !flags.note) text += `\n  Over the ${VARIANCE_LIMIT}% limit: explain it with complete ${r.ref} --note="...". It stays on the attention list until you do.`;
  return { json: { run: r.ref, reconcile: recon, returned_to_open: left.map((x) => x.ref) }, text };
}

// ---------------------------------------------------------------------------
// Writes: prices, money, people, vehicles

async function cmdTgp(db, args, flags) {
  const tm = await resolve(db, 'terminal', need(flags, 'terminal', 'a terminal name'));
  const p = await resolve(db, 'product', need(flags, 'product', 'DSL, ULP91, PULP95'));
  const c = Number(need(flags, 'cpl', 'cents a litre ex GST'));
  if (!(c > 0)) throw new CliError('--cpl must be above zero.');
  const on = parseDate(flags.on) || today();
  await db.query(
    'insert into terminal_prices (terminal_id, product_id, effective_on, tgp_cpl) values ($1, $2, $3, $4) on conflict (terminal_id, product_id, effective_on) do update set tgp_cpl = excluded.tgp_cpl',
    [tm.id, p.id, on, c],
  );
  return { json: { terminal: tm.name, product: p.code, on, tgp_cpl: c }, text: `${tm.name} ${p.code}: ${c.toFixed(2)}c a litre ex GST from ${on}.` };
}

async function cmdMarginSet(db, args, flags) {
  const c = await resolve(db, 'customer', args.join(' '));
  const m = Number(need(flags, 'cpl', 'cents a litre over the terminal gate price'));
  if (!Number.isFinite(m)) throw new CliError('--cpl must be a number.');
  await db.query('update customers set margin_cpl = $1 where id = $2', [m, c.id]);
  await note(db, 'customer', c.id, c.name, `Margin changed from ${num(c.margin_cpl).toFixed(2)}c to ${m.toFixed(2)}c a litre.`);
  return { json: { customer: c.name, from: num(c.margin_cpl), to: m }, text: `${c.name}: margin ${num(c.margin_cpl).toFixed(2)}c to ${m.toFixed(2)}c a litre over the terminal gate price.` };
}

async function cmdPaid(db, args, flags) {
  const d = await resolve(db, 'delivery', args.join(' '));
  if (d.paid_on) throw new CliError(`${d.ref} was paid on ${isoDate(d.paid_on)}.`);
  const on = parseDate(flags.on) || today();
  await db.query('update deliveries set paid_on = $1, invoice_no = coalesce(invoice_no, $2) where id = $3', [on, 'INV-' + d.ref.slice(4), d.id]);
  return { json: { ref: d.ref, paid_on: on }, text: `${d.ref} marked paid on ${on}.` };
}

async function cmdHold(db, args, flags) {
  const c = await resolve(db, 'customer', args.join(' '));
  const release = args.length && flags.release;
  const status = release ? 'active' : 'on_hold';
  await db.query('update customers set status = $1 where id = $2', [status, c.id]);
  await note(db, 'customer', c.id, c.name, release ? `Hold released. ${str(flags.note)}` : `Put on hold. ${str(flags.note)}`);
  return { json: { customer: c.name, status }, text: `${c.name} is now ${status === 'on_hold' ? 'ON HOLD: deliveries are refused' : 'active'}.` };
}

async function cmdEndorse(db, args, flags) {
  const d = await resolve(db, 'driver', args.join(' '));
  const exp = parseDate(need(flags, 'expires', 'YYYY-MM-DD'));
  await db.query('update drivers set dg_endorsement_expires_on = $1 where id = $2', [exp, d.id]);
  // The driver record keeps only the current expiry, so the lapse goes on the record as a note before it is overwritten.
  const lapsed = await db.query("select string_agg(r.ref, ', ' order by r.run_on) as runs from runs r where r.driver_id = $1 and r.status <> 'cancelled' and $2::date is not null and r.run_on > $2::date", [d.id, d.dg_endorsement_expires_on]);
  await note(db, 'driver', d.id, d.name, `Endorsement recorded to ${exp} (was ${d.dg_endorsement_expires_on ? isoDate(d.dg_endorsement_expires_on) : 'not on file'}).${lapsed[0]?.runs ? ` Runs driven while lapsed: ${lapsed[0].runs}.` : ''}`);
  return { json: { driver: d.name, expires: exp }, text: `${d.name}: dangerous goods endorsement recorded to ${exp}.` };
}

async function cmdTruckCert(db, args, flags) {
  const tr = await resolve(db, 'truck', args.join(' '));
  if (!flags.vehicle && !flags.meter) throw new CliError('Give --vehicle=YYYY-MM-DD (the vehicle certificate) and/or --meter=YYYY-MM-DD (the meter certification).');
  if (flags.vehicle) await db.query('update trucks set dg_vehicle_expires_on = $1 where id = $2', [parseDate(flags.vehicle), tr.id]);
  if (flags.meter) await db.query('update trucks set meter_certified_until = $1 where id = $2', [parseDate(flags.meter), tr.id]);
  return { json: { truck: tr.rego, vehicle: parseDate(flags.vehicle), meter: parseDate(flags.meter) }, text: `${tr.rego}: ${flags.vehicle ? `vehicle certificate to ${parseDate(flags.vehicle)}` : ''}${flags.vehicle && flags.meter ? ', ' : ''}${flags.meter ? `meter certified to ${parseDate(flags.meter)}` : ''}.` };
}

async function cmdLog(db, args) {
  const [q, ...rest] = args;
  const body = rest.join(' ').trim();
  if (!q || !body) throw new CliError('log <customer | tank | order | run> "what happened"');
  for (const kind of ['order', 'run', 'customer', 'tank']) {
    const r = await resolve(db, kind, q, { optional: true }).catch(() => null);
    if (r) {
      const label = r.ref || r.label || r.name;
      await note(db, kind, r.id, label, body);
      return { json: { kind, label, body }, text: `Noted on ${kind} ${label}.` };
    }
  }
  throw new CliError(`Nothing matches "${q}".`);
}

async function cmdAdd(db, args, flags) {
  const [kind, ...rest] = args;
  const name = rest.join(' ').trim();
  if (!kind || !name) throw new CliError('add customer|site|tank|driver|truck|terminal|product "<name>" [--flags]');
  if (kind === 'customer') {
    const term = flags.terminal ? await resolve(db, 'terminal', flags.terminal) : null;
    await db.query('insert into customers (code, name, kind, contact_name, phone, email, margin_cpl, terms_days, credit_limit, home_terminal_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [str(flags.code) || null, name, str(flags.kind) || 'commercial', str(flags.contact) || null, str(flags.phone) || null, str(flags.email) || null, flags.margin ? Number(flags.margin) : 12, flags.terms ? Number(flags.terms) : 20, flags.limit ? Number(flags.limit) : null, term ? term.id : null]);
    return { json: { added: 'customer', name }, text: `Customer ${name} added.${term ? '' : ' Give it a home terminal (--terminal=) so it has a price.'}` };
  }
  if (kind === 'site') {
    const c = await resolve(db, 'customer', need(flags, 'customer'));
    await db.query('insert into sites (customer_id, name, address, region, access_notes) values ($1, $2, $3, $4, $5)', [c.id, name, str(flags.address) || null, str(flags.region) || null, str(flags.access) || null]);
    return { json: { added: 'site', name, customer: c.name }, text: `Site ${name} added for ${c.name}.` };
  }
  if (kind === 'tank') {
    const c = await resolve(db, 'customer', need(flags, 'customer'));
    const [s] = await db.query('select * from sites where customer_id = $1 and lower(name) = lower($2)', [c.id, need(flags, 'site')]);
    if (!s) throw new CliError(`${c.name} has no site "${flags.site}". Add it: add site "<name>" --customer="${c.name}".`);
    const p = await resolve(db, 'product', need(flags, 'product'));
    await db.query('insert into tanks (site_id, product_id, tank_no, capacity_l, keep_full, telemetry, avg_daily_use_l, certificate_required, certificate_ref, certificate_expires_on) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [s.id, p.id, name, wholeLitres(need(flags, 'capacity')), Boolean(flags['keep-full']), Boolean(flags.telemetry), flags.use ? Number(flags.use) : null, !flags['no-certificate'], str(flags.cert) || null, parseDate(flags['cert-expires'])]);
    return { json: { added: 'tank', name, site: s.name }, text: `Tank ${name} (${p.code}) added at ${c.name} / ${s.name}.` };
  }
  if (kind === 'driver') {
    await db.query('insert into drivers (name, phone, licence_class, dg_endorsement_expires_on) values ($1, $2, $3, $4)', [name, str(flags.phone) || null, str(flags.licence) || null, parseDate(flags['dg-expires'])]);
    return { json: { added: 'driver', name }, text: `Driver ${name} added.` };
  }
  if (kind === 'truck') {
    const [tr] = await db.query('insert into trucks (rego, name, dg_vehicle_expires_on, meter_ref, meter_certified_until) values ($1, $2, $3, $4, $5) returning id', [name.toUpperCase(), str(flags.name) || null, parseDate(flags.vehicle), str(flags['meter-ref']) || null, parseDate(flags.meter)]);
    const comps = str(flags.compartments).split(',').map((x) => x.trim()).filter(Boolean);
    for (let i = 0; i < comps.length; i++) await db.query('insert into compartments (truck_id, comp_no, capacity_l) values ($1, $2, $3)', [tr.id, i + 1, wholeLitres(comps[i])]);
    return { json: { added: 'truck', rego: name.toUpperCase(), compartments: comps.length }, text: `Tanker ${name.toUpperCase()} added with ${comps.length} compartments.${comps.length ? '' : ' Give --compartments=6000,5000,4000 so plan-run can load it.'}` };
  }
  if (kind === 'terminal') {
    await db.query('insert into terminals (name, supplier, region) values ($1, $2, $3)', [name, str(flags.supplier) || null, str(flags.region) || null]);
    return { json: { added: 'terminal', name }, text: `Terminal ${name} added.` };
  }
  if (kind === 'product') {
    await db.query('insert into products (code, name, dg_class, un_number) values ($1, $2, $3, $4)', [name.toUpperCase(), str(flags.name) || name, str(flags['dg-class']) || null, str(flags.un) || null]);
    return { json: { added: 'product', code: name.toUpperCase() }, text: `Product ${name.toUpperCase()} added.` };
  }
  throw new CliError(`Cannot add "${kind}". add customer|site|tank|driver|truck|terminal|product`);
}

// ---------------------------------------------------------------------------
// Compliance: the rule book, run against the records

const RULES = [
  {
    key: 'driver-dg',
    title: 'Every run is driven by a driver with a current dangerous goods endorsement',
    source: 'NZ: Land Transport (Driver Licensing) Rule 1999, D endorsement. AU: Australian Dangerous Goods Code and the state dangerous goods driver licence.',
    fix: '`endorse <driver> --expires=`, and move that driver off planned runs until it is renewed',
    sql: `select r.ref as label, d.name || ' drove on ' || r.run_on || ', endorsement ' || coalesce('lapsed ' || d.dg_endorsement_expires_on, 'not on file') as detail
          from runs r join drivers d on d.id = r.driver_id
          where r.status <> 'cancelled' and r.run_on > current_date - 90 and (d.dg_endorsement_expires_on is null or d.dg_endorsement_expires_on < r.run_on)`,
  },
  {
    key: 'driver-dg-due',
    title: 'No endorsement lapses in the next 30 days without a renewal booked',
    source: 'As above. Thirty days is the house lead time for a renewal.',
    fix: '`endorse <driver> --expires=` once renewed',
    sql: `select name as label, 'endorsement lapses ' || dg_endorsement_expires_on as detail from drivers
          where status = 'active' and dg_endorsement_expires_on between current_date and current_date + 30`,
  },
  {
    key: 'vehicle-cert',
    title: 'Every tanker on a run holds a current vehicle certificate',
    source: 'NZ: Land Transport Rule: Vehicle Standards Compliance 2002 (certificate of fitness). AU: the state dangerous goods vehicle licence under the Australian Dangerous Goods Code.',
    fix: '`truck-cert <rego> --vehicle=`',
    sql: `select r.ref as label, tr.rego || ' ran on ' || r.run_on || ', vehicle certificate ' || coalesce('lapsed ' || tr.dg_vehicle_expires_on, 'not on file') as detail
          from runs r join trucks tr on tr.id = r.truck_id
          where r.status <> 'cancelled' and r.run_on > current_date - 90 and (tr.dg_vehicle_expires_on is null or tr.dg_vehicle_expires_on < r.run_on)
          union all
          select rego, 'vehicle certificate ' || coalesce('lapsed ' || dg_vehicle_expires_on, 'not on file') from trucks
          where status = 'active' and (dg_vehicle_expires_on is null or dg_vehicle_expires_on < current_date)`,
  },
  {
    key: 'meter',
    title: 'Every tanker meter used to sell fuel holds current trade certification',
    source: 'NZ: Weights and Measures Act 1987 and Weights and Measures Regulations 1999. AU: National Measurement Act 1960 and the National Trade Measurement Regulations 2009.',
    fix: 'book the meter certification, then `truck-cert <rego> --meter=`',
    sql: `select rego as label, 'meter ' || coalesce(meter_ref, '?') || ' certification ' || coalesce('lapsed ' || meter_certified_until, 'not on file') as detail
          from trucks where status = 'active' and (meter_certified_until is null or meter_certified_until < current_date)`,
  },
  {
    key: 'tank-certificate',
    title: 'Every tank that needs one has a current certificate before it is filled',
    source: 'NZ: Health and Safety at Work (Hazardous Substances) Regulations 2017, Part 17 (stationary container systems). AU: AS 1940 and the state work health and safety regulations for storing flammable and combustible liquids.',
    fix: '`cert <tank> --ref= --expires=` from the certifier\'s paperwork',
    sql: `select t.customer || ' / ' || t.site || ' / ' || t.tank_no as label,
            coalesce('certificate lapsed ' || t.certificate_expires_on, 'no certificate on file') ||
            coalesce(', ' || (select count(*) from deliveries d where d.tank_id = t.tank_id and d.delivered_on > coalesce(t.certificate_expires_on, date '1900-01-01')) || ' deliveries since', '') as detail
          from v_tanks t where t.status = 'active' and t.certificate_required and (t.certificate_expires_on is null or t.certificate_expires_on < current_date)`,
  },
  {
    key: 'bill-of-lading',
    title: 'Every load lifted carries its transport document (the terminal bill of lading)',
    source: 'NZ: Land Transport Rule: Dangerous Goods 2005, documentation. AU: Australian Dangerous Goods Code, Part 11 (documentation).',
    fix: 'find the bill of lading and record it on the lifting',
    sql: `select r.ref as label, p.code || ' ' || l.litres || ' L lifted ' || l.lifted_on || ' with no bill of lading recorded' as detail
          from liftings l join runs r on r.id = l.run_id join products p on p.id = l.product_id where l.bol_ref is null or l.bol_ref = ''`,
  },
  {
    key: 'docket',
    title: 'Every delivery has a docket number',
    source: 'Trade measurement: the buyer is entitled to the quantity in writing (Weights and Measures Act 1987; National Measurement Act 1960). The GST tax invoice is built from it (Goods and Services Tax Act 1985, s 19F; A New Tax System (Goods and Services Tax) Act 1999).',
    fix: 'find the docket in the driver\'s book and record it',
    sql: `select ref as label, customer || ' / ' || site || ', ' || litres || ' L on ' || delivered_on || ', no docket' as detail
          from v_deliveries where docket_no is null or docket_no = ''`,
  },
  {
    key: 'safe-fill',
    title: 'No delivery took a tank past its safe fill',
    source: 'House rule, set per tank (95 per cent by default): the room left for expansion. AS 1940 and the tank maker set the figure; the operator records it.',
    fix: 'check the dip chart and the safe fill setting for the tank; talk to the driver',
    sql: `select ref as label, customer || ' / ' || site || ' / ' || tank_no || ': ' || after_litres || ' L after delivery, safe fill ' || safe_fill_l || ' L' as detail
          from v_deliveries where after_litres > safe_fill_l`,
  },
  {
    key: 'water',
    title: 'Water found on a dip is dealt with before the next delivery',
    source: 'Fuel quality: NZ Engine Fuel Specifications Regulations 2011; AU Fuel Quality Standards Act 2000. Water above 10 mm is the house trigger.',
    fix: 'arrange a drain or a tank clean, record a clean dip, then deliver',
    sql: `select customer || ' / ' || site || ' / ' || tank_no as label, water_mm || ' mm of water on ' || last_dip_on as detail
          from v_tanks where status = 'active' and water_mm > 10`,
  },
  {
    key: 'variance',
    title: 'Every completed run reconciles: loaded against delivered within the limit, or explained',
    source: 'House rule: 0.5 per cent per run and product. Stock lost between terminal and tank is money, and a pattern on one tanker or driver is a meter fault or worse.',
    fix: '`complete <run> --note="..."` with the reason, or investigate',
    sql: `select run_ref || ' ' || product as label, driver || ', ' || rego || ': ' || loaded_l || ' L loaded, ' || delivered_l || ' L delivered (' || variance_pct || '%)' as detail
          from v_reconcile where status = 'completed' and abs(coalesce(variance_pct, 0)) > 0.5 and variance_note is null`,
  },
];

async function cmdCompliance(db, args) {
  const only = args[0];
  const rules = only ? RULES.filter((r) => r.key === only) : RULES;
  if (!rules.length) throw new CliError(`No rule "${only}". Rules: ${RULES.map((r) => r.key).join(', ')}`);
  const results = [];
  for (const rule of rules) {
    const breaches = await db.query(rule.sql);
    results.push({ key: rule.key, title: rule.title, source: rule.source, fix: rule.fix, breaches });
  }
  let text = heading('The rule book, run against the records');
  for (const r of results) {
    text += `\n\n${r.breaches.length ? 'FAIL' : ' ok '} ${r.key}: ${r.title}`;
    text += `\n      ${r.source}`;
    for (const b of r.breaches) text += `\n      - ${b.label}: ${b.detail}`;
    if (r.breaches.length) text += `\n      fix: ${r.fix}`;
  }
  const failed = results.filter((r) => r.breaches.length).length;
  text += `\n\n${results.length - failed} of ${results.length} rules pass. Sources and the fuller reading: docs/compliance.md. None of this is legal advice.`;
  return { json: results, text };
}

// ---------------------------------------------------------------------------
// Import and export

function readCsvFile(file) {
  if (!file || file === true) return [];
  return parseCsv(readFileSync(path.resolve(String(file)), 'utf8'));
}

// Column names from PDI exports and the common distributor spreadsheets. Each list is tried in order.
async function cmdImport(db, args, flags) {
  const source = args[0];
  if (!['pdi', 'csv'].includes(source)) throw new CliError('import pdi|csv --customers=customers.csv [--tanks=tanks.csv --deliveries=deliveries.csv] [--dry-run]');
  const dry = Boolean(flags['dry-run']);
  const report = { customers: 0, sites: 0, tanks: 0, deliveries: 0, skipped: [], warnings: [] };
  const [anyTerminal] = await db.query('select id from terminals order by name limit 1');
  await db.exec('BEGIN');
  try {
    for (const row of readCsvFile(flags.customers)) {
      const name = pick(row, 'Customer Name', 'Name', 'Account Name', 'Customer');
      if (!name) { report.skipped.push(`customer row with no name: ${JSON.stringify(row).slice(0, 80)}`); continue; }
      const code = pick(row, 'Customer ID', 'Customer Number', 'Account', 'Code', 'No.') || null;
      if ((await db.query('select 1 from customers where lower(name) = lower($1) or (code is not null and code = $2)', [name, code])).length) { report.skipped.push(`customer ${name}: already here`); continue; }
      const margin = pick(row, 'Margin', 'Margin CPL', 'Differential', 'Price Differential');
      const terms = pick(row, 'Terms Days', 'Payment Terms', 'Terms');
      const limit = pick(row, 'Credit Limit', 'Limit');
      await db.query('insert into customers (code, name, contact_name, phone, email, margin_cpl, terms_days, credit_limit, home_terminal_id, external_ref) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [code, name, pick(row, 'Contact', 'Contact Name') || null, pick(row, 'Phone', 'Phone Number') || null, pick(row, 'Email', 'E-mail') || null, margin ? Number(margin) : 12, terms && /\d+/.test(terms) ? Number(terms.match(/\d+/)[0]) : 20, limit ? Number(String(limit).replace(/[$,]/g, '')) : null, anyTerminal ? anyTerminal.id : null, code]);
      report.customers++;
      if (!margin) report.warnings.push(`${name}: no margin in the export, set to 12c a litre: check it (margin <customer> --cpl=)`);
    }
    for (const row of readCsvFile(flags.tanks)) {
      const custQ = pick(row, 'Customer ID', 'Customer Number', 'Customer Name', 'Customer');
      const siteName = pick(row, 'Site Name', 'Ship To Name', 'Delivery Point', 'Site', 'Location') || 'Main site';
      const tankNo = pick(row, 'Tank Number', 'Tank ID', 'Tank', 'Tank No') || 'T1';
      const prodQ = pick(row, 'Product', 'Product Code', 'Item');
      const cap = Number(String(pick(row, 'Capacity', 'Tank Size', 'Capacity (L)', 'Size') || '').replace(/[,\sL]/gi, ''));
      if (!custQ || !prodQ || !(cap > 0)) { report.skipped.push(`tank ${tankNo}: needs a customer, a product and a capacity`); continue; }
      const c = await resolve(db, 'customer', custQ, { optional: true }).catch(() => null);
      const p = await resolve(db, 'product', prodQ, { optional: true }).catch(() => null);
      if (!c || !p) { report.skipped.push(`tank ${tankNo}: ${!c ? `no customer "${custQ}"` : `no product "${prodQ}" (add product ${prodQ})`}`); continue; }
      let [s] = await db.query('select id from sites where customer_id = $1 and lower(name) = lower($2)', [c.id, siteName]);
      if (!s) {
        [s] = await db.query('insert into sites (customer_id, name, address, region) values ($1, $2, $3, $4) returning id', [c.id, siteName, pick(row, 'Address', 'Ship To Address', 'Street') || null, pick(row, 'Region', 'Zone', 'Route') || null]);
        report.sites++;
      }
      if ((await db.query('select 1 from tanks where site_id = $1 and tank_no = $2', [s.id, tankNo])).length) { report.skipped.push(`tank ${c.name} / ${siteName} / ${tankNo}: already here`); continue; }
      const certExp = pick(row, 'Certificate Expiry', 'Compliance Expiry', 'LCC Expiry');
      const use = pick(row, 'Daily Usage', 'Avg Daily Use', 'Usage Per Day');
      await db.query('insert into tanks (site_id, product_id, tank_no, capacity_l, keep_full, telemetry, avg_daily_use_l, certificate_ref, certificate_expires_on, external_ref) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [s.id, p.id, tankNo, Math.round(cap), yesNo(pick(row, 'Keep Full', 'Auto Fill', 'Forecast', 'Automatic'), false), yesNo(pick(row, 'Telemetry', 'Monitored', 'Sensor'), false), use ? Math.round(Number(use)) : null, pick(row, 'Certificate', 'Compliance Certificate', 'LCC') || null, certExp ? parseDate(certExp) : null, pick(row, 'Tank ID') || null]);
      report.tanks++;
      if (!certExp) report.warnings.push(`${c.name} / ${siteName} / ${tankNo}: no certificate expiry: deliveries will be refused until one is recorded, or mark it not needed`);
    }
    for (const row of readCsvFile(flags.deliveries)) {
      const custQ = pick(row, 'Customer ID', 'Customer Number', 'Customer Name', 'Customer');
      const tankNo = pick(row, 'Tank Number', 'Tank ID', 'Tank', 'Tank No') || 'T1';
      const prodQ = pick(row, 'Product', 'Product Code', 'Item');
      const l = Number(String(pick(row, 'Quantity', 'Litres', 'Delivered Qty', 'Gross Qty', 'Net Qty') || '').replace(/[,\s]/g, ''));
      const ext = pick(row, 'Ticket Number', 'Delivery Ticket', 'Docket', 'Invoice Number', 'Delivery ID') || null;
      if (!custQ || !(l > 0)) { report.skipped.push(`delivery ${ext || '?'}: needs a customer and a quantity`); continue; }
      const c = await resolve(db, 'customer', custQ, { optional: true }).catch(() => null);
      if (!c) { report.skipped.push(`delivery ${ext || '?'}: no customer "${custQ}"`); continue; }
      const tanks = await db.query('select t.id, t.product_id, p.code from tanks t join sites s on s.id = t.site_id join products p on p.id = t.product_id where s.customer_id = $1 and (t.tank_no = $2 or t.external_ref = $2) and ($3 = \'\' or lower(p.code) = lower($3))', [c.id, tankNo, prodQ || '']);
      if (tanks.length !== 1) { report.skipped.push(`delivery ${ext || '?'}: ${tanks.length ? 'several' : 'no'} ${c.name} tanks match "${tankNo}"`); continue; }
      if (ext && (await db.query('select 1 from deliveries where external_ref = $1', [ext])).length) { report.skipped.push(`delivery ${ext}: already here`); continue; }
      const price = Number(pick(row, 'Unit Price', 'Price', 'Price CPL', 'Rate') || 0);
      if (!(price > 0)) report.warnings.push(`delivery ${ext || '?'}: no price: recorded at 0c, fix before it is invoiced`);
      // A price above 20 is cents a litre; a price under 20 is dollars a litre.
      const priceCpl = price > 20 ? price : price * 100;
      const ref = await nextRef(db, 'DEL', 'deliveries', 81000);
      await db.query('insert into deliveries (ref, tank_id, product_id, delivered_on, litres, price_cpl, docket_no, invoice_no, paid_on, external_ref) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [ref, tanks[0].id, tanks[0].product_id, parseDate(pick(row, 'Delivery Date', 'Date', 'Ticket Date')) || today(), Math.round(l), priceCpl, pick(row, 'Ticket Number', 'Delivery Ticket', 'Docket') || null, pick(row, 'Invoice Number', 'Invoice') || null, yesNo(pick(row, 'Paid'), false) ? today() : null, ext]);
      report.deliveries++;
    }
    await db.exec(dry ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
  let text = `${dry ? 'Dry run (nothing written)' : 'Imported'}: ${report.customers} customers, ${report.sites} sites, ${report.tanks} tanks, ${report.deliveries} deliveries.`;
  if (report.skipped.length) text += `\nSkipped (${report.skipped.length}):\n${report.skipped.map((s) => `  - ${s}`).join('\n')}`;
  if (report.warnings.length) text += `\nThe first audit (${report.warnings.length}):\n${report.warnings.map((s) => `  - ${s}`).join('\n')}`;
  if (!dry) text += '\nNow run: attention, compliance, runout --all.';
  return { json: { dry_run: dry, ...report }, text };
}

async function cmdExport(db, args, flags) {
  const out = {};
  for (const t of TABLES) out[t] = await db.query(`select * from ${t}${t === 'settings' ? ' order by key' : ' order by created_at'}`);
  const counts = Object.fromEntries(TABLES.map((t) => [t, out[t].length]));
  const file = str(flags.out) || path.join(REPO_ROOT, 'exports', `fuel-export-${today()}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  return { json: { file, counts }, text: `Exported the whole database to ${file}.\n  ` + Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(', ') + '\nPlain JSON of plain tables. Yours to keep, load anywhere, or hand to an auditor.' };
}

// ---------------------------------------------------------------------------
// Help and dispatch

const HELP = `
Fuel Distribution for Claude Code: the CLI behind the slash commands.

  node scripts/fuel.mjs <command> [args] [--flags]     (or: npm run fuel -- <command>)

Tanks and orders:
  runout [customer] [--days=7 --region= --all]   tanks at reorder, with days to empty
  dip <tank> --litres= [--water=mm --on= --source=customer|driver|telemetry|office --by=]
  order <tank> [--litres=] [--required=tomorrow --po= --source=]     no --litres means fill it
  order cancel <order> [--note=]
  cert <tank> --ref= --expires=                  the tank's compliance certificate

The run:
  plan-run --truck= --driver= [--on=tomorrow --terminal= --region= --dry-run]
      orders due plus keep-full tanks reaching reorder, sized to the safe fill, packed into compartments.
      Refuses a lapsed driver or tanker. Skips held customers, lapsed tank certificates and water.
  load <run> --product= --litres= --bol=         what was lifted at the terminal
  deliver <order> --litres= --docket= [--before= --after= --signed= --on=]
      refuses: past safe fill, lapsed tank certificate, lapsed driver or tanker, customer on hold,
      more than is on board. No force flag.
  complete <run> [--note=]                       closes the run and reconciles loaded against delivered

Prices and money:
  prices [--on=]                                 terminal gate prices and what each customer pays
  tgp --terminal= --product= --cpl= [--on=]      record a posted terminal gate price
  margin <customer> --cpl=                       change a customer's margin over the gate price
  paid <delivery | invoice> [--on=]  |  hold <customer> [--release --note=]

Reads:
  attention                 everything that wants a decision, worst first
  week | stats              the last seven days on one screen
  tanks [customer] [--all]  |  tank <tank>          a tank's card: forecast, dips, deliveries
  customers [--all]  |  customer <name>
  orders [--all]  |  runs [--days=14]  |  run <ref>
  deliveries [customer] [--days=7 --unpaid]
  reconcile [run] [--days=30]   stock lost between terminal and tank, by tanker and product
  margins [--days=30]           margin by customer, smallest per drop first
  usage                         tanks using more or less than they did, and tanks filled too often
  debtors  |  drivers  |  trucks
  compliance [rule]             ten rules from the transport, measurement and hazardous substances law, sources cited

Housekeeping:
  add customer|site|tank|driver|truck|terminal|product "<name>" [--flags]
  endorse <driver> --expires=  |  truck-cert <rego> [--vehicle= --meter=]
  log <customer | tank | order | run> "what happened"
  import pdi|csv --customers= [--tanks= --deliveries=] [--dry-run]
  export [--out=file.json]

Any command takes --json. A tank is found by any words of its customer, site, tank number or product
("woolshed t1", "kauri"). An ambiguous name lists the candidates rather than guessing.
Nothing here connects to a terminal, a telemetry provider, a bank or a customer, and nothing sends.
`;

const COMMANDS = {
  attention: cmdAttention,
  week: cmdWeek,
  stats: cmdStats,
  runout: cmdRunout,
  tanks: cmdTanks,
  tank: cmdTank,
  customers: cmdCustomers,
  customer: cmdCustomer,
  orders: cmdOrders,
  order: cmdOrder,
  runs: cmdRuns,
  run: cmdRun,
  reconcile: cmdReconcile,
  prices: cmdPrices,
  margins: cmdMargin,
  margin: cmdMarginSet,
  usage: cmdUsage,
  debtors: cmdDebtors,
  deliveries: cmdDeliveries,
  drivers: cmdDrivers,
  trucks: cmdTrucks,
  dip: cmdDip,
  cert: cmdCert,
  'plan-run': cmdPlanRun,
  load: cmdLoad,
  deliver: cmdDeliver,
  complete: cmdComplete,
  tgp: cmdTgp,
  paid: cmdPaid,
  hold: cmdHold,
  endorse: cmdEndorse,
  'truck-cert': cmdTruckCert,
  compliance: cmdCompliance,
  log: cmdLog,
  add: cmdAdd,
  import: cmdImport,
  export: cmdExport,
};

async function main() {
  const { args, flags } = parseArgv(process.argv.slice(2));
  const [command, ...rest] = args;
  if (!command || command === 'help' || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return 1;
  }
  const db = await getDb();
  try {
    const result = await fn(db, rest, flags);
    if (flags.json) process.stdout.write(JSON.stringify(result.json, null, 2) + '\n');
    else process.stdout.write(result.text.replace(/^\n/, '') + '\n');
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      return e.code;
    }
    if (/relation "?\w+"? does not exist/.test(e.message)) {
      process.stderr.write('The database has no tables yet. Run: npm run migrate\n');
      return 1;
    }
    process.stderr.write(`error: ${e.message}${e.query ? `\n  in: ${String(e.query).replace(/\s+/g, ' ').slice(0, 300)}` : ''}\n`);
    return 1;
  } finally {
    await db.close();
  }
}

process.exitCode = await main();
