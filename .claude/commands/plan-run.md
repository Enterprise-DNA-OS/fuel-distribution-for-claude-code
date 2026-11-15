---
description: Plan tomorrow's run for a tanker and driver. Orders due plus keep-full tanks reaching reorder, sized to safe fill, packed into compartments, with what to lift at the terminal. Dry run first.
---

1. Ask for the date (default tomorrow), the tanker rego and the driver. A region narrows it to one patch.
2. Run the dry run first: `npm run fuel -- plan-run --truck=<rego> --driver=<name> [--on=<date>] [--region=<area>] --dry-run`.
3. Present it: the drops in order (late orders, then whoever runs dry soonest), the litres per product to lift, how the compartments load, and what was left off and why (held customer, lapsed tank certificate, water, no room).
4. Account flags (over the credit limit, 30 days late) do not stop a drop. Point them out and ask whether to put the customer on hold (`hold <customer>`) before booking.
5. A refusal (driver's endorsement or the tanker's vehicle certificate or meter certification lapsed) is final. Say which record has to be renewed, or suggest another driver or tanker.
6. On a yes, run it again without `--dry-run`. Then offer the run sheet for the driver: `npm run docs -- run-sheet`.
