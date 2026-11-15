---
description: Draft a price-move notice to customers from the posted terminal gate prices: what moved, by how much, what it means per litre for them. Drafts only, never sends.
---

1. Run `npm run fuel -- prices --json` and take the move per product from the gate price table. Never quote a figure that is not in it.
2. Ask who it is for (all customers, one kind, one customer). For each, use their own price from the customer table.
3. Write one plain note per customer to `drafts/price-notice-<customer>-<date>.md`: the products they buy, the new price ex and incl GST, the move since the last post, the date it applies from. No forecasts, no apology, no sales lines.
4. Say where the drafts are. **Nothing sends from here.**
