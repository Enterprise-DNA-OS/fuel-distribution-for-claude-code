---
description: Record what was lifted at the terminal and each drop off the tanker's meter, priced at the day's terminal gate price plus the customer's margin. Refuses an unsafe or unlawful delivery.
---

At the terminal:

1. From the bill of lading: `npm run fuel -- load <RUN-ref> --product=<code> --litres=<L> --bol=<number>`. One line per product. The bill of lading is the dangerous goods transport document; no number, no lifting.

At each tank:

2. From the meter ticket and the driver's docket: `npm run fuel -- deliver <ORD-ref> --litres=<L> --docket=<number> [--before=<dip> --after=<dip> --signed=<name>]`.
3. The CLI refuses, with no force flag, when: the drop passes the tank's safe fill, the tank certificate has lapsed, the driver's endorsement or the tanker's vehicle certificate or meter certification has lapsed, the customer is on hold, or more is being delivered than is on board. Say which, and what fixes it. Never suggest editing the safe fill to make a drop fit.
4. Read back the price: the terminal gate price behind it (and whether it was today's post or the last one before), the margin, the value ex GST.
5. When the run is done: `/reconcile`.
