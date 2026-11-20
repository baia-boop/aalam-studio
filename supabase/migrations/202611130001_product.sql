-- Run with the Supabase SQL editor/migration CLI before enabling cloud features.
create table public.user_libraries (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2000000),
  revision bigint not null default 1 check (revision > 0)
);
alter table public.user_libraries enable row level security;
create policy "Own library read" on public.user_libraries for select to authenticated using ((select auth.uid()) = user_id);
create policy "Own library insert" on public.user_libraries for insert to authenticated with check ((select auth.uid()) = user_id and revision = 1);
create policy "Own library update" on public.user_libraries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.user_libraries from authenticated;
grant select, insert, update on public.user_libraries to authenticated;
revoke all on public.user_libraries from anon;

create table public.playback_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  media_type text not null check (media_type in ('movie', 'tv')),
  media_id text not null check (length(media_id) between 1 and 100),
  source text not null check (length(source) between 1 and 80),
  season integer check (season between 1 and 10000),
  episode integer check (episode between 1 and 100000),
  issue text not null check (issue in ('not_loading', 'buffering', 'wrong_title', 'audio_subtitles', 'other')),
  notes text not null default '' check (length(notes) <= 1000),
  created_at timestamptz not null default now()
);
alter table public.playback_reports enable row level security;
-- No browser read access: reports are reviewed through the operator's Supabase dashboard.
create policy "Submit own report" on public.playback_reports for insert to authenticated with check ((select auth.uid()) = user_id);
revoke all on public.playback_reports from authenticated;
grant insert on public.playback_reports to authenticated;
revoke all on public.playback_reports from anon;

-- Per-account throttling is enforced in the database, not just in the UI.
create function public.limit_playback_reports() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  if (select count(*) from public.playback_reports where user_id = new.user_id and created_at > now() - interval '1 minute') >= 1 then
    raise exception 'Please wait a minute between reports';
  end if;
  return new;
end;
$$;
revoke all on function public.limit_playback_reports() from public;
create trigger playback_report_throttle before insert on public.playback_reports for each row execute function public.limit_playback_reports();

create function public.enforce_library_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.user_id <> old.user_id or new.revision <> old.revision + 1 then
    raise exception 'Library revision must advance by one and owner cannot change';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_library_revision() from public;
create trigger library_revision_guard before update on public.user_libraries for each row execute function public.enforce_library_revision();
