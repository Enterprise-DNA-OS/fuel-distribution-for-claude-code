<h1 align="center">Fuel Distribution for Claude Code</h1>

<p align="center">
  <strong>The open-source fuel distribution system that is just a database and Claude Code.</strong>
</p>

<p align="center">
  Created by <a href="https://www.enterprisedna.co"><strong>Enterprise DNA</strong></a>. Free and open source. Works with Claude Code, Codex, OpenCode or Cursor.
</p>

<!-- three-doors -->
<table align="center">
  <tr>
    <td align="center"><strong>Do it yourself</strong><br/>Clone it, run it, own it. Free, MIT.<br/><a href="#quick-start">Quick start</a></td>
    <td align="center"><strong>We customise it</strong><br/>Your fields, your rules, your PDI Logistics Cloud data brought across.<br/><a href="https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=pdi-logistics-cloud">Book a call</a></td>
    <td align="center"><strong>We run it for you</strong><br/>Installed, connected and operated inside Omni. Setup fee, then a retainer.<br/><a href="https://enterprisedna.co/omni/instead-of/pdi-logistics-cloud?utm_source=github&utm_medium=readme&utm_campaign=pdi-logistics-cloud">How it works</a></td>
  </tr>
</table>

<p align="center">
  <a href="#what-is-this">What is this</a> &bull;
  <a href="#why-no-front-end">Why no front end</a> &bull;
  <a href="#quick-start">Quick start</a> &bull;
  <a href="#the-commands">Commands</a> &bull;
  <a href="#instead-of-pdi-logistics-cloud">Instead of PDI Logistics Cloud</a> &bull;
  <a href="#want-it-installed-and-run-for-you">Installed for you</a> &bull;
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square" alt="Node 20+" />
  <img src="https://img.shields.io/badge/PostgreSQL-any-336791?style=flat-square" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/PGlite-embedded-3ecf8e?style=flat-square" alt="PGlite" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" />
</p>

---

## What is this

