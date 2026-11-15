# The rule book

`npm run fuel -- compliance` runs ten checks against the records. Each one is below: the rule, where it comes from, what a breach looks like in the data, and what fixes it. The CLI also refuses, at the moment of planning or delivery, the things these rules say must not happen; there is no force flag.

This is not legal advice. The rules are the ones a New Zealand or Australian fuel distributor commonly runs under, written down so the system can check them. Your own obligations depend on your licences, your sites and your state or region. Read each source, confirm it applies to you, and change the rule (`/customise`) where your obligation is different. Where a figure is a house rule rather than law, it says so.

## 1. driver-dg: every run is driven by a driver with a current dangerous goods endorsement

- **Source.** New Zealand: Land Transport (Driver Licensing) Rule 1999, which sets the dangerous goods (D) endorsement a driver needs to carry dangerous goods for hire or reward; Land Transport Rule: Dangerous Goods 2005 for the carriage itself. Australia: the Australian Dangerous Goods Code and the dangerous goods driver licence issued under each state's dangerous goods transport regulations.
- **Breach in the data.** A run whose date is after its driver's `dg_endorsement_expires_on`.
- **Refused at the time.** `plan-run` and `deliver` refuse a driver whose endorsement has lapsed.
- **Fix.** Renew, then `endorse <driver> --expires=`. Renewing writes a note listing any runs driven while lapsed, so the record survives the new date.

## 2. driver-dg-due: no endorsement lapses in the next 30 days unnoticed

- **Source.** As rule 1. Thirty days is a house lead time.
- **Breach.** An active driver whose endorsement expires within 30 days.

## 3. vehicle-cert: every tanker on a run holds a current vehicle certificate

- **Source.** New Zealand: Land Transport Rule: Vehicle Standards Compliance 2002 (the certificate of fitness for heavy vehicles). Australia: the dangerous goods vehicle licence for a tanker, issued under each state's dangerous goods transport regulations and the Australian Dangerous Goods Code.
- **Breach.** A run after its tanker's `dg_vehicle_expires_on`, or an active tanker with none on file or lapsed.
- **Refused at the time.** `plan-run` and `deliver`.
- **Fix.** `truck-cert <rego> --vehicle=`.

## 4. meter: every tanker meter used to sell fuel holds current trade certification

- **Source.** New Zealand: Weights and Measures Act 1987 and the Weights and Measures Regulations 1999 (measuring instruments used for trade). Australia: National Measurement Act 1960 and the National Trade Measurement Regulations 2009.
- **Breach.** An active tanker whose `meter_certified_until` has passed or is not on file.
- **Refused at the time.** `plan-run` and `deliver`: fuel sold by the litre off an uncertified meter is not a delivery this system records.
- **Fix.** Book the certification, then `truck-cert <rego> --meter=`.

## 5. tank-certificate: every tank that needs one has a current certificate before it is filled

- **Source.** New Zealand: Health and Safety at Work (Hazardous Substances) Regulations 2017, Part 17 (stationary container systems), which sets when a stationary tank holding a flammable liquid must be certified and by whom. Australia: AS 1940, The storage and handling of flammable and combustible liquids, called up by each state's work health and safety regulations for hazardous chemicals.
- **Breach.** A tank marked `certificate_required` with no certificate or a lapsed one. The check also counts deliveries made since it lapsed.
- **Refused at the time.** `deliver` refuses; `plan-run` leaves the tank off and says why.
- **Fix.** `cert <tank> --ref= --expires=` from the certifier's paperwork. A small tank that does not need one: `/customise` to mark it `certificate_required = false`, with the reason noted.

## 6. bill-of-lading: every load lifted carries its transport document

- **Source.** New Zealand: Land Transport Rule: Dangerous Goods 2005, the documentation requirements for dangerous goods in transport. Australia: Australian Dangerous Goods Code, Part 11 (documentation). The terminal's bill of lading is the document most distributors carry.
- **Breach.** A lifting with no bill of lading recorded.
- **Refused at the time.** `load` will not record a lifting without `--bol=`.

## 7. docket: every delivery has a docket number

- **Source.** Trade measurement: the buyer of fuel sold by measure is owed the quantity (New Zealand: Weights and Measures Act 1987; Australia: National Measurement Act 1960 and its regulations). The GST tax invoice is built from the docket (New Zealand: Goods and Services Tax Act 1985, section 19F, taxable supply information; Australia: A New Tax System (Goods and Services Tax) Act 1999).
- **Breach.** A delivery with no docket number.
- **Refused at the time.** `deliver` will not record a drop without `--docket=`. Breaches come from imports and history.

## 8. safe-fill: no delivery took a tank past its safe fill

- **Source.** House rule. Each tank carries a safe fill (95 per cent of capacity by default) to leave room for expansion. The tank maker and the site's certifier set the right figure for a tank; record theirs.
- **Breach.** A delivery whose after-dip is above the tank's safe fill.
- **Refused at the time.** `deliver` refuses a drop that would pass it, and `plan-run` sizes every drop to it.

## 9. water: water found on a dip is dealt with before the next delivery

- **Source.** Fuel quality: New Zealand Engine Fuel Specifications Regulations 2011; Australia Fuel Quality Standards Act 2000. Water in a customer's tank is not the distributor's breach, but delivering on top of it is how a quality complaint starts. Ten millimetres is a house trigger.
- **Breach.** A tank whose last dip found more than 10 mm of water.
- **Refused at the time.** `plan-run` leaves the tank off until a clean dip is recorded.

## 10. variance: every completed run reconciles

- **Source.** House rule: loaded at the terminal against delivered into tanks, within 0.5 per cent per run and product, or explained. Stock lost between terminal and tank is money, and a pattern on one tanker or one driver is a meter fault or a conversation.
- **Breach.** A completed run over the limit with no `variance_note`.
- **Fix.** `complete <run> --note="..."` with the reason.

## Changing a rule

Ask for it in plain words ("our variance limit is 0.3 per cent", "tanks under 2,500 litres here do not need a certificate"). `/customise` updates the rule in `scripts/fuel.mjs`, this page and the smoke test together, so the rule, its source and its check never drift apart.
