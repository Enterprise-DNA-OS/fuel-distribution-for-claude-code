---
description: Record a tank dip (from the customer, the driver, a level sensor or the office) and say what it does to the forecast. Flags water.
---

1. Get the tank (any words of customer, site and tank number: "woolshed t1"), the reading in litres, and any water in millimetres. If the reading is in centimetres off a dip stick, ask for the tank's dip chart or the litres; never convert from a guess.
2. Run `npm run fuel -- dip "<tank>" --litres=<L> [--water=<mm>] [--on=<date>] [--source=customer|driver|telemetry|office] [--by=<name>]`.
3. Read back the new forecast: daily use, days to reorder, days to empty.
4. Water above 10 mm: say plainly not to deliver on top of it until it is drained or checked, and that `plan-run` will leave the tank off until a clean dip is recorded.
5. A batch of dips from a sensor portal or a spreadsheet: run one `dip` per row, then `runout` once.
