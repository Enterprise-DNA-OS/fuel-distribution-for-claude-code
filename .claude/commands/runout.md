---
description: Who runs dry first. Every tank at or near reorder, its estimated level, its measured daily use, days to reorder and to empty, and whether it is on order.
---

1. Run `npm run fuel -- runout` (seven days ahead). Add `--days=3` for the urgent ones, `--region=<area>` for one run's patch, a customer name for one account, `--all` for every tank.
2. Present the table worst first and say in one line what it means: "Kauri Ridge Station's woolshed tank is about 538 L, 2.8 days from empty, nothing on order."
3. Flag the guesses. A `*` on the daily use means there are too few dips to measure it; `?` means the tank has never been dipped. A keep-full tank not dipped in 14 days is a guess too: suggest asking the customer for a dip (`/dips`).
4. Offer the next step: `/plan-run` for tomorrow, or `/order` for a tank a customer has rung about.
