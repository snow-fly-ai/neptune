-- Several PCs ("nodes"). Each has its own operator email (the phone signs in with it)
-- and agent email (the PC's bridge signs in with it). Every agent, chat and message
-- belongs to one node, and row-level security scopes each account to its nodes:
-- the operator reads and sends, the agent runs the queue. The bridge no longer
-- holds the service key.
--
-- Existing chats and messages move onto the first node (this PC).

-- ---------- nodes ----------------------------------------------------------------
create table public.nodes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 40),
  operator_email text not null check (operator_email = lower(operator_email) and operator_email ~ '^\S+@\S+\.\S+$'),
  agent_email text not null unique check (agent_email = lower(agent_email) and agent_email ~ '^\S+@\S+\.\S+$'),
  machine text,
  created_at timestamptz not null default now(),
  check (operator_email <> agent_email)
);
create index nodes_operator_idx on public.nodes (operator_email);

-- An email is an operator or an agent, never both: RLS tells them apart by email.
create or replace function public.nodes_guard_roles() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from nodes where id <> new.id and (agent_email = new.operator_email or operator_email = new.agent_email)) then
    raise exception 'An email can be an operator or an agent, not both';
  end if;
  return new;
end $$;
create trigger nodes_guard_roles before insert or update on public.nodes
  for each row execute function public.nodes_guard_roles();

insert into public.nodes (name, operator_email, agent_email, machine)
values ('Home', 'asnqln@gmail.com', 'snowfly.ai@gmail.com', 'POLAR');

create or replace function public.my_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt()->>'email', '')) $$;

-- The phone side of a node.
create or replace function public.operates(n uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from nodes where id = n and operator_email = public.my_email());
$$;
-- The PC side of a node.
create or replace function public.runs(n uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from nodes where id = n and agent_email = public.my_email());
$$;
create or replace function public.sees(n uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from nodes where id = n and public.my_email() in (operator_email, agent_email));
$$;

alter table public.nodes enable row level security;
create policy "members read their nodes" on public.nodes
  for select to authenticated using (public.my_email() in (operator_email, agent_email));
create policy "members rename their nodes" on public.nodes
  for update to authenticated using (public.my_email() in (operator_email, agent_email));
create policy "operator removes a node" on public.nodes
  for delete to authenticated using (operator_email = public.my_email());
-- Emails only change through the pair function.
revoke update on public.nodes from authenticated, anon;
grant update (name, machine) on public.nodes to authenticated;

-- Only emails that belong to a node can ever create an account.
create or replace function public.guard_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.nodes where lower(new.email) in (operator_email, agent_email)) then
    raise exception 'This email is not allowed to use Nebula';
  end if;
  return new;
end $$;

-- ---------- move the single-PC tables aside ------------------------------------------
alter publication supabase_realtime drop table public.messages, public.chats, public.agents, public.agent_state, public.login_codes;
alter table public.messages rename to old_messages;
alter table public.chats rename to old_chats;
alter table public.agents rename to old_agents;
drop trigger if exists messages_assign_chat on public.old_messages;
drop trigger if exists messages_bump_chat on public.old_messages;
drop function if exists public.claim_next_message(text);
drop index if exists public.chats_updated_idx, public.chats_agent_idx, public.messages_created_idx, public.messages_queue_idx, public.messages_chat_idx;

-- ---------- agents -------------------------------------------------------------------
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_-]{0,31}$'),
  name text not null,
  online boolean not null default false,
  paused boolean not null default false,
  activity text,
  current_chat_id uuid,
  machine text,
  version text,
  last_seen timestamptz,
  -- Latest plan-limit snapshot the CLI reported.
  usage jsonb,
  updated_at timestamptz not null default now(),
  unique (node_id, kind)
);
alter table public.agents enable row level security;
create policy "members read agents" on public.agents
  for select to authenticated using (public.sees(node_id));
create policy "bridge registers agents" on public.agents
  for insert to authenticated with check (public.runs(node_id));
create policy "bridge updates agents" on public.agents
  for update to authenticated using (public.runs(node_id)) with check (public.runs(node_id));

