# Why there is no front end

PDI Logistics Cloud is a database with a subscription. The tables underneath it are ordinary: a few entities, a few relationships, a handful of workflows you repeat every week. What you pay for is the layer on top that lets people who do not write SQL get at those tables. Screens, filters, dashboards, forms.

That layer used to be the whole product, because talking to a database was hard. It is not hard any more. Open this folder in Claude Code, describe what you want, and it writes the query, runs it, and explains the answer. Ask a question the dashboard never had a chart for and you still get an answer.

## What you gain

- **Better answers.** A dashboard shows what the vendor decided to chart. Here you ask your own question, in your own words, and get it answered against your own data.
- **No seats.** Everyone who needs to look can look. The bill does not grow with headcount.
- **Your data in your Postgres.** Plain tables. Back them up, query them from anything, leave any time. There is no export step because there is nothing to leave.
- **A process that matches you.** When your way of working changes, you add a command. You do not wait for a feature request to clear.

## What you give up

- **A driver app in the cab.** PDI sells in-truck apps that capture the meter ticket and signature at the tank. Here the driver's docket and meter ticket are entered after the drop (or the office types them from a photo). Enterprise DNA builds a simple phone form onto the same database when a fleet wants one.
- **Live truck tracking.** There is no map of where the tankers are right now. The run sheet says where they are going, in order.
- **Automatic sensor feeds.** Level sensors are supported (a dip with source `telemetry`), but the feed from your telemetry provider has to be connected. That is a small, specific job, and it is the kind Enterprise DNA does when it installs this.
- **Drag and drop dispatch.** Runs are planned by asking, not by dragging orders onto a truck. The plan says why each drop is on it and why each tank was left off, which a board never did.
- **A vendor help desk.** This is open source. Enterprise DNA supports the installed version for businesses that want someone to call.

## Who this fits

Small teams who already use Claude Code, or who would rather learn to ask than learn another interface. If your dispatchers need a live screen of every truck all day, keep PDI Logistics Cloud, or have the screen built onto this database. If you need the answers more than the screens, this is cheaper, faster and yours.

Installed and run for you: https://enterprisedna.co/omni/instead-of/pdi-logistics-cloud
