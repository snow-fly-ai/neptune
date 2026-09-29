-- Per-agent pause from the desktop bridge, and each agent's plan usage for the phone.

-- Paused agents stay online but don't pick up work; their queue waits.
alter table public.agents add column paused boolean not null default false;

-- Latest plan-limit snapshot the CLI reported, e.g.
-- { "windows": [{ "id": "five_hour", "label": "5-hour", "pct": 64, "resets_at": "…" }], "status": "allowed", "at": "…" }
alter table public.agents add column usage jsonb;

create or replace function public.guard_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowed_users where lower(email) = lower(new.email)) then
    raise exception 'This email is not allowed to use Nebula';
  end if;
  return new;
end $$;
