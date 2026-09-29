-- Multiple agents (Claude, Codex, …), each with any number of chats.
-- An agent is anything that heartbeats its `agents` row and works its chats' queue.

create table public.agents (
  id text primary key check (id ~ '^[a-z][a-z0-9_-]{0,31}$'),
  name text not null,
  online boolean not null default false,
  activity text,
  current_chat_id uuid,
  machine text,
  version text,
  last_seen timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.agents (id, name) values ('claude', 'Claude'), ('codex', 'Codex');
alter table public.agents enable row level security;
create policy "owner reads agents" on public.agents
  for select to authenticated using (public.is_owner());
create trigger agents_touch before update on public.agents
  for each row execute function public.touch_updated_at();

create table public.chats (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agents(id) on delete cascade,
  title text check (length(title) <= 200),
  -- The agent's own conversation id (Claude session, Codex thread), set by the runner.
  session_id text,
  preview text,
  last_sender text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chats_updated_idx on public.chats (updated_at desc);
create index chats_agent_idx on public.chats (agent_id, updated_at desc);
alter table public.chats enable row level security;
create policy "owner reads chats" on public.chats
  for select to authenticated using (public.is_owner());
create policy "owner creates chats" on public.chats
  for insert to authenticated with check (public.is_owner() and session_id is null);
create policy "owner renames chats" on public.chats
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "owner deletes chats" on public.chats
  for delete to authenticated using (public.is_owner());

alter table public.agents
  add constraint agents_current_chat_fk foreign key (current_chat_id) references public.chats(id) on delete set null;

-- Agent replies are sender 'agent'; the chat says which agent. 'claude' stays accepted
-- for bridges older than 0.3.0 and is normalized on insert.
alter table public.messages add column chat_id uuid references public.chats(id) on delete cascade;
alter table public.messages drop constraint messages_sender_check;
alter table public.messages add constraint messages_sender_check check (sender in ('user','agent','claude','system'));
update public.messages set sender = 'agent' where sender = 'claude';

-- Everything so far becomes the first Claude chat.
do $$
declare c uuid;
begin
  if exists (select 1 from public.messages) then
    insert into public.chats (agent_id, title, session_id, created_at)
    values ('claude', 'Earlier conversation', null, (select min(created_at) from public.messages))
    returning id into c;
    update public.messages set chat_id = c;
  end if;
end $$;
create index messages_chat_idx on public.messages (chat_id, created_at desc);

-- Fills chat_id for clients that predate chats: a reply joins its task's chat,
-- anything else goes to the most recent Claude chat (created if missing).
create or replace function public.messages_assign_chat() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.sender = 'claude' then new.sender := 'agent'; end if;
  if new.chat_id is null and new.reply_to is not null then
    select chat_id into new.chat_id from messages where id = new.reply_to;
  end if;
  if new.chat_id is null then
    select id into new.chat_id from chats where agent_id = 'claude' order by updated_at desc limit 1;
  end if;
  if new.chat_id is null then
    insert into chats (agent_id, title) values ('claude', 'Claude') returning id into new.chat_id;
  end if;
  return new;
end $$;
create trigger messages_assign_chat before insert on public.messages
  for each row execute function public.messages_assign_chat();

-- Keeps the chat list's preview, order and title current.
create or replace function public.messages_bump_chat() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.sender = 'user' and new.body ~ '^/(stop|new|status)$' then return new; end if;
  update chats set
    preview = left(regexp_replace(new.body, '\s+', ' ', 'g'), 160),
    last_sender = new.sender,
    title = coalesce(title, case when new.sender = 'user' then left(regexp_replace(new.body, '\s+', ' ', 'g'), 60) end),
    updated_at = now()
  where id = new.chat_id;
  return new;
end $$;
create trigger messages_bump_chat after insert on public.messages
  for each row execute function public.messages_bump_chat();

alter table public.messages alter column chat_id set not null;

-- Atomically hands the oldest queued task for an agent to its runner.
create or replace function public.claim_next_message(p_agent text) returns setof public.messages
language sql security definer set search_path = public as $$
  update messages set status = 'processing'
  where id = (
    select m.id from messages m join chats c on c.id = m.chat_id
    where m.sender = 'user' and m.status = 'queued' and c.agent_id = p_agent
    order by m.created_at
    limit 1
    for update of m skip locked
  )
  returning *;
$$;
revoke all on function public.claim_next_message(text) from public, anon, authenticated;
grant execute on function public.claim_next_message(text) to service_role;

alter table public.chats replica identity full;
alter publication supabase_realtime add table public.agents, public.chats;
