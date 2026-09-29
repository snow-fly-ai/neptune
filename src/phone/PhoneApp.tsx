import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ClientContext, useClient } from './client';
import { activeAccount, adoptLegacySession, clientFor, forgetAccount, listAccounts, saveAccounts, setActiveAccount } from './accounts';
import { AuthScreen } from './AuthScreen';
import { ChatList } from './ChatList';
import { ChatScreen } from './ChatScreen';
import { PairScreen } from './PairScreen';
import { UsageScreen } from './UsageScreen';
import { ScanOverlay } from './scan';
import { ensureNotifyPermission, notify } from '../lib/notify';
import { agentLabel, useChats } from '../lib/useConversation';
import { checkPhoneUpdate, type PhoneUpdate } from '../lib/updates';
import { openExternal } from '../lib/open';
import type { Chat, Message } from '../lib/types';

export function PhoneApp() {
  const [accounts, setAccounts] = useState<string[]>(() => {
    adoptLegacySession();
    return listAccounts();
  });
  const [active, setActive] = useState<string | null>(() => {
    const a = activeAccount();
    return a && listAccounts().includes(a) ? a : (listAccounts()[0] ?? null);
  });
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const use = useCallback((email: string) => {
    saveAccounts([...listAccounts(), email]);
    setActiveAccount(email);
    setAccounts(listAccounts());
    setActive(email);
    setAdding(false);
  }, []);

  const forget = useCallback(async (email: string) => {
    await forgetAccount(email);
    setAccounts(listAccounts());
    setActive(activeAccount());
  }, []);

  const others = accounts.filter((a) => a !== active);

  return (
    <>
      {!active || adding ? (
        <AuthScreen onSignedIn={use} onCancel={active ? () => setAdding(false) : undefined} />
      ) : (
        <ClientContext.Provider value={clientFor(active)}>
          <Account
            key={active}
            email={active}
            others={others}
            onSwitch={use}
            onAddAccount={() => setAdding(true)}
            onAccountAdded={use}
            onSignOut={() => forget(active)}
            onToast={setToast}
          />
        </ClientContext.Provider>
      )}
      {others.map((email) => (
        <BackgroundAccount key={email} email={email} />
      ))}
      <ScanOverlay />
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

type AccountProps = {
  email: string;
  others: string[];
  onSwitch: (email: string) => void;
  onAddAccount: () => void;
  onAccountAdded: (email: string) => void;
  onSignOut: () => void;
  onToast: (text: string) => void;
};

/** Waits for the account's stored session; a lost session signs the account out. */
function Account(props: AccountProps) {
  const client = useClient();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const { onSignOut } = props;

  useEffect(() => {
    client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = client.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_OUT') onSignOut();
    });
    return () => data.subscription.unsubscribe();
  }, [client, onSignOut]);

  useEffect(() => {
    if (session === null) onSignOut();
  }, [session, onSignOut]);

  if (!session) return <div className="splash" />;
  return <Home {...props} session={session} />;
}

/** Other signed-in accounts still notify when their agents reply. */
function BackgroundAccount({ email }: { email: string }) {
  useEffect(() => {
    const client = clientFor(email);
    const since = Date.now();
    const channel = client
      .channel('nebula-background')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
        const m = p.new as Message;
        if (m.sender === 'user' || Date.parse(m.created_at) < since) return;
        notify(`Nebula · ${email.split('@')[0]}`, m.body);
      })
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [email]);
  return null;
}

type NavState = { chat?: string; usage?: boolean; pair?: boolean } | null;
type View = 'list' | 'usage' | 'pair';

/** Chat list ⇄ chat / usage / pairing. Opening one pushes a history entry so Android's back button returns to the list. */
function Home({ session, email, others, onSwitch, onAddAccount, onAccountAdded, onSignOut, onToast }: AccountProps & { session: Session }) {
  const client = useClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<View>('list');
  const [update, setUpdate] = useState<PhoneUpdate | null>(null);
  const startedAt = useRef(Date.now());
  const openRef = useRef(openId);
  openRef.current = openId;

  const { chats, agents, nodes, loaded, live, putChat, refresh } = useChats(client, (m: Message) => {
    if (m.sender === 'user') return;
    if (Date.parse(m.created_at) < startedAt.current) return;
    if (document.visibilityState === 'visible' && openRef.current === m.chat_id) return;
    const chat = chats.find((c) => c.id === m.chat_id);
    const agent = agents.find((a) => a.id === chat?.agent_id);
    notify(m.sender === 'agent' ? agentLabel(agent, nodes) : 'Nebula', m.body);
  });

  useEffect(() => {
    ensureNotifyPermission();
    checkPhoneUpdate().then(setUpdate).catch(() => {});
    const onPop = () => {
      const st = history.state as NavState;
      setOpenId(st?.chat ?? null);
      setView(st?.usage ? 'usage' : st?.pair ? 'pair' : 'list');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = useCallback((chat: Chat) => {
    history.pushState({ chat: chat.id }, '');
    setOpenId(chat.id);
  }, []);
  const show = useCallback((v: 'usage' | 'pair') => {
    history.pushState({ [v]: true }, '');
    setView(v);
  }, []);
  const back = useCallback(() => {
    const st = history.state as NavState;
    if (st?.chat || st?.usage || st?.pair) history.back();
    else {
      setOpenId(null);
      setView('list');
    }
  }, []);

  const create = async (agentId: string) => {
    const { data, error } = await client.from('chats').insert({ agent_id: agentId }).select().single();
    if (error) return onToast(error.message);
    putChat(data as Chat);
    open(data as Chat);
  };

  const removeNode = async (id: string) => {
    const { error } = await client.from('nodes').delete().eq('id', id);
    if (error) return onToast(error.message);
    refresh();
  };

  const chat = chats.find((c) => c.id === openId);

  if (view === 'pair')
    return (
      <PairScreen
        session={session}
        onBack={back}
        onPaired={(name, account) => {
          back();
          refresh();
          onToast(`${name} paired. It signs in within a few seconds.`);
          if (account) onAccountAdded(account);
        }}
      />
    );
  if (view === 'usage') return <UsageScreen agents={agents} nodes={nodes} chats={chats} onBack={back} />;
  if (chat)
    return (
      <ChatScreen
        key={chat.id}
        chat={chat}
        agent={agents.find((a) => a.id === chat.agent_id)}
        nodes={nodes}
        onBack={back}
        onDeleted={back}
        onError={onToast}
      />
    );
  return (
    <ChatList
      email={email}
      others={others}
      chats={chats}
      agents={agents}
      nodes={nodes}
      live={live}
      loaded={loaded}
      onOpen={open}
      onUsage={() => show('usage')}
      onPair={() => show('pair')}
      onCreate={create}
      onRemoveNode={removeNode}
      onSwitch={onSwitch}
      onAddAccount={onAddAccount}
      onCheckUpdates={async () => {
        const u = await checkPhoneUpdate().catch(() => null);
        setUpdate(u);
        if (!u) onToast("You're on the latest version");
      }}
      onSignOut={onSignOut}
      banner={
        update && (
          <button className="update-banner" onClick={() => openExternal(update.url)}>
            <span>Nebula {update.version} is available</span>
            <b>Download</b>
          </button>
        )
      }
    />
  );
}
