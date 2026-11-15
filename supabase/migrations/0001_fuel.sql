-- Fuel Distribution for Claude Code: the schema.
--
-- A fuel and lubricant distributor's record: the terminals it lifts from and
-- their posted terminal gate prices, the customers and the tanks on their sites,
-- the dips that say how full each tank is, the orders, the tankers and their
-- compartments, the drivers, the runs (one truck, one driver, one day), the
-- liftings at the terminal and the deliveries into each tank.
--
-- Plain Postgres. Runs on any Postgres and on PGlite. No extensions.
-- Volumes are litres. Prices are cents per litre excluding GST, the way a
-- terminal gate price is posted. Money totals are dollars, numeric(12,2).

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create table settings (
  key text primary key,
  value text not null
);

create table products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  dg_class text,                       -- '3' for petrol, 'C1' combustible for diesel, null for AdBlue and oils
  un_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table terminals (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  supplier text,
  region text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table terminal_prices (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references terminals(id),
  product_id uuid not null references products(id),
  effective_on date not null,
  tgp_cpl numeric(8,2) not null check (tgp_cpl > 0),   -- terminal gate price, cents per litre ex GST
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (terminal_id, product_id, effective_on)
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  kind text not null default 'commercial' check (kind in ('farm', 'transport', 'construction', 'marine', 'depot', 'commercial', 'council')),
  contact_name text,
  phone text,
  email text,
  margin_cpl numeric(8,2) not null default 12.00,   -- price = terminal gate price + margin
  terms_days int not null default 20,
  credit_limit numeric(12,2),
  home_terminal_id uuid references terminals(id),
  status text not null default 'active' check (status in ('active', 'on_hold', 'closed')),
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sites (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  name text not null,
  address text,
  region text,
  access_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tanks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  product_id uuid not null references products(id),
  tank_no text not null,                         -- the label on the tank, unique per site
  capacity_l int not null check (capacity_l > 0),
  safe_fill_pct int not null default 95 check (safe_fill_pct between 50 and 100),
  reorder_pct int not null default 30 check (reorder_pct between 0 and 90),
  keep_full boolean not null default false,      -- we watch it and fill it without an order
  telemetry boolean not null default false,      -- a level sensor sends dips
  avg_daily_use_l int,                           -- fallback when the dips are too few to say
  certificate_required boolean not null default true,
  certificate_ref text,
  certificate_expires_on date,
  status text not null default 'active' check (status in ('active', 'decommissioned')),
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, tank_no)
);

create table dips (
  id uuid primary key default gen_random_uuid(),
  tank_id uuid not null references tanks(id),
  dipped_on date not null,
  litres int not null check (litres >= 0),
  water_mm int not null default 0 check (water_mm >= 0),
  source text not null default 'customer' check (source in ('customer', 'driver', 'telemetry', 'office')),
  by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  phone text,
  licence_class text,
  dg_endorsement_expires_on date,     -- NZ: D endorsement. AU: dangerous goods driver licence.
  status text not null default 'active' check (status in ('active', 'left')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trucks (
  id uuid primary key default gen_random_uuid(),
  rego text not null unique,
  name text,
  dg_vehicle_expires_on date,         -- NZ: certificate of fitness. AU: dangerous goods vehicle licence.
  meter_ref text,
  meter_certified_until date,         -- the delivery meter's trade certification
  status text not null default 'active' check (status in ('active', 'off_road', 'sold')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table compartments (
  id uuid primary key default gen_random_uuid(),
  truck_id uuid not null references trucks(id),
  comp_no int not null,
  capacity_l int not null check (capacity_l > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (truck_id, comp_no)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  run_on date not null,
  truck_id uuid not null references trucks(id),
  driver_id uuid not null references drivers(id),
  terminal_id uuid not null references terminals(id),
  status text not null default 'planned' check (status in ('planned', 'loaded', 'completed', 'cancelled')),
  variance_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  tank_id uuid not null references tanks(id),
  litres_requested int check (litres_requested > 0),   -- null means fill to safe fill
  required_on date not null,
  source text not null default 'phone' check (source in ('phone', 'email', 'portal', 'keep_full', 'office')),
  run_id uuid references runs(id),
  planned_litres int,
  status text not null default 'open' check (status in ('open', 'planned', 'delivered', 'cancelled')),
  po_number text,
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table liftings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  product_id uuid not null references products(id),
  litres int not null check (litres > 0),
  bol_ref text,                       -- the terminal's bill of lading: the dangerous goods transport document
  lifted_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table deliveries (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  run_id uuid references runs(id),
  order_id uuid references orders(id),
  tank_id uuid not null references tanks(id),
  product_id uuid not null references products(id),
  delivered_on date not null,
  litres int not null check (litres > 0),
  before_litres int,
  after_litres int,
  tgp_cpl numeric(8,2),               -- the terminal gate price behind it, so margin is a query
  price_cpl numeric(8,2) not null,    -- what the customer pays, cents per litre ex GST
  docket_no text,
  signed_by text,
  invoice_no text,
  paid_on date,
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table notes (
  id uuid primary key default gen_random_uuid(),
  target_kind text not null,
  target_id uuid,
  target_label text,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['products', 'terminals', 'terminal_prices', 'customers', 'sites', 'tanks', 'dips', 'drivers', 'trucks', 'compartments', 'runs', 'orders', 'liftings', 'deliveries', 'notes'] loop
    execute format('create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

create index dips_tank on dips (tank_id, dipped_on);
create index deliveries_tank on deliveries (tank_id, delivered_on);
create index deliveries_run on deliveries (run_id);
create index orders_status on orders (status, required_on);

-- ---------------------------------------------------------------------------
-- Views

-- The price a customer pays today for a product at their home terminal.
create view v_tgp_today as
select distinct on (tp.terminal_id, tp.product_id)
  tp.terminal_id, tp.product_id, tm.name as terminal, p.code as product, tp.effective_on, tp.tgp_cpl
from terminal_prices tp
join terminals tm on tm.id = tp.terminal_id
join products p on p.id = tp.product_id
where tp.effective_on <= current_date
order by tp.terminal_id, tp.product_id, tp.effective_on desc;

-- How much each tank used between consecutive dips, allowing for what we put in.
create view v_tank_use as
with d as (
  select dp.tank_id, dp.dipped_on, dp.litres,
    lag(dp.dipped_on) over (partition by dp.tank_id order by dp.dipped_on, dp.created_at) as prev_on,
    lag(dp.litres) over (partition by dp.tank_id order by dp.dipped_on, dp.created_at) as prev_litres
  from dips dp
)
select d.tank_id, d.prev_on, d.dipped_on, d.dipped_on - d.prev_on as days,
  d.prev_litres + coalesce((select sum(dv.litres) from deliveries dv where dv.tank_id = d.tank_id and dv.delivered_on > d.prev_on and dv.delivered_on <= d.dipped_on), 0) - d.litres as used_l
from d
where d.prev_on is not null and d.dipped_on > d.prev_on;

-- Every tank with its estimated level today and the days to reorder and to empty.
create view v_tanks as
with last_dip as (
  select distinct on (tank_id) tank_id, dipped_on, litres, water_mm, source
  from dips order by tank_id, dipped_on desc, created_at desc
),
rate as (
  select tank_id, sum(used_l)::numeric / nullif(sum(days), 0) as per_day
  from v_tank_use where dipped_on > current_date - 60 and used_l >= 0
  group by tank_id
),
since as (
  select t.id as tank_id, coalesce(sum(dv.litres), 0) as delivered_l
  from tanks t
  left join last_dip ld on ld.tank_id = t.id
  left join deliveries dv on dv.tank_id = t.id and dv.delivered_on > coalesce(ld.dipped_on, date '1900-01-01')
  group by t.id
),
base as (
  select t.id as tank_id, t.tank_no, t.capacity_l, t.safe_fill_pct, t.reorder_pct, t.keep_full, t.telemetry, t.status,
    t.certificate_required, t.certificate_ref, t.certificate_expires_on,
    s.id as site_id, s.name as site, s.region, c.id as customer_id, c.name as customer, c.status as customer_status,
    p.id as product_id, p.code as product,
    ld.dipped_on as last_dip_on, ld.litres as last_dip_l, ld.water_mm, ld.source as dip_source,
    round(coalesce(r.per_day, t.avg_daily_use_l, 0)) as use_per_day,
    (r.per_day is not null) as rate_from_dips,
    floor(t.capacity_l * t.safe_fill_pct / 100.0)::int as safe_fill_l,
    floor(t.capacity_l * t.reorder_pct / 100.0)::int as reorder_l,
    sn.delivered_l
  from tanks t
  join sites s on s.id = t.site_id
  join customers c on c.id = s.customer_id
  join products p on p.id = t.product_id
  left join last_dip ld on ld.tank_id = t.id
  left join rate r on r.tank_id = t.id
  left join since sn on sn.tank_id = t.id
)
select b.*,
  case when b.last_dip_on is null then null
       else greatest(0, least(b.capacity_l, b.last_dip_l + b.delivered_l - b.use_per_day * (current_date - b.last_dip_on)))::int end as est_l,
  current_date - b.last_dip_on as dip_age_days
from base b;

create view v_runout as
select v.*,
  case when v.est_l is null or v.use_per_day <= 0 then null else round((v.est_l - v.reorder_l)::numeric / v.use_per_day, 1) end as days_to_reorder,
  case when v.est_l is null or v.use_per_day <= 0 then null else round(v.est_l::numeric / v.use_per_day, 1) end as days_to_empty,
  greatest(0, v.safe_fill_l - coalesce(v.est_l, 0)) as room_l,
  round(100.0 * coalesce(v.est_l, 0) / v.capacity_l) as pct_full,
  exists (select 1 from orders o where o.tank_id = v.tank_id and o.status in ('open', 'planned')) as on_order
from v_tanks v
where v.status = 'active';

create view v_deliveries as
select dv.id as delivery_id, dv.ref, dv.delivered_on, dv.litres, dv.tgp_cpl, dv.price_cpl,
  round(dv.litres * dv.price_cpl / 100.0, 2) as value_ex_gst,
  round(dv.litres * (dv.price_cpl - coalesce(dv.tgp_cpl, dv.price_cpl)) / 100.0, 2) as margin,
  dv.docket_no, dv.signed_by, dv.invoice_no, dv.paid_on, dv.before_litres, dv.after_litres,
  t.id as tank_id, t.tank_no, t.capacity_l, floor(t.capacity_l * t.safe_fill_pct / 100.0)::int as safe_fill_l,
  s.name as site, c.id as customer_id, c.name as customer, c.terms_days, p.code as product,
  r.ref as run_ref, tr.rego, dr.name as driver, o.ref as order_ref,
  dv.delivered_on + c.terms_days as due_on
from deliveries dv
join tanks t on t.id = dv.tank_id
join sites s on s.id = t.site_id
join customers c on c.id = s.customer_id
join products p on p.id = dv.product_id
left join runs r on r.id = dv.run_id
left join trucks tr on tr.id = r.truck_id
left join drivers dr on dr.id = r.driver_id
left join orders o on o.id = dv.order_id;

-- Loaded at the terminal against delivered into tanks, per run and product.
create view v_reconcile as
with l as (select run_id, product_id, sum(litres) as loaded_l, count(*) filter (where bol_ref is null or bol_ref = '') as no_bol from liftings group by run_id, product_id),
d as (select run_id, product_id, sum(litres) as delivered_l from deliveries where run_id is not null group by run_id, product_id),
k as (select run_id, product_id from l union select run_id, product_id from d)
select r.id as run_id, r.ref as run_ref, r.run_on, r.status, r.variance_note, tr.rego, dr.name as driver, p.code as product,
  coalesce(l.loaded_l, 0) as loaded_l, coalesce(d.delivered_l, 0) as delivered_l,
  coalesce(l.loaded_l, 0) - coalesce(d.delivered_l, 0) as variance_l,
  case when coalesce(l.loaded_l, 0) = 0 then null else round(100.0 * (coalesce(l.loaded_l, 0) - coalesce(d.delivered_l, 0)) / l.loaded_l, 2) end as variance_pct,
  coalesce(l.no_bol, 0) as liftings_without_bol
from k
join runs r on r.id = k.run_id
join trucks tr on tr.id = r.truck_id
join drivers dr on dr.id = r.driver_id
join products p on p.id = k.product_id
left join l on l.run_id = k.run_id and l.product_id = k.product_id
left join d on d.run_id = k.run_id and d.product_id = k.product_id;

create view v_debtors as
select c.id as customer_id, c.name as customer, c.status, c.credit_limit, c.terms_days,
  coalesce(sum(d.value_ex_gst) filter (where d.paid_on is null), 0) as owed_ex_gst,
  coalesce(sum(d.value_ex_gst) filter (where d.paid_on is null and d.due_on < current_date), 0) as overdue_ex_gst,
  coalesce(sum(d.value_ex_gst) filter (where d.paid_on is null and d.due_on < current_date - 30), 0) as over_30_ex_gst,
  coalesce(max(current_date - d.due_on) filter (where d.paid_on is null and d.due_on < current_date), 0) as oldest_overdue_days
from customers c
left join v_deliveries d on d.customer_id = c.id
group by c.id;

-- Everything that wants a decision. One row per item; the CLI orders them worst first.
create view v_attention as
select 'runout' as reason, r.customer || ' / ' || r.site || ' / ' || r.product || ' ' || r.tank_no as label, r.customer as who,
  'about ' || r.est_l || ' L left, ' || r.days_to_empty || ' days to empty, nothing on order' as detail, r.days_to_empty as days
from v_runout r where r.days_to_empty is not null and r.days_to_empty <= 3 and not r.on_order and r.customer_status = 'active'
union all
select 'certificate_expired', t.customer || ' / ' || t.site || ' / ' || t.tank_no, t.customer,
  case when t.certificate_expires_on is null then 'no tank certificate on file' else 'tank certificate expired ' || t.certificate_expires_on end, current_date - coalesce(t.certificate_expires_on, current_date)
from v_tanks t where t.status = 'active' and t.certificate_required and (t.certificate_expires_on is null or t.certificate_expires_on < current_date)
union all
select 'driver_dg_expired', d.name, d.name, 'dangerous goods endorsement expired ' || d.dg_endorsement_expires_on, current_date - d.dg_endorsement_expires_on
from drivers d where d.status = 'active' and (d.dg_endorsement_expires_on is null or d.dg_endorsement_expires_on < current_date)
union all
select 'truck_expired', tr.rego, coalesce(tr.name, tr.rego),
  case when tr.dg_vehicle_expires_on < current_date then 'vehicle certificate expired ' || tr.dg_vehicle_expires_on else 'meter certification lapsed ' || tr.meter_certified_until end,
  current_date - least(coalesce(tr.dg_vehicle_expires_on, current_date), coalesce(tr.meter_certified_until, current_date))
from trucks tr where tr.status = 'active' and (tr.dg_vehicle_expires_on < current_date or tr.meter_certified_until < current_date)
union all
select 'water', t.customer || ' / ' || t.site || ' / ' || t.tank_no, t.customer, t.water_mm || ' mm of water on the last dip (' || t.last_dip_on || ')', t.dip_age_days
from v_tanks t where t.status = 'active' and t.water_mm > 10
union all
select 'order_late', o.ref, c.name, 'required ' || o.required_on || ', still ' || o.status, current_date - o.required_on
from orders o join tanks t on t.id = o.tank_id join sites s on s.id = t.site_id join customers c on c.id = s.customer_id
where o.status in ('open', 'planned') and o.required_on < current_date
union all
select 'variance', v.run_ref || ' ' || v.product, v.driver, v.loaded_l || ' L loaded, ' || v.delivered_l || ' L delivered (' || v.variance_pct || '%)', current_date - v.run_on
from v_reconcile v where v.status = 'completed' and abs(coalesce(v.variance_pct, 0)) > 0.5 and v.variance_note is null
union all
select 'debtor', d.customer, d.customer, '$' || d.owed_ex_gst || ' ex GST owed, $' || d.overdue_ex_gst || ' overdue, oldest ' || d.oldest_overdue_days || ' days late' || case when d.credit_limit is not null and d.owed_ex_gst > d.credit_limit then ', over its $' || d.credit_limit || ' limit' else '' end, d.oldest_overdue_days
from v_debtors d where d.over_30_ex_gst > 0 or (d.credit_limit is not null and d.owed_ex_gst > d.credit_limit)
union all
select 'dip_stale', t.customer || ' / ' || t.site || ' / ' || t.tank_no, t.customer,
  case when t.last_dip_on is null then 'never dipped' else 'last dip ' || t.dip_age_days || ' days ago, the forecast is guessing' end, coalesce(t.dip_age_days, 999)
from v_tanks t where t.status = 'active' and t.keep_full and (t.last_dip_on is null or t.dip_age_days > 14)
union all
select 'no_price', tm.name || ' ' || p.code, tm.name, 'no terminal gate price posted for today', null
from terminals tm cross join products p
where exists (select 1 from terminal_prices x where x.terminal_id = tm.id and x.product_id = p.id)
  and not exists (select 1 from terminal_prices x where x.terminal_id = tm.id and x.product_id = p.id and x.effective_on = current_date);

-- Row level security on: nothing is exposed until the operator writes a policy.
do $$
declare t text;
begin
  foreach t in array array['settings', 'products', 'terminals', 'terminal_prices', 'customers', 'sites', 'tanks', 'dips', 'drivers', 'trucks', 'compartments', 'runs', 'orders', 'liftings', 'deliveries', 'notes'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
