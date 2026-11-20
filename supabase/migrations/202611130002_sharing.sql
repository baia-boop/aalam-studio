-- Explicitly published snapshots only. Never expose user_libraries or auth metadata.
create function public.valid_share_payload(p jsonb, k text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare i jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'name') is distinct from 'string' or length(trim(p->>'name')) not between 1 and 80 or jsonb_typeof(p->'bio') is distinct from 'string' or length(p->>'bio') > 500 then return false; end if;
  if k = 'profile' then return p - array['name','bio'] = '{}'::jsonb; end if;
  if k <> 'collection' or p - array['name','bio','items'] <> '{}'::jsonb or jsonb_typeof(p->'items') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p->'items') not between 1 and 30 then return false; end if;
  for i in select value from jsonb_array_elements(p->'items') loop
    if jsonb_typeof(i) is distinct from 'object' or i - array['id','type','title','year'] <> '{}'::jsonb or jsonb_typeof(i->'id') is distinct from 'string' or (i->>'id') !~ '^[a-zA-Z0-9_-]{1,80}$' or jsonb_typeof(i->'type') is distinct from 'string' or (i->>'type') not in ('movie','tv') or jsonb_typeof(i->'title') is distinct from 'string' or length(i->>'title') not between 1 and 160 or jsonb_typeof(i->'year') is distinct from 'string' or length(i->>'year') > 10 then return false; end if;
  end loop;
  return true;
end;
$$;
create table public.shared_pages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('profile','collection')),
  payload jsonb not null,
  published boolean not null default false,
  constraint valid_public_snapshot check (public.valid_share_payload(payload, kind))
);
create unique index one_profile_per_owner on public.shared_pages(user_id) where kind = 'profile';
alter table public.shared_pages enable row level security;
revoke all on public.shared_pages from anon, authenticated;
grant select, insert, update, delete on public.shared_pages to authenticated;
create policy "Owners manage pages" on public.shared_pages for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Deliberately definer-owned, security-barrier projection: only these four public
-- fields from explicitly published rows are readable; no owner IDs or drafts.
create view public.published_pages with (security_barrier = true) as
  select id, kind, payload from public.shared_pages where published = true;
revoke all on public.published_pages from public, anon, authenticated;
grant select on public.published_pages to anon, authenticated;

create function public.limit_shared_pages() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.kind <> old.kind or new.id <> old.id) then raise exception 'Page identity cannot change'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 3));
  if tg_op = 'INSERT' and new.kind = 'collection' and (select count(*) from public.shared_pages where user_id = new.user_id and kind = 'collection') >= 20 then raise exception 'Maximum 20 collections'; end if;
  return new;
end;
$$;
revoke all on function public.limit_shared_pages() from public;
create trigger shared_page_limits before insert or update on public.shared_pages for each row execute function public.limit_shared_pages();
