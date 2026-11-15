---
description: Post the day's terminal gate prices and show what every customer pays (gate price plus margin, GST on top). Flags a terminal that has not posted today.
---

1. Today's posts: `npm run fuel -- tgp --terminal=<name> --product=<code> --cpl=<cents a litre ex GST> [--on=<date>]`, one per terminal and product. Take the figures from the terminal's own posting, never from memory or a news story.
2. Run `npm run fuel -- prices` and present both tables: the gate prices with the move since the last post, and each customer's price ex and incl GST. A post marked STALE is yesterday's: say which terminal has not posted.
3. A margin change for one customer: `npm run fuel -- margin "<customer>" --cpl=<cents>`. It is noted on the account.
4. If the operator wants to tell customers about a price move, use `/draft-price-notice`.
