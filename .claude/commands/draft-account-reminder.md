---
description: Draft an account reminder for a customer who is overdue or over their limit, with the unpaid deliveries listed. Drafts only, never sends.
---

1. Run `npm run fuel -- debtors --json` and `npm run fuel -- deliveries "<customer>" --days=120 --unpaid --json`. Read the customer's notes (`customer "<name>"`) first: a promise to pay or a dispute changes the note.
2. Render the statement: `npm run docs -- customer-statement`.
3. Write the reminder to `drafts/account-reminder-<customer>-<date>.md`: the balance ex and incl GST, the overdue deliveries by date, docket and invoice, the terms, and (only if the operator says so) that deliveries are on hold until it is paid.
4. Firm and plain, no threats. **Nothing sends from here.**
