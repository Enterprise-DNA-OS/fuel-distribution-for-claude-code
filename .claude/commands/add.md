---
description: Add a customer, site, tank, driver, tanker, terminal or product. Asks for what the rules need (certificates, endorsements, compartments) so the first delivery is not refused.
---

1. Ask for the facts, not guesses:
   - customer: name, code, kind, contact, margin over the gate price, terms, credit limit, home terminal
   - site: customer, name, address, region, access notes
   - tank: customer, site, tank number, product, capacity, keep full or not, sensor or not, daily use if known, the certificate number and expiry (or that the tank does not need one)
   - driver: name, licence class, dangerous goods endorsement expiry
   - tanker: rego, compartment sizes in order, vehicle certificate expiry, meter number and certification expiry
2. Run `npm run fuel -- add <kind> "<name>" [--flags]` (see `npm run fuel -- help`).
3. Read back anything that will stop a delivery later: a tank needing a certificate with none recorded, a driver with no endorsement date, a tanker with no compartments.
