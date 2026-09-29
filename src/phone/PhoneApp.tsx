import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { phoneClient } from './client';
import { AuthScreen } from './AuthScreen';
import { ChatList } from './ChatList';
import { ChatScreen } from './ChatScreen';
import { ensureNotifyPermission, notify } from '../lib/notify';
import { useChats } from '../lib/useConversation';
import { checkPhoneUpdate, type PhoneUpdate } from '../lib/updates';
import { openExternal } from '../lib/open';
import type { Chat, Message } from '../lib/types';

export function PhoneApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    phoneClient.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = phoneClient.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div className="splash" />;
  return session ? <Home session={session} /> : <AuthScreen />;
}

/** Chat list ⇄ chat. Opening a chat pushes a history entry so Android's back button returns to the list. */
function Home({ session }: { session: Session }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [update, setUpdate] = useState<PhoneUpdate | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const startedAt = useRef(Date.now());
  const openRef = useRef(openId);
  openRef.current = openId;

  const { chats, agents, loaded, live, putChat } = useChats(phoneClient, (m: Message) => {
    if (m.sender === 'user') return;
    if (Date.parse(m.created_at) < startedAt.current) return;
    if (document.visibilityState === 'visible' && openRef.current === m.chat_id) return;
    const chat = chats.find((c) => c.id === m.chat_id);
    const agent = agents.find((a) => a.id === chat?.agent_id);
    notify(m.sender === 'agent' ? (agent?.name ?? 'Relay') : 'Relay', m.body);
  });

  useEffect(() => {
    ensureNotifyPermission();
    checkPhoneUpdate().then(setUpdate).catch(() => {});
    const onPop = () => setOpenId((history.state as { chat?: string } | null)?.chat ?? null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const open = useCallback((chat: Chat) => {
    history.pushState({ chat: chat.id }, '');
    setOpenId(chat.id);
  }, []);
  const back = useCallback(() => {
    if ((history.state as { chat?: string } | null)?.chat) history.back();
    else setOpenId(null);
  }, []);

  const create = async (agentId: string) => {
    const { data, error } = await phoneClient.from('chats').insert({ agent_id: agentId }).select().single();
    if (error) return setToast(error.message);
    putChat(data as Chat);
    open(data as Chat);
  };

  const chat = chats.find((c) => c.id === openId);

  return (
    <>
      {chat ? (
        <ChatScreen
          key={chat.id}
          chat={chat}
          agent={agents.find((a) => a.id === chat.agent_id)}
          onBack={back}
          onDeleted={back}
          onError={setToast}
        />
      ) : (
        <>
          <ChatList
            session={session}
            chats={chats}
            agents={agents}
            live={live}
            loaded={loaded}
            onOpen={open}
            onCreate={create}
            onCheckUpdates={async () => {
              const u = await checkPhoneUpdate().catch(() => null);
              setUpdate(u);
              if (!u) setToast("You're on the latest version");
            }}
            onSignOut={() => phoneClient.auth.signOut()}
            banner={
              update && (
                <button className="update-banner" onClick={() => openExternal(update.url)}>
                  <span>Relay {update.version} is available</span>
                  <b>Download</b>
                </button>
              )
            }
          />
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