Fuel Distribution for Claude Code does the job you pay PDI Logistics Cloud for, as a Postgres database and a set of agent commands. There is no web front end. You open the folder in [Claude Code](https://claude.com/claude-code) (or Codex, OpenCode, Cursor: see `AGENTS.md`) and ask for what you want in plain language. It runs the right query, and it can answer questions the PDI Logistics Cloud dashboard cannot.

PDI publishes no price for PDI Logistics Cloud: it is quoted per fleet, as planning and dispatch, forecasting, in-truck apps, telematics and analytics, and usually sits beside a back office ERP and a fuel pricing product from the same vendor ([PDI Logistics Planning & Dispatch](https://pditechnologies.com/increase-productivity/logistics-solutions/pdi-logistics-planning-dispatch/)). Every one of those is a screen over the same records: customers, tanks, dips, orders, runs and deliveries.

Want the same thing with a web front end, or built on a different stack? That is a customisation, and it is exactly what Enterprise DNA does: [book a call](https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=pdi-logistics-cloud).

Fuel Distribution for Claude Code is for New Zealand and Australian fuel and lubricant distributors: regional resellers, farm and depot fuel businesses, and anyone running a few tankers into customers' tanks. It holds the terminals and their posted gate prices, every customer tank with its safe fill and certificate, the dips, the orders, the tankers and their compartments, the drivers, the runs, the liftings and the deliveries, and what each customer owes.

It forecasts every tank from its own dips, plans tomorrow's run into the compartments, prices each drop at the day's terminal gate price plus the customer's margin, and reconciles what left the terminal against what reached the tanks. It refuses, with no override, a drop that would pass a tank's safe fill, a tank whose certificate has lapsed, a driver whose dangerous goods endorsement has lapsed, a tanker whose certificate or meter certification has lapsed, and a customer on hold.

## Ten questions PDI's dashboards do not answer

Each is a real command on the demo data today.

1. **Which tanks run dry before the next run gets to them, and which of those has nobody ordered?** `runout --days=3`
2. **Which customers' small drops cost more to deliver than they earn?** `margins` (margin per drop, smallest first)
3. **Which tank started using a quarter more diesel this fortnight: a leak, theft or a new machine?** `usage`
4. **Which tankers lose stock between the terminal and the tank, and is it the same driver every time?** `reconcile --days=30`
5. **Which customer tanks were filled after their certificate lapsed, and how many times?** `compliance tank-certificate`
6. **Which runs were driven by someone whose dangerous goods endorsement had lapsed?** `compliance driver-dg`
7. **Who is over their credit limit and still has fuel booked on tomorrow's run?** `plan-run --dry-run` flags it on each drop
8. **Which customers need a bigger tank, because we fill them three times a month?** `usage`
9. **Which keep-full tanks are we guessing about, because nobody has dipped them in two weeks?** `attention`
10. **What does each customer pay today at their own terminal's gate price, incl GST?** `prices`

## Your first hour: ten things to ask for

1. "What needs a decision today?"
2. "Who runs dry this week?"
3. "Plan tomorrow's run for KMF101 with Priya, dry run first."
4. "Record a dip: Kauri Ridge woolshed tank, 1,850 litres, no water."
5. "Which runs lost stock last month?"
6. "Who owes us money and who is over their limit?"
7. "Draft a price notice for the farm customers."
8. "Print tomorrow's run sheet."
9. "Add a tanker with compartments of 7,000, 6,000 and 5,000 litres."
10. "Change our variance limit to 0.3 per cent." (`/customise`)

## Why no front end

- The front end was only ever there because the database was hard to talk to. That is no longer true.
- Your data sits in plain Postgres tables you own. Any tool can read them. No export, no lock-in.
- No seats, no tiers, no add-ons. Read [docs/why-no-front-end.md](docs/why-no-front-end.md) for the honest trade-offs too.

## Quick start

Sixty seconds, no database install (an embedded Postgres runs inside Node):

```bash
git clone https://github.com/Enterprise-DNA-OS/fuel-distribution-for-claude-code.git
cd fuel-distribution-for-claude-code
npm install
npm run demo
```

Then open the folder in Claude Code and type `/attention`, or just ask "who runs dry this week?"

### Use it with your own Postgres or Supabase

Copy `.env.example` to `.env`, set `DATABASE_URL`, then `npm run migrate`. Same commands, shared data, no per-seat fee.

## The commands

| Command | What it does |
|---|---|
| `/attention` | Everything that wants a decision, worst first |
| `/runout` | Who runs dry first: level, daily use, days to reorder and empty |
| `/dips` | Record a dip from a customer, driver or sensor; flags water |
| `/order` | Put a customer's order on the right tank, with what could stop it |
| `/plan-run` | Tomorrow's run: drops sized to safe fill, packed into compartments, what to lift |
| `/deliver` | The lifting at the terminal and each drop off the meter, priced on the day |
| `/reconcile` | Close a run: loaded against delivered, shrinkage explained |
| `/prices` | Post terminal gate prices; what each customer pays |
| `/margins` | Margin per drop by customer, and tanks using more than they did |
| `/debtors` | Who owes what, holds and payments |
| `/compliance` | Ten rules from the transport, measurement and hazardous substances law |
| `/week` | The last seven days on one screen |
| `/weekly-review` | The Monday review, written from three commands |
| `/customers` | A customer's card, a tank's card, a run sheet |
| `/add` | Add a customer, site, tank, driver, tanker, terminal or product |
| `/log` | Put a call, a promise or an access change on the record |
| `/draft-price-notice` | A price-move note to customers, into `drafts/` |
| `/draft-account-reminder` | An account reminder with the unpaid deliveries, into `drafts/` |
| `/draft-run-sheet` | The driver's run sheet and delivery dockets, in your brand |
| `/import` | Customers, tanks and history from PDI or any CSV export |
| `/export` | The whole database as one JSON file |
| `/new-view` | A new printable dashboard in plain language |
| `/customise` | Add a field, change a rule, rename a thing: migration written and applied |

Everything runs through one CLI, `npm run fuel -- <command>` (`npm run fuel -- help` lists it all). `npm run view` renders the dispatch board and the stock and money page; `npm run docs` renders delivery dockets, customer statements and run sheets, in the business's brand from `brand.json`.

## Instead of PDI Logistics Cloud

Export customers, tanks and delivery tickets to CSV, then one command:

```bash
npm run fuel -- import pdi --customers=imports/customers.csv --tanks=imports/tanks.csv --deliveries=imports/deliveries.csv --dry-run
```

The dry run is the first audit: tanks with no certificate on file, customers with no margin, deliveries with no price. The full guide, including what maps and what does not carry over: [docs/replace-pdi-logistics-cloud.md](docs/replace-pdi-logistics-cloud.md). The rule book and its sources: [docs/compliance.md](docs/compliance.md).

## Architecture

```
fuel-distribution-for-claude-code/
  CLAUDE.md                 how the operator wants this run (routing table + house rules)
  AGENTS.md                 the same, for Codex / OpenCode / Cursor / Gemini CLI
  .claude/commands/         the slash commands
  scripts/                  the CLI the commands drive
  scripts/lib/db.mjs        one adapter: DATABASE_URL (pg) or embedded PGlite
  supabase/migrations/      plain SQL schema
  supabase/seed.sql         demo data
  docs/                     the thesis and the migration guide
```

## Built for coding agents

The database, CLI and command recipes work with Claude Code, Codex, OpenCode or Cursor. Ask your coding agent for a new command and have it implement and test the change against the same records.

## Contributing

Issues and pull requests are welcome. Keep the shape: plain SQL, a small CLI, a slash command per recurring job, no front end.

## Want it installed and run for you?

Enterprise DNA installs Fuel Distribution for Claude Code for your business, migrates your PDI Logistics Cloud data, connects it to the rest of your tools, and runs it for you as part of **Omni**, our managed Command Center. One setup fee, then a monthly retainer.

- Book a call: [enterprisedna.co/omni/book](https://enterprisedna.co/omni/book/?offer=replace-software&utm_source=github&utm_medium=readme&utm_campaign=pdi-logistics-cloud)
- Read more: [enterprisedna.co/omni/instead-of/pdi-logistics-cloud](https://enterprisedna.co/omni/instead-of/pdi-logistics-cloud?utm_source=github&utm_medium=readme&utm_campaign=pdi-logistics-cloud)

## License

MIT. Copyright (c) 2026 Enterprise DNA.