-- ---------- chats --------------------------------------------------------------------
create table public.chats (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  title text check (length(title) <= 200),
  -- The agent's own conversation id (Claude session, Codex thread), set by the bridge.
  session_id text,
  preview text,
  last_sender text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chats_node_idx on public.chats (node_id, updated_at desc);
create index chats_agent_idx on public.chats (agent_id, updated_at desc);
alter table public.chats enable row level security;
create policy "members read chats" on public.chats
  for select to authenticated using (public.sees(node_id));
create policy "operator creates chats" on public.chats
  for insert to authenticated with check (public.operates(node_id) and session_id is null);
create policy "members update chats" on public.chats
  for update to authenticated using (public.sees(node_id)) with check (public.sees(node_id));
create policy "operator deletes chats" on public.chats
  for delete to authenticated using (public.operates(node_id));

alter table public.agents
  add constraint agents_current_chat_fk foreign key (current_chat_id) references public.chats(id) on delete set null;

-- ---------- messages -----------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender text not null check (sender in ('user','agent','system')),
  body text not null check (length(body) between 1 and 100000),
  status text not null default 'sent'
    check (status in ('sent','queued','processing','done','error','cancelled')),
  reply_to uuid references public.messages(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index messages_chat_idx on public.messages (chat_id, created_at desc);
create index messages_node_idx on public.messages (node_id, created_at desc);
create index messages_queue_idx on public.messages (status, created_at) where sender = 'user';
alter table public.messages enable row level security;
create policy "members read messages" on public.messages
  for select to authenticated using (public.sees(node_id));
create policy "operator sends, bridge replies" on public.messages
  for insert to authenticated with check (
    (public.operates(node_id) and sender = 'user' and status = 'queued')
    or (public.runs(node_id) and sender in ('agent','system')));
create policy "operator cancels queued" on public.messages
  for update to authenticated
  using (public.operates(node_id) and sender = 'user' and status = 'queued')
  with check (status = 'cancelled');
create policy "bridge updates status" on public.messages
  for update to authenticated using (public.runs(node_id)) with check (public.runs(node_id));

-- ---------- carry the existing data over to the first node ----------------------------
insert into public.agents (node_id, kind, name, paused, usage)
select n.id, a.id, a.name, a.paused, a.usage from public.old_agents a, public.nodes n;
insert into public.chats (id, node_id, agent_id, title, session_id, preview, last_sender, created_at, updated_at)
select c.id, a.node_id, a.id, c.title, c.session_id, c.preview, c.last_sender, c.created_at, c.updated_at
from public.old_chats c join public.agents a on a.kind = c.agent_id;
insert into public.messages (id, node_id, chat_id, sender, body, status, reply_to, meta, created_at, updated_at)
select m.id, c.node_id, m.chat_id, case when m.sender = 'claude' then 'agent' else m.sender end,
  m.body, m.status, null, m.meta, m.created_at, m.updated_at
from public.old_messages m join public.chats c on c.id = m.chat_id;
update public.messages m set reply_to = o.reply_to
from public.old_messages o where o.id = m.id and o.reply_to is not null;

drop table public.old_messages, public.old_chats, public.old_agents, public.agent_state, public.login_codes, public.allowed_users;
drop function if exists public.is_owner();
drop function if exists public.messages_assign_chat();

-- ---------- triggers -----------------------------------------------------------------
-- A chat always lives on its agent's node; a message on its chat's node. Clients can't move them.
create or replace function public.chats_pin_node() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    select node_id into new.node_id from agents where id = new.agent_id;
  else
    new.node_id := old.node_id;
    new.agent_id := old.agent_id;
  end if;
  return new;
end $$;
create trigger chats_pin_node before insert or update on public.chats
  for each row execute function public.chats_pin_node();

create or replace function public.messages_pin_node() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    select node_id into new.node_id from chats where id = new.chat_id;
  else
    new.node_id := old.node_id;
    new.chat_id := old.chat_id;
  end if;
  return new;
end $$;
create trigger messages_pin_node before insert or update on public.messages
  for each row execute function public.messages_pin_node();

create trigger agents_touch before update on public.agents
  for each row execute function public.touch_updated_at();
create trigger messages_touch before update on public.messages
  for each row execute function public.touch_updated_at();

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

-- Atomically hands the oldest queued task for one agent to its bridge.
create or replace function public.claim_next_message(p_agent uuid) returns setof public.messages
language sql security definer set search_path = public as $$
  update messages set status = 'processing'
  where id = (
    select m.id from messages m join chats c on c.id = m.chat_id
    where m.sender = 'user' and m.status = 'queued' and c.agent_id = p_agent and public.runs(c.node_id)
    order by m.created_at
    limit 1
    for update of m skip locked
  )
  returning *;
$$;
revoke all on function public.claim_next_message(uuid) from public, anon;
grant execute on function public.claim_next_message(uuid) to authenticated;

-- ---------- sign-in and pairing --------------------------------------------------------
-- A phone asked to sign in as this node's operator: the node's PC shows the code as a QR.
create table public.login_requests (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes(id) on delete cascade,
  email text not null,
  code text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes'
);
create index login_requests_email_idx on public.login_requests (email, created_at desc);
alter table public.login_requests enable row level security;
create policy "bridge reads its sign-in requests" on public.login_requests
  for select to authenticated using (public.runs(node_id));

-- A new PC waiting to be paired. Only the pair function touches it.
create table public.pair_requests (
  id uuid primary key default gen_random_uuid(),
  -- Shown to the phone (QR); approving needs a signed-in operator.
  code text not null unique,
  -- Known only to the waiting PC; it polls with this.
  secret text not null,
  machine text,
  node_id uuid references public.nodes(id) on delete cascade,
  agent_email text,
  agent_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);
alter table public.pair_requests enable row level security;

-- ---------- realtime -----------------------------------------------------------------
alter table public.messages replica identity full;
alter table public.chats replica identity full;
alter publication supabase_realtime add table public.nodes, public.agents, public.chats, public.messages, public.login_requests;
