create table if not exists meta (
  id int primary key check (id = 1),
  version bigint not null
);
insert into meta (id, version)
values (1, 0) on conflict do nothing;
-- change_log rows at or below this version are compacted away; older cookies need a full resync.
alter table meta add column if not exists min_retained_version bigint not null default 0;
create table if not exists entries (
  key text collate "C" primary key,
  value jsonb not null,
  scope text not null default '',
  version bigint not null
);
create table if not exists change_log (
  version bigint not null,
  key text collate "C" not null,
  scope text not null,
  op text not null check (op in ('put', 'del')),
  value jsonb,
  primary key (version, key, scope)
);
create index if not exists change_log_scope_version on change_log (scope, version);
create table if not exists clients (
  client_id text primary key,
  user_id text not null,
  last_mutation_id bigint not null default 0
);