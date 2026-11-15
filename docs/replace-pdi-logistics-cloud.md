# Moving off PDI Logistics Cloud

You can run both side by side for a fortnight and switch when the forecasts agree. The move is three exports and one command.

## 1. Export from PDI (or whatever you run today)

PDI's logistics and back office products, like most distributor systems, export their lists and reports to CSV or Excel. You want three files. Save each as CSV into `imports/` (it is never committed).

| File | What it holds | Columns the importer reads |
|---|---|---|
| `customers.csv` | Customer or account list | Customer ID, Customer Name, Contact, Phone, Email, Margin (cents a litre over the gate price), Payment Terms, Credit Limit |
| `tanks.csv` | Tanks or delivery points, one row per tank | Customer ID, Site Name (or Ship To Name), Tank Number, Product, Capacity, Keep Full (or Auto Fill), Telemetry, Daily Usage, Certificate, Certificate Expiry, Address, Region |
| `deliveries.csv` | Delivery tickets for the history you want (a year is plenty) | Ticket Number, Delivery Date, Customer ID, Tank Number, Product, Quantity, Unit Price, Invoice Number, Paid |

Each column has a few accepted names (Ship To Name or Site Name, Quantity or Litres or Net Qty). If your export uses others, rename the header row, or ask Claude Code to extend the mapping in `scripts/fuel.mjs`.

Products must exist first. The demo has ULP91, PULP95 and DSL. Add yours: `npm run fuel -- add product ADB --name="AdBlue"`.

## 2. Run the import

```bash
npm run fuel -- import pdi --customers=imports/customers.csv --tanks=imports/tanks.csv --deliveries=imports/deliveries.csv --dry-run
```

Read the dry run. It lists what would come in, what it skipped and why, and the first audit: tanks with no certificate expiry, customers with no margin, deliveries with no price. Then run it again without `--dry-run`. Running it twice does not duplicate anything.

## 3. Fill in what an export does not carry

- **Terminals and today's gate prices.** `add terminal "<name>"`, then `tgp --terminal= --product= --cpl=` for each. Set each customer's home terminal.
- **Drivers and tankers.** `add driver` with the endorsement expiry; `add truck` with compartment sizes, vehicle certificate and meter certification dates.
- **Dips.** The forecast needs two dips per tank to measure use. Until then it uses the daily usage from the export. Ask your sensor provider for a CSV of readings and load them with `dip`.

## What maps

| PDI idea | Here |
|---|---|
| Customer, account | `customers` |
| Ship-to, delivery point | `sites` |
| Tank, with size and forecast settings | `tanks` (capacity, safe fill, reorder point, keep full, sensor) |
| Tank reading, inventory reading | `dips` |
| Order, forecast order | `orders` (source `keep_full` for the ones the system raised) |
| Load, shift, trip | `runs` |
| Bill of lading, lifting | `liftings` |
| Delivery ticket | `deliveries` |
| Rack or terminal price, price formula | `terminal_prices` plus each customer's `margin_cpl` |

## What does not carry over

- **Price formulas beyond gate price plus margin.** Contract prices, fixed prices, tiered discounts. Each is a small change (`/customise`), and Enterprise DNA brings them across as part of an install.
- **Truck positions and telematics history.** There is no map here.
- **Accounting.** Invoices are numbered and payments marked, but the ledger stays in your accounting system. Connecting the two is a standard part of an install.
- **Signatures and photos from the cab.** Keep the PDFs where they are; the docket number links the record to them.
