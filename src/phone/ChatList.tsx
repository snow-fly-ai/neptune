import { useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isOnline, useNow } from '../lib/useConversation';
import type { Agent, Chat } from '../lib/types';
import { MoreIcon, PlusIcon } from '../ui/icons';
import { Reticle } from '../ui/Reticle';
import { ago } from '../ui/time';

const monogram = (name: string) => name.slice(0, 2).toUpperCase();

export function ChatList({
  session,
  chats,
  agents,
  live,
  loaded,
  onOpen,
  onUsage,
  onCreate,
  onCheckUpdates,
  onSignOut,
  banner,
}: {
  session: Session;
  chats: Chat[];
  agents: Agent[];
  live: boolean;
  loaded: boolean;
  onOpen: (chat: Chat) => void;
  onUsage: () => void;
  onCreate: (agentId: string) => void;
  onCheckUpdates: () => void;
  onSignOut: () => void;
  banner?: ReactNode;
}) {
  const now = useNow(5000);
  const [filter, setFilter] = useState<string>('all');
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);

  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const shown = filter === 'all' ? chats : chats.filter((c) => c.agent_id === filter);
  const onlineCount = agents.filter((a) => isOnline(a, now)).length;
  const busy = agents.some((a) => isOnline(a, now) && a.current_chat_id);

  const create = (agentId: string) => {
    setPicker(false);
    onCreate(agentId);
  };

  return (
    <div className="phone">
      <header className="chat-head">
        <div className="avatar">
          <Reticle size={46} detail="mini" state={busy ? 'busy' : onlineCount ? 'idle' : 'offline'} />
        </div>
        <div className="who">
          <div className="name">
            NEBULA<small>// CHANNELS</small>
          </div>
          <div className={`sub ${onlineCount ? 'on' : ''}`}>
            <span className={`led ${busy ? 'busy' : onlineCount ? 'on' : ''}`} />
            {onlineCount}/{agents.length} agents online
            {agents.some((a) => a.paused && isOnline(a, now)) && <span className="reconnecting"> · {agents.filter((a) => a.paused && isOnline(a, now)).length} paused</span>}
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
              </div>
              <button onClick={() => { setMenu(false); onUsage(); }}>Usage</button>
              <button onClick={() => { setMenu(false); onCheckUpdates(); }}>Check for updates</button>
              <button className="danger" onClick={() => { setMenu(false); onSignOut(); }}>Sign out</button>
            </div>
          </>
        )}
      </header>

      <div className="filters">
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
          All <i>{chats.length}</i>
        </button>
        {agents.map((a) => (
          <button key={a.id} className={filter === a.id ? 'on' : ''} onClick={() => setFilter(a.id)}>
            <span className={`led ${isOnline(a, now) ? (a.paused ? 'paused' : 'on') : ''}`} />
            {a.name} <i>{chats.filter((c) => c.agent_id === a.id).length}</i>
          </button>
        ))}
      </div>

      {banner}

      <div className="chat-list">
        {loaded && shown.length === 0 && (
          <div className="empty">
            <Reticle size={170} detail="lite" state={onlineCount ? 'idle' : 'offline'} />
            <h2 className="caret">NO CHANNELS</h2>
            <p>Start a chat with {filter === 'all' ? 'an agent' : (byId[filter]?.name ?? filter)}. Each chat keeps its own conversation.</p>
          </div>
        )}
        {shown.map((c) => {
          const agent = byId[c.agent_id];
          const working = !!agent && agent.current_chat_id === c.id && isOnline(agent, now);
          const name = agent?.name ?? c.agent_id;
          return (
            <button key={c.id} className={`chat-row ${working ? 'working' : ''}`} onClick={() => onOpen(c)}>
              <span className={`agent-badge a-${c.agent_id}`}>
                {monogram(name)}
                <i className={`led ${working ? 'busy' : isOnline(agent, now) ? (agent.paused ? 'paused' : 'on') : ''}`} />
              </span>
              <span className="chat-main">
                <span className="chat-top">
                  <b>{c.title || 'New chat'}</b>
                  <time>{ago(c.updated_at, now)}</time>
                </span>
                <span className="chat-sub">
                  <em>{name}</em>
                  {working ? (
                    <span className="g">{agent.activity || 'Working…'}</span>
                  ) : (
                    <span>{c.preview ? `${c.last_sender === 'user' ? 'You: ' : ''}${c.preview}` : 'No messages yet'}</span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <button className="fab" onClick={() => (filter !== 'all' ? create(filter) : setPicker(true))}>
        <PlusIcon width={18} height={18} /> New {filter !== 'all' ? (byId[filter]?.name ?? '') : ''} chat
      </button>

      {picker && (
        <>
          <div className="scrim dim" onClick={() => setPicker(false)} />
          <div className="sheet">
            <div className="sheet-title">Choose an agent</div>
            {agents.map((a) => {
              const on = isOnline(a, now);
              return (
                <button key={a.id} onClick={() => create(a.id)}>
                  <span className={`agent-badge a-${a.id}`}>{monogram(a.name)}</span>
                  <span className="chat-main">
                    <b>{a.name}</b>
                    <span className={on ? 'g' : ''}>
                      {on ? `${a.paused ? 'Paused (messages will queue)' : 'Online'} · ${a.machine ?? 'PC'}` : a.last_seen ? `Offline · seen ${ago(a.last_seen, now)}` : 'Not set up on the PC yet'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
