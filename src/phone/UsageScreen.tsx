import { useEffect, useMemo, useState } from 'react';
import { useClient } from './client';
import { agentLabel, isOnline, useNow } from '../lib/useConversation';
import type { Agent, Chat, MessageMeta, Node } from '../lib/types';
import { BackIcon } from '../ui/icons';
import { ago } from '../ui/time';

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
] as const;
type Period = (typeof PERIODS)[number]['id'];

interface Reply {
  created_at: string;
  chat_id: string;
  meta: MessageMeta;
}

const DAY = 86_400_000;

const periodStart = (p: Period, now: number) =>
  p === 'today' ? new Date(new Date(now).toDateString()).getTime() : now - (p === '7d' ? 7 : 30) * DAY;

export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n);

const fmtCost = (usd: number) => (usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`);

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/** "in 2h 10m" until a limit window resets. */
const until = (iso: string | null, now: number) => {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `resets in ${h}h ${m % 60}m`;
  return `resets ${new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`;
};

/** Per-agent plan limits (as the CLI last reported them) and token/cost totals from Nebula's own runs. */
export function UsageScreen({ agents, nodes, chats, onBack }: { agents: Agent[]; nodes: Node[]; chats: Chat[]; onBack: () => void }) {
  const client = useClient();
  const now = useNow(30_000);
  const [period, setPeriod] = useState<Period>('7d');
  const [replies, setReplies] = useState<Reply[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .from('messages')
      .select('created_at, chat_id, meta')
      .eq('sender', 'agent')
      .gte('created_at', new Date(Date.now() - 30 * DAY).toISOString())
      .order('created_at', { ascending: false })
      .limit(5000)
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setReplies((data ?? []) as Reply[]);
      });
  }, [client]);

  const agentOf = useMemo(() => {
    const byChat = Object.fromEntries(chats.map((c) => [c.id, c.agent_id]));
    return (r: Reply) => byChat[r.chat_id];
  }, [chats]);

  const totals = useMemo(() => {
    const since = periodStart(period, now);
    const out: Record<string, { tasks: number; input: number; cache: number; output: number; cost: number; hasCost: boolean; ms: number }> = {};
    for (const r of replies ?? []) {
      if (Date.parse(r.created_at) < since || !r.meta?.duration_ms) continue;
      const id = agentOf(r);
      if (!id) continue;
      const t = (out[id] ??= { tasks: 0, input: 0, cache: 0, output: 0, cost: 0, hasCost: false, ms: 0 });
      const m = r.meta;
      t.tasks++;
      t.input += m.input_tokens ?? 0;
      t.cache += (m.cache_read_tokens ?? 0) + (m.cache_write_tokens ?? 0);
      t.output += m.output_tokens ?? 0;
      t.ms += m.duration_ms ?? 0;
      if (typeof m.cost_usd === 'number') {
        t.cost += m.cost_usd;
        t.hasCost = true;
      }
    }
    return out;
  }, [replies, period, now, agentOf]);

  return (
    <div className="phone">
      <header className="chat-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back to chats">
          <BackIcon />
        </button>
        <div className="who">
          <div className="name">
            USAGE<small>// PLAN & TOKENS</small>
          </div>
          <div className="sub">Plan limits from each agent's CLI · totals from Nebula tasks</div>
        </div>
      </header>

      <div className="filters">
        {PERIODS.map((p) => (
          <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="usage">
        {error && <p className="error-text">{error}</p>}
        {agents.map((a) => {
          const t = totals[a.id];
          const online = isOnline(a, now);
          return (
            <section key={a.id} className="usage-card">
              <div className="usage-head">
                <span className={`agent-badge a-${a.kind}`}>{a.name.slice(0, 2).toUpperCase()}</span>
                <b>{agentLabel(a, nodes)}</b>
                <span className={`usage-state ${a.paused ? 'paused' : online ? 'on' : ''}`}>
                  {online ? (a.paused ? 'Paused' : 'Online') : 'Offline'}
                </span>
              </div>

              <div className="usage-label">Plan limits</div>
              {a.usage?.windows.length ? (
                <>
                  {a.usage.windows.map((w) => (
                    <div key={w.id} className="limit">
                      <div className="limit-top">
                        <span>{w.label}</span>
                        <b className={w.pct >= 85 ? 'warn' : ''}>{Math.round(w.pct)}%</b>
                      </div>
                      <div className="bar">
                        <i className={w.pct >= 85 ? 'warn' : ''} style={{ width: `${Math.max(1.5, w.pct)}%` }} />
                      </div>
                      <div className="limit-sub">{until(w.resets_at, now)}</div>
                    </div>
                  ))}
                  <div className="usage-note">As of {ago(a.usage.at, now)} · updates after each task</div>
                </>
              ) : (
                <div className="usage-note">No plan data yet. It appears after {a.name}'s next task.</div>
              )}

              <div className="usage-label">{PERIODS.find((p) => p.id === period)!.label} via Nebula</div>
              {replies == null ? (
                <div className="usage-note">Loading…</div>
              ) : !t ? (
                <div className="usage-note">No tasks in this period.</div>
              ) : (
                <div className="usage-grid">
                  <Stat k="Tasks" v={String(t.tasks)} />
                  <Stat k="Output" v={fmtTokens(t.output)} />
                  <Stat k="Input" v={fmtTokens(t.input)} />
                  <Stat k="Cached" v={fmtTokens(t.cache)} />
                  <Stat k="Avg run" v={fmtDuration(t.ms / t.tasks)} />
                  <Stat k="API value" v={t.hasCost ? fmtCost(t.cost) : '—'} />
                </div>
              )}
            </section>
          );
        })}
        <p className="usage-foot">
          API value is what these tasks would cost at API prices. On a subscription plan you pay the plan fee; the limits above are what count.
        </p>
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="ustat">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}
