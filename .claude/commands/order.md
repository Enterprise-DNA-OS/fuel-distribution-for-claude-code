---
description: A customer has rung or emailed for fuel. Put the order on the record against the right tank, with the date and any PO number, and say what could stop the delivery.
---

1. Find the tank from what the customer said (customer, site, product). If several match, the CLI lists them: ask which.
2. Run `npm run fuel -- order "<tank>" [--litres=<L>] --required=<date> [--po=<number>] [--source=phone|email|portal]`. No `--litres` means fill it to safe fill.
3. Read back the warnings: a customer on hold, a tank certificate lapsed or due before the date. Either stops the delivery; say what has to happen first.
4. To cancel: `npm run fuel -- order cancel <ORD-ref> --note="<why>"`.
