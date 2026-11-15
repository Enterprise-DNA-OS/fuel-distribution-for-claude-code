---
description: Who owes what, ex and incl GST, what is overdue and 30 days late, and who is over their credit limit. Put an account on hold or mark a delivery paid.
---

1. Run `npm run fuel -- debtors`.
2. Present it worst first. Over the limit or 30 days late: say whether there is fuel on order or planned for them (`orders`).
3. On the operator's word: `npm run fuel -- hold "<customer>" --note="<why>"` stops deliveries; `--release` lifts it. `npm run fuel -- paid <DEL-ref or invoice>` records a payment.
4. Statements: `npm run docs -- customer-statement`. A reminder email: `/draft-account-reminder`.
