-- CineMatch backend: interaction telemetry + collaborative candidates.
-- Apply after 202611130001_product.sql and 202611130002_sharing.sql.

create table public.user_interactions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tmdb_id integer not null check (tmdb_id between 1 and 100000000),
  media_type text not null check (media_type in ('movie', 'tv')),
  event_type text not null check (event_type in ('view', 'watch', 'like', 'dislike', 'clear', 'watchlist', 'onboarding')),
  weight real not null check (weight between -1 and 1),
  progress real check (progress between 0 and 1),
  position smallint check (position between 0 and 500),
  source text check (source ~ '^[a-z0-9:_-]{1,48}$'),
  created_at timestamptz not null default now()
);

create index user_interactions_user_recent on public.user_interactions (user_id, created_at desc);
create index user_interactions_title on public.user_interactions (media_type, tmdb_id) where weight >= 0.5;

alter table public.user_interactions enable row level security;
create policy "Own interactions read" on public.user_interactions for select to authenticated using ((select auth.uid()) = user_id);
create policy "Own interactions insert" on public.user_interactions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Own interactions delete" on public.user_interactions for delete to authenticated using ((select auth.uid()) = user_id);
-- History is append-only: no update policy and no update grant.
revoke all on public.user_interactions from authenticated;
grant select, insert, delete on public.user_interactions to authenticated;
revoke all on public.user_interactions from anon;

-- Server-assigned timestamps (no back-dating) and a per-account write budget
-- that holds even for clients talking to PostgREST directly.
create function public.guard_user_interactions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  perform pg_advisory_xact_lock(hashtextextended('cm:' || new.user_id::text, 0));
  if (select count(*) from public.user_interactions
      where user_id = new.user_id and created_at > now() - interval '10 minutes') >= 600 then
    raise exception 'Too many events, please wait' using errcode = 'P0429';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_user_interactions() from public;
create trigger user_interactions_guard before insert on public.user_interactions
  for each row execute function public.guard_user_interactions();

-- Item-to-item collaborative filtering for the calling user.
--
-- Privacy: the function runs as definer but only ever returns aggregate
-- (tmdb_id, media_type, score) rows, each backed by at least three distinct
-- peers, and never titles the caller has already interacted with. No user id
-- or per-user data leaves the database.
create function public.cinematch_collaborative(p_limit integer default 40)
returns table (tmdb_id integer, media_type text, score double precision)
language sql stable security definer set search_path = '' as $$
  with me as (
    select auth.uid() as id
  ),
  my_latest as (
    select distinct on (i.media_type, i.tmdb_id) i.media_type, i.tmdb_id, i.weight
    from public.user_interactions i, me
    where i.user_id = me.id and i.event_type <> 'view'
    order by i.media_type, i.tmdb_id, i.created_at desc, i.id desc
  ),
  mine as (
    select l.media_type, l.tmdb_id from my_latest l where l.weight >= 0.5
  ),
  overlap as (
    select distinct i.user_id, i.media_type, i.tmdb_id
    from public.user_interactions i
    join mine m on m.media_type = i.media_type and m.tmdb_id = i.tmdb_id, me
    where i.user_id <> me.id and i.weight >= 0.5 and i.created_at > now() - interval '365 days'
  ),
  candidate_peers as (
    select o.user_id, count(*) as shared from overlap o group by o.user_id having count(*) >= 2
    order by count(*) desc limit 200
  ),
  peer_latest as (
    select distinct on (i.user_id, i.media_type, i.tmdb_id) i.user_id, i.media_type, i.tmdb_id, i.weight
    from public.user_interactions i
    join candidate_peers c on c.user_id = i.user_id
    where i.event_type <> 'view' and i.created_at > now() - interval '365 days'
    order by i.user_id, i.media_type, i.tmdb_id, i.created_at desc, i.id desc
  ),
  peer_positive as (
    select * from peer_latest where weight >= 0.5
  ),
  peers as (
    -- Binary cosine similarity between positive sets.
    select c.user_id,
           c.shared::float8 / sqrt(greatest((select count(*) from peer_positive p where p.user_id = c.user_id), 1)::float8
                                   * greatest((select count(*) from mine), 1)::float8) as sim
    from candidate_peers c
    order by sim desc
    limit 50
  )
  select p.tmdb_id, p.media_type, sum(pe.sim) as score
  from peer_positive p
  join peers pe on pe.user_id = p.user_id
  where not exists (
    select 1 from public.user_interactions a, me
    where a.user_id = me.id and a.media_type = p.media_type and a.tmdb_id = p.tmdb_id
  )
  group by p.tmdb_id, p.media_type
  having count(distinct p.user_id) >= 3
  order by score desc, p.tmdb_id
  limit least(greatest(coalesce(p_limit, 40), 1), 50);
$$;
revoke all on function public.cinematch_collaborative(integer) from public;
revoke all on function public.cinematch_collaborative(integer) from anon;
grant execute on function public.cinematch_collaborative(integer) to authenticated;
