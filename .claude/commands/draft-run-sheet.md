---
description: Print the driver's run sheet and the delivery dockets in the business's brand. Drops in order with access notes, what to lift, safe fill per tank.
---

1. Run `npm run docs -- run-sheet` for every planned or loaded run from today, and `npm run docs -- delivery-docket` for the last 14 days of deliveries.
2. Files land in `docs-out/run-sheet/` and `docs-out/delivery-docket/`. Each opens in a browser and prints to PDF.
3. The business name, logo and colours come from `brand.json`. Change them there, then render again.
