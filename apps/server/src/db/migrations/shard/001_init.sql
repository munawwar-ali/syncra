-- Up Migration
create table documents (
  uid           uuid primary key,
  tenant_id     uuid not null,
  collection    text not null,
  doc_id        text not null,
  head_seq      bigint not null default 0,
  snapshot_seq  bigint not null default 0,
  size_bytes    bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, collection, doc_id)
);
create index documents_list_idx on documents (tenant_id, collection, doc_id)
  where deleted_at is null;
create index documents_purge_idx on documents (deleted_at) where deleted_at is not null;

create table operations (
  doc_uid    uuid not null,
  seq        bigint not null,
  tenant_id  uuid not null,
  client_id  text not null,
  op_refs    text[] not null,
  update     bytea not null,
  size       integer not null,
  created_at timestamptz not null default now(),
  primary key (doc_uid, seq)
) partition by hash (doc_uid);

create index operations_refs_idx on operations using gin (op_refs);

create table op_dedup (
  doc_uid   uuid not null,
  client_id text not null,
  op_id     text not null,
  seq       bigint not null,
  created_at timestamptz not null default now(),
  primary key (doc_uid, client_id, op_id)
) partition by hash (doc_uid);

do $$
begin
  for i in 0..15 loop
    execute format(
      'create table operations_p%s partition of operations for values with (modulus 16, remainder %s)',
      i, i);
    execute format(
      'create table op_dedup_p%s partition of op_dedup for values with (modulus 16, remainder %s)',
      i, i);
  end loop;
end $$;

create table snapshots (
  doc_uid    uuid not null,
  up_to_seq  bigint not null,
  tenant_id  uuid not null,
  kind       text not null check (kind in ('compaction','checkpoint')),
  state      bytea not null,
  size       integer not null,
  created_at timestamptz not null default now(),
  primary key (doc_uid, up_to_seq)
);
create index snapshots_kind_idx on snapshots (doc_uid, kind, created_at desc);

create table document_views (
  doc_uid    uuid primary key,
  tenant_id  uuid not null,
  seq        bigint not null,
  json       jsonb not null,
  updated_at timestamptz not null default now()
);

create table changes (
  change_id  bigserial primary key,
  tenant_id  uuid not null,
  collection text not null,
  doc_id     text not null,
  kind       text not null check (kind in ('create','update','delete')),
  seq        bigint,
  created_at timestamptz not null default now()
);
create index changes_feed_idx on changes (tenant_id, collection, change_id);

-- Down Migration
drop table changes, document_views, snapshots, op_dedup, operations, documents;
