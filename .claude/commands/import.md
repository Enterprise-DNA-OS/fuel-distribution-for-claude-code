---
description: Bring customers, tanks and delivery history across from PDI or any distributor system's CSV exports. Dry run first; the import is the first audit.
---

1. Read `docs/replace-pdi-logistics-cloud.md` and ask for the three exports: customers, tanks (with sites, capacities, certificates) and deliveries. Put them in `imports/` (it is not committed).
2. Dry run: `npm run fuel -- import pdi --customers=imports/customers.csv --tanks=imports/tanks.csv --deliveries=imports/deliveries.csv --dry-run`.
3. Show what would come in, what was skipped and why (an unknown product: add it with `add product`; a customer that does not match), and the first audit: tanks with no certificate expiry, customers with no margin, deliveries with no price.
4. Column names differ by system. If a file uses names the importer does not know, map them by renaming the header row, or extend the `pick(...)` lists in `scripts/fuel.mjs` and add the case to the smoke test.
5. On a yes, run it without `--dry-run`. Then `attention`, `compliance` and `runout --all`.
