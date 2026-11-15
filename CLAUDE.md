# Fuel Distribution for Claude Code: operating instructions

This file is the brain. Claude Code reads it at the start of every session. It says who this is for, how work gets done, and the one right way to do each recurring job.

## Who this is for

- **Business:** [YOUR BUSINESS]
- **Operator:** [YOUR NAME], [your role]
- **What matters most:** [the one or two outcomes you care about]

Fill this in once. A worker with context knows. A worker without it guesses.

## How to work

1. **Take a brief, not a script.** The operator describes the outcome. You run the right command and present the answer.
2. **Read before you write.** Before drafting anything about a record, read its full history first.
3. **Plain language.** Short sentences. No filler. Numbers in tables.
4. **Silent success, loud problems.** No play-by-play. Say what broke and what you did about it.
5. **Stop at the line.** Anything that sends, deletes, or faces a customer waits for a yes in this session.

## Routing table: one right way for each recurring job

| When the operator asks for... | Use this |
|---|---|
| What needs a decision, what is on fire | `/attention` |
| Who runs dry, a tank's level, forecast | `/runout` |
| A customer read a dip, a sensor reading | `/dips` |
| A customer rang or emailed for fuel | `/order` |
| Plan tomorrow, build a run, what goes on the truck | `/plan-run` |
| The truck loaded, a drop was made | `/deliver` |
| Close a run, stock lost, shrinkage | `/reconcile` |
| Terminal gate prices, a customer's price, a margin change | `/prices` |
| Which customers make money, small drops, a tank using more | `/margins` |
| Who owes us, credit limits, hold an account, a payment | `/debtors` |
| Certificates, endorsements, meter certification, the rules | `/compliance` |
| The week, how did we do | `/week` |
| Monday review | `/weekly-review` |
| Look up a customer, tank or run | `/customers` |
| A new customer, site, tank, driver, tanker | `/add` |
| Note a call or a promise | `/log` |
| Tell customers about a price move | `/draft-price-notice` |
| Chase an overdue account | `/draft-account-reminder` |
| Print the run sheet, dockets | `/draft-run-sheet` |
| Bring data across from PDI or a spreadsheet | `/import` |
| Back up everything, hand data to an auditor | `/export` |
| A new dashboard page | `/new-view` |
| Add a field, change a rule, rename something | `/customise` |

If an ask fits nothing here, run the CLI directly (`npm run <cli> -- --help`) and then propose a new command for it.

## Hard rules

- The CLI refuses unsafe and unlawful deliveries (past safe fill, lapsed tank certificate, lapsed driver endorsement, lapsed tanker or meter certificate, customer on hold). There is no force flag. Never suggest editing a safe fill, an expiry date or a hold to make a drop go through; the fix is the real renewal, the real dip or the operator's decision.
- Prices come from posted terminal gate prices recorded with `tgp`. Never quote a price that is not in the database.
- Never send email or messages from here. Draft to `drafts/`, a person sends.
- Never delete records without an explicit yes in this session. Prefer marking closed or archived.
- Never invent a record. If a name is ambiguous, list the candidates and ask.
- The database is the source of truth. If the answer is not in it, say so.

## Where things live

- `scripts/` the CLI. `scripts/lib/db.mjs` picks `DATABASE_URL` (Postgres, Supabase) or the embedded database in `.data/`.
- `supabase/migrations/` the schema, plain SQL. `npm run migrate` applies it.
- `.claude/commands/` the slash commands. Add one every time the same ask comes twice.
- `docs/` the thesis and the guide for moving off PDI Logistics Cloud.

Built by Enterprise DNA. Installed and run for you as part of Omni: https://enterprisedna.co/omni/instead-of/pdi-logistics-cloud
