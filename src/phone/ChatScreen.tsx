import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useClient } from './client';
import { agentLabel, isOnline, useConversation, useNow } from '../lib/useConversation';
import type { Agent, Chat, Message, Node } from '../lib/types';
import { MessageList } from '../ui/MessageList';
import { Composer } from '../ui/Composer';
import { ActivityBar } from '../ui/ActivityBar';
import { BackIcon, MoreIcon } from '../ui/icons';
import { Reticle } from '../ui/Reticle';
import { ago } from '../ui/time';

const SUGGESTIONS = [
  'What are you able to do on my PC?',
  'Summarize what changed in my ironlog project today',
  'Check disk space and tell me what is taking the most room',
];

const uptime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/** Round-trip time to the backend, sampled every 10 seconds. */
function useLatency(client: SupabaseClient) {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const t = performance.now();
      const { error } = await client.from('agents').select('id').limit(1);
      if (alive) setMs(error ? null : Math.round(performance.now() - t));
    };
    ping();
    const id = window.setInterval(ping, 10_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [client]);
  return ms;
}

const isHiddenCommand = (m: Message) => m.sender === 'user' && m.body.trim() === '/stop';

export function ChatScreen({
  chat,
  agent,
  nodes,
  onBack,
  onDeleted,
  onError,
}: {
  chat: Chat;
  agent: Agent | undefined;
  nodes: Node[];
  onBack: () => void;
  onDeleted: () => void;
  onError: (text: string) => void;
}) {
  const now = useNow(1000);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const startedAt = useRef(Date.now());
  const client = useClient();
  const latency = useLatency(client);
  const { messages, live, upsert } = useConversation(client, chat.id);

  const name = agentLabel(agent, nodes);
  const visible = useMemo(() => messages.filter((m) => !isHiddenCommand(m)), [messages]);
  const online = isOnline(agent, now);
  const current = messages.find((m) => m.sender === 'user' && m.status === 'processing');
  const working = !!current;
  const queued = messages.filter((m) => m.sender === 'user' && m.status === 'queued').length;
  const activity = agent?.current_chat_id === chat.id ? agent.activity : null;

  const send = async (body: string) => {
    const { data, error } = await client
      .from('messages')
      .insert({ chat_id: chat.id, sender: 'user', body, status: 'queued' })
      .select()
      .single();
    if (error) {
      onError(error.message);
      throw error;
    }
    upsert(data as Message);
  };

  const cancel = async (m: Message) => {
    const { error } = await client.from('messages').update({ status: 'cancelled' }).eq('id', m.id).eq('status', 'queued');
    if (error) onError(error.message);
  };

  const remove = async () => {
    const { error } = await client.from('chats').delete().eq('id', chat.id);
    if (error) return onError(error.message);
    onDeleted();
  };

  const paused = online && !!agent?.paused;
  const statusLine = working
    ? 'executing directive'
    : paused
      ? 'paused on the PC · messages will queue'
      : online
      ? 'link secure · online'
      : `offline · seen ${ago(agent?.last_seen ?? null, now)}`;

  return (
    <div className="phone">
      <header className="chat-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back to chats">
          <BackIcon />
        </button>
        <div className="avatar">
          <Reticle size={46} detail="mini" state={working ? 'busy' : online ? 'idle' : 'offline'} />
        </div>
        <div className="who">
          <div className="name">
            {name.toUpperCase()}
            <small>// {chat.title || 'NEW CHAT'}</small>
          </div>
          <div className={`sub ${working ? 'accent' : paused ? 'paused' : online ? 'on' : ''}`}>
            <span className={`led ${working ? 'busy' : paused ? 'paused' : online ? 'on' : ''}`} />
            {statusLine}
            {!live && <span className="reconnecting"> · reconnecting</span>}
          </div>
        </div>
        <button className="icon-btn" onClick={() => { setMenu((v) => !v); setConfirmDelete(false); }} aria-label="Menu">
          <MoreIcon />
        </button>
        {menu && (
          <>
            <div className="scrim" onClick={() => setMenu(false)} />
            <div className="menu">
              <div className="menu-meta">
                {name} chat
                <b>{chat.title || 'New chat'}</b>
                {agent?.machine && <span>Bridge: {agent.machine}{agent.version ? ` · v${agent.version}` : ''}</span>}
              </div>
              <button onClick={() => { setMenu(false); send('/status').catch(() => {}); }}>Agent status</button>
              <button onClick={() => { setMenu(false); send('/new').catch(() => {}); }}>Fresh session in this chat</button>
              <button
                className="danger"
                onClick={() => {
                  if (confirmDelete) {
                    setMenu(false);
                    remove();
                  } else setConfirmDelete(true);
                }}
              >
                {confirmDelete ? 'Tap again to delete' : 'Delete chat'}
              </button>
            </div>
          </>
        )}
      </header>

      <div className="hud">
        <div>
          <span>NODE</span>
          <b className={online ? '' : 'dim'}>{agent?.machine ?? '—'}</b>
        </div>
        <div>
          <span>LATENCY</span>
          <b className={latency == null ? 'dim' : ''}>{latency == null ? '—' : `${latency}ms`}</b>
        </div>
        <div>
          <span>QUEUE</span>
          <b className={queued ? '' : 'dim'}>{String(queued).padStart(2, '0')}</b>
        </div>
        <div>
          <span>UPLINK</span>
          <b>{uptime(now - startedAt.current)}</b>
        </div>
      </div>

      <MessageList
        messages={visible}
        self="user"
        agentName={() => name}
        onCancel={cancel}
        empty={
          <div className="empty">
            <Reticle size={190} detail="lite" state={online ? 'idle' : 'offline'} />
            <h2 className="caret">AWAITING DIRECTIVE</h2>
            <p>Send a task. {name} runs it on your PC and reports back here when complete.</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s).catch(() => {})}>{s}</button>
              ))}
            </div>
          </div>
        }
      />

      <ActivityBar activity={activity} working={working} since={current?.updated_at} onStop={() => send('/stop').catch(() => {})} />
      <Composer placeholder={online && !paused ? 'Enter directive…' : 'Enter directive (queued until agent is back)'} onSend={send} enterSends={false} />
    </div>
  );
}
