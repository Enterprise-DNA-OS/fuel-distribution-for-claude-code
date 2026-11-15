---
description: Look up a customer, a tank or a run. The account, every tank with its forecast, recent deliveries, notes; or a tank's dips and deliveries; or a run sheet with what was lifted and delivered.
---

1. A customer: `npm run fuel -- customer "<name or code>"`. A tank: `npm run fuel -- tank "<words>"`. A run: `npm run fuel -- run <RUN-ref>`. Lists: `customers`, `tanks [customer]`, `orders`, `runs`, `deliveries [customer] [--unpaid]`, `drivers`, `trucks`.
2. If the name matches several, the CLI lists them. Ask which; never guess.
3. Present the card: the account line first, then tanks worst first, then recent deliveries. Read the notes before drafting anything to the customer.
