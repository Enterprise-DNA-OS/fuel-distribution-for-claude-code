-- Demo data: a regional fuel distributor in the Waikato and Bay of Plenty.
-- Every date is relative to today, so the demo always has something to say:
-- two tanks about to run dry with nothing on order, a tank with water in it,
-- an expired tank certificate, a driver whose dangerous goods endorsement has
-- lapsed (and a run he drove after it lapsed), a tanker with a lapsed meter
-- certificate, a run that lost diesel with no note, a late order and a customer
-- over its credit limit. The history (dips, deliveries, runs, liftings) is
-- simulated over 60 days so the usage forecast has real numbers to work from.
-- Idempotent: a second run does nothing.

do $seed$
declare
  t record;
  d date;
  lvl numeric;
  use_today numeric;
  v_litres int;
  run_n int := 4000;
  del_n int := 81000;
  r record;
  rid uuid;
  tk uuid;
  dr uuid;
  tm uuid;
  day_i int;
  price numeric;
begin
  if exists (select 1 from products where code = 'DSL') then
    return;
  end if;

  insert into settings (key, value) values
    ('country', 'NZ'), ('currency', 'NZD'), ('gst_rate', '0.15'),
    ('variance_limit_pct', '0.5'), ('business_name', 'Kaimai Fuels');

  insert into products (code, name, dg_class, un_number) values
    ('ULP91', 'Regular unleaded 91', '3', 'UN1203'),
    ('PULP95', 'Premium unleaded 95', '3', 'UN1203'),
    ('DSL', 'Diesel', '3', 'UN1202');

  insert into terminals (name, supplier, region) values
    ('Wiri Terminal', 'Wiri Oil Services', 'Auckland'),
    ('Mount Maunganui Terminal', 'Mount Maunganui Bulk', 'Bay of Plenty');

  -- Terminal gate prices, posted daily for 61 days. Mount Maunganui has not posted ULP91 today.
  for day_i in 0..60 loop
    d := current_date - day_i;
    for r in select tm2.id as tid, tm2.name, p.id as pid, p.code from terminals tm2 cross join products p loop
      if day_i = 0 and r.name = 'Mount Maunganui Terminal' and r.code = 'ULP91' then
        continue;
      end if;
      price := case r.code when 'ULP91' then 226 when 'PULP95' then 239 else 151 end
               + case when r.name = 'Mount Maunganui Terminal' then 1.4 else 0 end
               + round((((day_i * 7) % 11) - 5) * 0.6, 2);
      insert into terminal_prices (terminal_id, product_id, effective_on, tgp_cpl) values (r.tid, r.pid, d, price);
    end loop;
  end loop;

  insert into customers (code, name, kind, contact_name, phone, email, margin_cpl, terms_days, credit_limit, home_terminal_id) values
    ('C101', 'Waikeria Valley Farms', 'farm', 'Hemi Walker', '021 400 101', 'accounts@waikeriavalley.example', 14.50, 20, 30000, (select id from terminals where name = 'Wiri Terminal')),
    ('C102', 'Kauri Ridge Station', 'farm', 'Jo Prentice', '021 400 102', 'jo@kauriridge.example', 15.00, 20, 20000, (select id from terminals where name = 'Wiri Terminal')),
    ('C103', 'Northline Freight', 'transport', 'Sanjay Rao', '021 400 103', 'fleet@northline.example', 5.80, 14, 120000, (select id from terminals where name = 'Mount Maunganui Terminal')),
    ('C104', 'Brennan Civil', 'construction', 'Ciara Brennan', '021 400 104', 'ops@brennancivil.example', 9.50, 20, 60000, (select id from terminals where name = 'Wiri Terminal')),
    ('C105', 'Harbourside Marine', 'marine', 'Tom Ngata', '021 400 105', 'office@harbourside.example', 11.00, 20, 60000, (select id from terminals where name = 'Mount Maunganui Terminal')),
    ('C106', 'Matamata Contractors', 'construction', 'Lee Fraser', '021 400 106', 'lee@matamatacontractors.example', 10.50, 20, 8000, (select id from terminals where name = 'Wiri Terminal')),
    ('C107', 'Pukekohe Growers', 'farm', 'Mei Chen', '021 400 107', 'mei@pukekohegrowers.example', 13.00, 20, 25000, (select id from terminals where name = 'Wiri Terminal')),
    ('C108', 'Riverbend Golf Club', 'commercial', 'Gary Holt', '021 400 108', 'manager@riverbendgolf.example', 16.00, 20, 6000, (select id from terminals where name = 'Wiri Terminal'));

  insert into sites (customer_id, name, address, region, access_notes) values
    ((select id from customers where code = 'C101'), 'Home farm', '412 Waikeria Road', 'Waikato', 'Gate code 4410. Tanks behind the implement shed.'),
    ((select id from customers where code = 'C101'), 'Runoff block', 'Kakepuku Road', 'Waikato', null),
    ((select id from customers where code = 'C102'), 'Woolshed', '88 Kauri Ridge Road', 'Waikato', 'Ring Jo before crossing the ford.'),
    ((select id from customers where code = 'C103'), 'Tauriko depot', '15 Belk Road', 'Bay of Plenty', 'Fill point on the east wall. Depot open 5am to 7pm.'),
    ((select id from customers where code = 'C103'), 'Hamilton yard', '9 Kahikatea Drive', 'Waikato', null),
    ((select id from customers where code = 'C104'), 'Cambridge expressway job', 'SH1 site office, Cambridge', 'Waikato', 'Site induction required. Hi-vis and boots.'),
    ((select id from customers where code = 'C105'), 'Marina fuel berth', 'Sulphur Point', 'Bay of Plenty', 'Spill kit at the berth. Deliver before 9am.'),
    ((select id from customers where code = 'C106'), 'Yard', '3 Firth Street', 'Waikato', null),
    ((select id from customers where code = 'C107'), 'Packhouse', '201 Bombay Road', 'Auckland', null),
    ((select id from customers where code = 'C108'), 'Maintenance shed', '1 Riverbend Drive', 'Waikato', null);

  -- tank_no, site, product, capacity, keep_full, telemetry, use per day, certificate
  insert into tanks (site_id, product_id, tank_no, capacity_l, keep_full, telemetry, avg_daily_use_l, certificate_required, certificate_ref, certificate_expires_on)
  select s.id, p.id, v.tank_no, v.cap, v.keep_full, v.tele, v.use, v.cert_req, v.cert_ref, v.cert_exp
  from (values
    ('Home farm', 'DSL', 'T1', 10000, true, false, 260, true, 'LCC-22841', current_date + 210),
    ('Home farm', 'ULP91', 'T2', 2000, false, false, 25, false, null::text, null::date),
    ('Runoff block', 'DSL', 'T1', 5000, true, false, 120, true, 'LCC-22842', current_date - 12),
    ('Woolshed', 'DSL', 'T1', 6000, true, false, 190, true, 'LCC-30117', current_date + 95),
    ('Tauriko depot', 'DSL', 'D1', 50000, true, true, 4200, true, 'LCC-18820', current_date + 300),
    ('Tauriko depot', 'DSL', 'D2', 30000, true, true, 2100, true, 'LCC-18821', current_date + 300),
    ('Hamilton yard', 'DSL', 'Y1', 20000, false, false, 900, true, 'LCC-19477', current_date + 40),
    ('Cambridge expressway job', 'DSL', 'S1', 15000, true, false, 1300, true, null, null),
    ('Marina fuel berth', 'DSL', 'M1', 20000, true, true, 650, true, 'LCC-27731', current_date + 150),
    ('Marina fuel berth', 'PULP95', 'M2', 10000, true, true, 380, true, 'LCC-27732', current_date + 150),
    ('Yard', 'DSL', 'T1', 8000, false, false, 300, true, 'LCC-31002', current_date + 60),
    ('Packhouse', 'DSL', 'P1', 8000, true, false, 240, true, 'LCC-24410', current_date + 25),
    ('Maintenance shed', 'ULP91', 'G1', 2500, false, false, 30, false, null, null),
    ('Maintenance shed', 'DSL', 'G2', 2500, false, false, 45, false, null, null)
  ) as v(site, product, tank_no, cap, keep_full, tele, use, cert_req, cert_ref, cert_exp)
  join sites s on s.name = v.site
  join products p on p.code = v.product;

  insert into drivers (name, phone, licence_class, dg_endorsement_expires_on) values
    ('Aroha Tane', '027 500 201', 'Class 5 with D endorsement', current_date + 400),
    ('Mike Dawson', '027 500 202', 'Class 5 with D endorsement', current_date - 10),
    ('Priya Nair', '027 500 203', 'Class 4 with D endorsement', current_date + 180);

  insert into trucks (rego, name, dg_vehicle_expires_on, meter_ref, meter_certified_until) values
    ('KMF101', 'Rigid tanker 101', current_date + 120, 'MTR-101', current_date + 200),
    ('KMF202', 'Truck and trailer 202', current_date + 75, 'MTR-202', current_date - 5);

  insert into compartments (truck_id, comp_no, capacity_l)
  select tr.id, v.n, v.cap from (values
    ('KMF101', 1, 6000), ('KMF101', 2, 5000), ('KMF101', 3, 4000), ('KMF101', 4, 3000),
    ('KMF202', 1, 9000), ('KMF202', 2, 8000), ('KMF202', 3, 7000), ('KMF202', 4, 7000), ('KMF202', 5, 5000), ('KMF202', 6, 2000)
  ) as v(rego, n, cap) join trucks tr on tr.rego = v.rego;

  -- 60 days of history, one tank at a time: use, dips, and a delivery whenever a tank falls below reorder.
  for t in
    select tk2.*, s.name as site_name, c.margin_cpl, c.home_terminal_id, c.code as cust_code,
      row_number() over (order by c.code, tk2.tank_no) as n
    from tanks tk2 join sites s on s.id = tk2.site_id join customers c on c.id = s.customer_id
  loop
    lvl := floor(t.capacity_l * t.safe_fill_pct / 100.0) * 0.7;
    for day_i in reverse 60..1 loop
      d := current_date - day_i;
      use_today := t.avg_daily_use_l * (1 + ((((day_i + t.n) * 5) % 9) - 4) * 0.06);
      -- Pukekohe's packhouse started using 45 per cent more a fortnight ago: a leak, or a new machine nobody mentioned.
      if t.cust_code = 'C107' and day_i <= 14 then
        use_today := use_today * 1.45;
      end if;
      if t.cust_code = 'C103' and extract(isodow from d) >= 6 then
        use_today := use_today * 0.4;
      end if;
      lvl := greatest(0, lvl - use_today);
      -- Deliveries: below reorder, except the two tanks we let run down to show the forecast working.
      if lvl < t.capacity_l * t.reorder_pct / 100.0
         and extract(isodow from d) <= 5
         and not ((t.cust_code = 'C102' and day_i <= 14) or (t.cust_code = 'C107' and day_i <= 4))
         and not (t.cust_code = 'C104' and day_i <= 20) then
        v_litres := (floor((floor(t.capacity_l * t.safe_fill_pct / 100.0) - lvl) / 100) * 100)::int;
        if v_litres > 0 then
          select tgp_cpl into price from terminal_prices
            where terminal_id = t.home_terminal_id and product_id = t.product_id and effective_on <= d
            order by effective_on desc limit 1;
          del_n := del_n + 1;
          insert into deliveries (ref, tank_id, product_id, delivered_on, litres, before_litres, after_litres, tgp_cpl, price_cpl, docket_no, signed_by)
          values ('DEL-' || del_n, t.id, t.product_id, d, v_litres, round(lvl), round(lvl) + v_litres, price, price + t.margin_cpl,
                  case when del_n % 23 = 0 then null else 'DK' || (50000 + del_n) end,
                  case when t.keep_full then 'Unattended (keep full)' else 'Site contact' end);
          lvl := lvl + v_litres;
          insert into dips (tank_id, dipped_on, litres, source, by_name) values (t.id, d, round(lvl), 'driver', 'Driver after delivery');
        end if;
      end if;
      -- Dips: telemetry daily, keep-full tanks every 4 days, the rest weekly. One tank stops being dipped 20 days ago.
      if (t.telemetry or (t.keep_full and (day_i + t.n) % 4 = 0) or (not t.keep_full and (day_i + t.n) % 7 = 0))
         and not (t.cust_code = 'C104' and day_i <= 20) then
        insert into dips (tank_id, dipped_on, litres, water_mm, source, by_name)
        values (t.id, d, round(lvl),
                case when t.cust_code = 'C105' and t.tank_no = 'M1' and day_i = 1 then 18 else 0 end,
                case when t.telemetry then 'telemetry' else 'customer' end,
                case when t.telemetry then 'Level sensor' else 'Customer' end);
      end if;
    end loop;
  end loop;

  -- Group the history into runs: one run a day per truck, liftings at the home terminal.
  for r in select delivered_on, (select id from terminals where name = 'Wiri Terminal') as wiri from deliveries group by delivered_on order by delivered_on loop
    run_n := run_n + 1;
    tk := (select id from trucks where rego = case when (select sum(litres) from deliveries where delivered_on = r.delivered_on) > 18000 then 'KMF202' else 'KMF101' end);
    dr := (select id from drivers where name = case
            when r.delivered_on = current_date - 5 or r.delivered_on = current_date - 4 then 'Mike Dawson'
            when extract(day from r.delivered_on)::int % 2 = 0 then 'Aroha Tane' else 'Priya Nair' end);
    insert into runs (ref, run_on, truck_id, driver_id, terminal_id, status)
    values ('RUN-' || run_n, r.delivered_on, tk, dr, r.wiri, 'completed') returning id into rid;
    update deliveries set run_id = rid where delivered_on = r.delivered_on;
    insert into liftings (run_id, product_id, litres, bol_ref, lifted_on)
    select rid, product_id,
      sum(litres) + case when run_n % 5 = 0 then 18 when run_n % 7 = 0 then -12 else 4 end,
      case when run_n = 4007 then null else 'BOL-' || (700000 + run_n * 10) || '-' || product_id::text::char(4) end,
      r.delivered_on
    from deliveries where run_id = rid group by product_id;
  end loop;

  -- The run three working days ago lost diesel: 0.9 per cent more lifted than delivered, nobody has explained it.
  update liftings set litres = round(litres * 1.009)
  where run_id = (select id from runs where run_on <= current_date - 3 and status = 'completed' order by run_on desc limit 1)
    and product_id = (select id from products where code = 'DSL');

  -- Invoices and payments: invoiced the day after delivery; paid when due, except Matamata Contractors and the golf club.
  update deliveries dv set invoice_no = 'INV-' || substr(dv.ref, 5)
  where dv.delivered_on < current_date;
  update deliveries dv set paid_on = dv.delivered_on + c.terms_days - 2
  from tanks tq join sites s on s.id = tq.site_id join customers c on c.id = s.customer_id
  where tq.id = dv.tank_id and dv.delivered_on + c.terms_days - 2 < current_date and c.code not in ('C106', 'C108');

  -- Today: a loaded run to the depot and the marina, two orders on it, the tanker filled at the terminal.
  run_n := run_n + 1;
  insert into runs (ref, run_on, truck_id, driver_id, terminal_id, status)
  values ('RUN-' || run_n, current_date, (select id from trucks where rego = 'KMF101'), (select id from drivers where name = 'Aroha Tane'),
          (select id from terminals where name = 'Mount Maunganui Terminal'), 'loaded') returning id into rid;
  insert into orders (ref, tank_id, litres_requested, required_on, source, run_id, planned_litres, status)
  select 'ORD-7001', tk2.id, 9000, current_date, 'phone', rid, 9000, 'planned'
  from tanks tk2 join sites s on s.id = tk2.site_id where s.name = 'Tauriko depot' and tk2.tank_no = 'D2';
  insert into orders (ref, tank_id, litres_requested, required_on, source, run_id, planned_litres, status)
  select 'ORD-7002', tk2.id, null, current_date, 'keep_full', rid, 5000, 'planned'
  from tanks tk2 join sites s on s.id = tk2.site_id where s.name = 'Marina fuel berth' and tk2.tank_no = 'M2';
  insert into liftings (run_id, product_id, litres, bol_ref, lifted_on) values
    (rid, (select id from products where code = 'DSL'), 9000, 'BOL-' || (700000 + run_n * 10) || '-D', current_date),
    (rid, (select id from products where code = 'PULP95'), 5000, 'BOL-' || (700000 + run_n * 10) || '-P', current_date);

  -- Open orders: one late, two for tomorrow.
  insert into orders (ref, tank_id, litres_requested, required_on, source, po_number)
  select 'ORD-7003', tk2.id, 6000, current_date - 2, 'email', 'PO-55120'
  from tanks tk2 join sites s on s.id = tk2.site_id where s.name = 'Yard' and tk2.tank_no = 'T1';
  insert into orders (ref, tank_id, litres_requested, required_on, source)
  select 'ORD-7004', tk2.id, null, current_date + 1, 'phone'
  from tanks tk2 join sites s on s.id = tk2.site_id where s.name = 'Hamilton yard' and tk2.tank_no = 'Y1';
  insert into orders (ref, tank_id, litres_requested, required_on, source)
  select 'ORD-7005', tk2.id, 1500, current_date + 1, 'phone'
  from tanks tk2 join sites s on s.id = tk2.site_id where s.name = 'Maintenance shed' and tk2.tank_no = 'G2';

  insert into notes (target_kind, target_id, target_label, body)
  select 'customer', id, name, 'Asked for the price on a 20,000 L tank for the new workshop. Wants a quote by Friday.' from customers where code = 'C104';
end
$seed$;
