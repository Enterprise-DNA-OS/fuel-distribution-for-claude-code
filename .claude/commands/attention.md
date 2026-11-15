---
description: Everything that wants a decision today, worst first. A customer about to run dry, what makes a delivery unlawful, water in a tank, stock lost on a run, accounts, stale dips and prices.
---

1. Run `npm run fuel -- attention`.
2. Present the list in its order (it is sorted worst first): runs dry soon, tank certificates, driver endorsements, tanker certificates, water, late orders, stock lost on a run, accounts, keep-full tanks not dipped, no terminal price today.
3. For each item give the one command that clears it: `order` or `plan-run` for a tank running dry, `cert` for a certificate, `endorse` or `truck-cert` for a driver or tanker, a clean `dip` after water, `complete <run> --note=` for a variance, `hold` or `paid` for an account, `tgp` for a missing price.
4. Do not clear anything without the operator's word. An empty list is the system working; say so in one line.
