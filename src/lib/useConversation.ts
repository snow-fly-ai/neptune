import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ONLINE_WINDOW_MS } from './config';
import type { Agent, Chat, Message, Node } from './types';

const PAGE = 200;

const byTime = (a: Message, b: Message) => a.created_at.localeCompare(b.created_at);
const byRecent = (a: Chat, b: Chat) => b.updated_at.localeCompare(a.updated_at);

/** Heartbeat within the window and not explicitly signed off. */
export const isOnline = (a: Agent | null | undefined, now: number) =>
  !!a?.online && !!a.last_seen && now - Date.parse(a.last_seen) < ONLINE_WINDOW_MS;

/**
 * Live view of one chat's messages (or every chat's, when `chatId` is null).
 * Realtime drives updates; a periodic refetch covers dropped sockets and app resumes.
 */
export function useConversation(client: SupabaseClient | null, chatId: string | null, onInsert?: (m: Message) => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(false);
  const onInsertRef = useRef(onInsert);
  onInsertRef.current = onInsert;

  const upsert = useCallback((m: Message) => {
    if (chatId && m.chat_id !== chatId) return;
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      if (i === -1) return [...prev, m].sort(byTime);
      const next = prev.slice();
      next[i] = m;
      return next;
    });
  }, [chatId]);

  const refresh = useCallback(async () => {
    if (!client) return;
    let q = client.from('messages').select('*').order('created_at', { ascending: false }).limit(PAGE);
    if (chatId) q = q.eq('chat_id', chatId);
    const { data, error } = await q;
    if (data) setMessages((data as Message[]).reverse());
    if (!error) setLoaded(true);
  }, [client, chatId]);

  useEffect(() => {
    if (!client) return;
    setMessages([]);
    setLoaded(false);
    refresh();
    const channel = client
      .channel(`nebula-feed-${chatId ?? 'all'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', ...(chatId ? { filter: `chat_id=eq.${chatId}` } : {}) },
        (p) => {
          if (p.eventType === 'DELETE') {
            const id = (p.old as Partial<Message>).id;
            setMessages((prev) => prev.filter((m) => m.id !== id));
            return;
          }
          const m = p.new as Message;
          upsert(m);
          if (p.eventType === 'INSERT') onInsertRef.current?.(m);
        },
      )
      .subscribe((status) => {
        setLive(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') refresh();
      });

    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    const poll = window.setInterval(refresh, 30_000);
    return () => {
      client.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(poll);
    };
  }, [client, chatId, refresh, upsert]);

  return { messages, loaded, live, upsert, refresh };
}

/** "Claude", or "Claude · Work" when the account has several PCs. */
export const agentLabel = (agent: Agent | undefined, nodes: Node[]) => {
  if (!agent) return 'Agent';
  const node = nodes.length > 1 ? nodes.find((n) => n.id === agent.node_id) : undefined;
  return node ? `${agent.name} · ${node.name}` : agent.name;
};

/** Live chat list, PCs and agent presence, plus every new message (for notifications). */
export function useChats(client: SupabaseClient | null, onMessage?: (m: Message) => void) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const putChat = useCallback((c: Chat) => {
    setChats((prev) => [...prev.filter((x) => x.id !== c.id), c].sort(byRecent));
  }, []);
  const dropChat = useCallback((id: string) => setChats((prev) => prev.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async () => {
    if (!client) return;
    const [c, a, n] = await Promise.all([
      client.from('chats').select('*').order('updated_at', { ascending: false }).limit(PAGE),
      client.from('agents').select('*').order('name'),
      client.from('nodes').select('*').order('created_at'),
    ]);
    if (c.data) setChats(c.data as Chat[]);
    if (a.data) setAgents(a.data as Agent[]);
    if (n.data) setNodes(n.data as Node[]);
    if (!c.error) setLoaded(true);
  }, [client]);

  useEffect(() => {
    if (!client) return;
    refresh();
    const channel = client
      .channel('nebula-chats')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, (p) => {
        if (p.eventType === 'DELETE') dropChat((p.old as Partial<Chat>).id!);
        else putChat(p.new as Chat);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, (p) => {
        if (p.eventType === 'DELETE') return;
        const a = p.new as Agent;
        setAgents((prev) => [...prev.filter((x) => x.id !== a.id), a].sort((x, y) => x.name.localeCompare(y.name)));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nodes' }, () => refresh())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
        onMessageRef.current?.(p.new as Message);
      })
      .subscribe((status) => {
        setLive(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') refresh();
      });

    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    const poll = window.setInterval(refresh, 30_000);
    return () => {
      client.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(poll);
    };
  }, [client, refresh, putChat, dropChat]);

  return { chats, agents, nodes, loaded, live, refresh, putChat, dropChat };
}

/** Re-renders on an interval so relative times and presence stay fresh. */
export function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
