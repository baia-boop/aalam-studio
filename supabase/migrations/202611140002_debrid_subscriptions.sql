-- AALAM Premium access for Torrentio + Real-Debrid playback.
-- Subscription writes are operator/payment-backend only; clients can read only their own rows.
create table public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null check (product in ('debrid')),
  status text not null check (status in ('pending', 'active', 'expired', 'cancelled', 'refunded')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at)
);

create index user_subscriptions_entitlement_lookup
  on public.user_subscriptions (user_id, product, status, expires_at);

alter table public.user_subscriptions enable row level security;
create policy "Users read own subscriptions"
  on public.user_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.user_subscriptions from anon, authenticated;
grant select on public.user_subscriptions to authenticated;

comment on table public.user_subscriptions is
  'AALAM Premium entitlements. Payment processors/operators provision rows server-side; never accept subscription status from the browser.';
