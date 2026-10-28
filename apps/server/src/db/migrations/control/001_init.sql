-- Up Migration
create extension if not exists citext;

create table tenants (
  id                 uuid primary key,
  slug               text not null unique,
  name               text not null,
  plan               text not null default 'free'
                     check (plan in ('free','pro','business','selfhost')),
  status             text not null default 'active'
                     check (status in ('active','suspended','deleted')),
  signing_secret_enc bytea not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table users (
  id            uuid primary key,
  email         citext not null unique,
  password_hash text not null,
  name          text not null,
  created_at    timestamptz not null default now()
);

create table memberships (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  role      text not null check (role in ('owner','admin','developer','viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table invitations (
  id          uuid primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  email       citext not null,
  role        text not null check (role in ('admin','developer','viewer')),
  token_hash  bytea not null unique,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_by  uuid not null references users(id)
);

create table api_keys (
  id           uuid primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  kind         text not null check (kind in ('secret','publishable')),
  name         text not null,
  prefix       text not null,
  key_hash     bytea not null unique,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now()
);
create index api_keys_tenant_idx on api_keys (tenant_id) where revoked_at is null;

create table refresh_tokens (
  id          uuid primary key,
  family_id   uuid not null,
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  bytea not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index refresh_family_idx on refresh_tokens (family_id);

create table usage_hourly (
  tenant_id uuid not null references tenants(id) on delete cascade,
  hour      timestamptz not null,
  metric    text not null check (metric in
            ('ops','bytes_written','connections_peak','docs_created','docs_active')),
  value     bigint not null,
  primary key (tenant_id, hour, metric)
);

create table usage_gauges (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  documents bigint not null default 0,
  storage_bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table invoices (
  id             uuid primary key,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  period_start   date not null,
  period_end     date not null,
  status         text not null check (status in ('draft','open','paid','void')),
  line_items     jsonb not null,
  subtotal_cents integer not null,
  total_cents    integer not null,
  created_at     timestamptz not null default now(),
  unique (tenant_id, period_start)
);

create table webhook_endpoints (
  id          uuid primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  url         text not null,
  secret_enc  bytea not null,
  events      text[] not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table webhook_deliveries (
  id              uuid primary key,
  endpoint_id     uuid not null references webhook_endpoints(id) on delete cascade,
  tenant_id       uuid not null,
  event_id        uuid not null,
  event_type      text not null,
  payload         jsonb not null,
  status          text not null check (status in ('pending','success','retrying','dead')),
  attempt         integer not null default 0,
  response_code   integer,
  error           text,
  next_attempt_at timestamptz,
  created_at      timestamptz not null default now()
);
create index webhook_deliveries_ep_idx on webhook_deliveries (endpoint_id, created_at desc);

create table audit_log (
  id         bigserial primary key,
  tenant_id  uuid not null,
  actor_type text not null check (actor_type in ('user','api_key','system')),
  actor_id   text not null,
  action     text not null,
  target     text,
  meta       jsonb not null default '{}',
  prev_hash  bytea,
  hash       bytea not null,
  created_at timestamptz not null default now()
);
create index audit_tenant_idx on audit_log (tenant_id, id);

-- Down Migration
drop table audit_log, webhook_deliveries, webhook_endpoints, invoices, usage_gauges,
  usage_hourly, refresh_tokens, api_keys, invitations, memberships, users, tenants;
