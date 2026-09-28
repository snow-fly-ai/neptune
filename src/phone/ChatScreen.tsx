import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { phoneClient } from './client';
import { ensureNotifyPermission, notify } from '../lib/notify';
import { useConversation, useNow } from '../lib/useConversation';
import { checkPhoneUpdate, type PhoneUpdate } from '../lib/updates';
import { openExternal } from '../lib/open';
import { ONLINE_WINDOW_MS } from '../lib/config';
import type { Message } from '../lib/types';
import { MessageList } from '../ui/MessageList';
import { Composer } from '../ui/Composer';
import { ActivityBar } from '../ui/ActivityBar';
import { MoreIcon } from '../ui/icons';
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
function useLatency() {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const t = performance.now();
      const { error } = await phoneClient.from('agent_state').select('id').eq('id', 1).maybeSingle();
      if (alive) setMs(error ? null : Math.round(performance.now() - t));
    };
    ping();
    const id = window.setInterval(ping, 10_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return ms;
}

const isHiddenCommand = (m: Message) => m.sender === 'user' && m.body.trim() === '/stop';

export function ChatScreen({ session }: { session: Session }) {
  const now = useNow(1000);
  const [menu, setMenu] = useState(false);
  const [update, setUpdate] = useState<PhoneUpdate | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const startedAt = useRef(Date.now());
  const latency = useLatency();

  const { messages, agent, live, upsert } = useConversation(phoneClient, (m) => {
    if (m.sender === 'user') return;
    if (Date.parse(m.created_at) < startedAt.current) return;
    if (document.visibilityState !== 'visible') notify(m.sender === 'claude' ? 'Claude' : 'Relay', m.body);
  });

  useEffect(() => {
    ensureNotifyPermission();
    checkPhoneUpdate().then(setUpdate).catch(() => {});
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const visible = useMemo(() => messages.filter((m) => !isHiddenCommand(m)), [messages]);
  const online = !!agent?.last_seen && now - Date.parse(agent.last_seen) < ONLINE_WINDOW_MS && agent.online;
  const current = messages.find((m) => m.sender === 'user' && m.status === 'processing');
  const working = !!current;
  const queued = messages.filter((m) => m.sender === 'user' && m.status === 'queued').length;

  const send = async (body: string) => {
    const { data, error } = await phoneClient
      .from('messages')
      .insert({ sender: 'user', body, status: 'queued' })
      .select()
      .single();
    if (error) {
      setToast(error.message);
      throw error;
    }
    upsert(data as Message);
  };

  const cancel = async (m: Message) => {
    const { error } = await phoneClient.from('messages').update({ status: 'cancelled' }).eq('id', m.id).eq('status', 'queued');
    if (error) setToast(error.message);
  };

  const statusLine = working
    ? 'executing directive'
    : online
      ? 'link secure · online'
      : `offline · seen ${ago(agent?.last_seen ?? null, now)}`;

  return (
    <div className="phone">
      <header className="chat-head">
        <div className="avatar">
          <Reticle size={46} detail="mini" state={working ? 'busy' : online ? 'idle' : 'offline'} />
        </div>
        <div className="who">
          <div className="name">
            CLAUDE<small>// OPERATOR NODE</small>
          </div>
          <div className={`sub ${working ? 'accent' : online ? 'on' : ''}`}>
            <span className={`led ${working ? 'busy' : online ? 'on' : ''}`} />
            {statusLine}
            {!live && <span className="reconnecting"> · reconnecting</span>}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setMenu((v) => !v)} aria-label="Menu">
          <MoreIcon />
        </button>
        {menu && (
          <>
            <div className="scrim" onClick={() => setMenu(false)} />
            <div className="menu">
              <div className="menu-meta">
                Signed in as
                <b>{session.user.email}</b>
                {agent?.machine && <span>Bridge: {agent.machine}{agent.version ? ` · v${agent.version}` : ''}</span>}
              </div>
              <button onClick={() => { setMenu(false); send('/new').catch(() => {}); }}>Start a fresh session</button>
              <button
                onClick={async () => {
                  setMenu(false);
                  const u = await checkPhoneUpdate().catch(() => null);
                  setUpdate(u);
                  if (!u) setToast("You're on the latest version");
                }}
              >
                Check for updates
              </button>
              <button className="danger" onClick={() => phoneClient.auth.signOut()}>Sign out</button>
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

      {update && (
        <button className="update-banner" onClick={() => openExternal(update.url)}>
          <span>Relay {update.version} is available</span>
          <b>Download</b>
        </button>
      )}

      <MessageList
        messages={visible}
        self="user"
        onCancel={cancel}
        empty={
          <div className="empty">
            <Reticle size={190} detail="lite" state={online ? 'idle' : 'offline'} />
            <h2 className="caret">AWAITING DIRECTIVE</h2>
            <p>Send a task. It runs on your PC and reports back here when complete.</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s).catch(() => {})}>{s}</button>
              ))}
            </div>
          </div>
        }
      />

      <ActivityBar agent={agent} working={working} since={current?.updated_at} onStop={() => send('/stop').catch(() => {})} />
      <Composer placeholder={online ? 'Enter directive…' : 'Enter directive (queued until node is back)'} onSend={send} enterSends={false} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
