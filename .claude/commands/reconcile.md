---
description: Close a run and reconcile what left the terminal against what reached the tanks, by run, tanker and product. Shrinkage over the limit needs a reason.
---

1. Close today's run: `npm run fuel -- complete <RUN-ref>`. Drops not delivered go back to open orders only with `--note=` saying why.
2. Show loaded, delivered and left over per product. Over 0.5 per cent (the house limit) without an explanation stays on the attention list.
3. Ask the operator for the reason (a retain left on board, a meter fault, a temperature swing between terminal and tank, a spill) and record it: `npm run fuel -- complete <RUN-ref> --note="<reason>"`.
4. For the month: `npm run fuel -- reconcile --days=30`. Read the tanker-by-product totals for a pattern: the same tanker or the same driver losing a little every run is a meter to certify or a conversation to have. Say so plainly, without accusing anyone.
