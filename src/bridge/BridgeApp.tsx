import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { enable as enableAutostart, isEnabled as autostartEnabled, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emptyConfig, hostInfo, loadConfig, type HostInfo } from './native';
import { BridgeEngine, type EngineSnapshot } from './engine';
import { bridgeClient, ConfigStore, connect, loadNode } from './auth';
import { Qr } from './Qr';
import { fmtBytes, fmtUptime, useLatency, useTelemetry, type Telemetry } from './telemetry';
import { CountdownRing, HexStream, Meter, Panel, Scramble, Spark, Spinner, Typewriter } from './widgets';
import { appVersion } from '../lib/updates';
import { inTauri } from '../lib/platform';
import { isOnline, useChats, useConversation, useNow } from '../lib/useConversation';
import { loginQr, pairQr } from '../lib/config';
import { callFn } from '../lib/fn';
import type { Agent, Message, Node } from '../lib/types';
import { MessageList } from '../ui/MessageList';
import { Composer } from '../ui/Composer';
import { ActivityBar } from '../ui/ActivityBar';
import { Reticle } from '../ui/Reticle';
import { Logo, XIcon } from '../ui/icons';
import { ago, clock } from '../ui/time';
import './ops.css';

const UPDATE_CHECK_MS = 3 * 60 * 60 * 1000;
const HEARTBEAT_MS = 20_000;

interface Boot {
  store: ConfigStore;
  client: SupabaseClient;
  host: HostInfo;
  version: string;
}

export function BridgeApp() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [node, setNode] = useState<Node | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);

  useEffect(() => {
    // `npm run dev` + ?mode=bridge: render the console without a native side or a session (&pair: the pairing screen).
    if (!inTauri()) {
      const store = new ConfigStore(emptyConfig());
      setBoot({ store, client: bridgeClient(store), host: { machine: 'PREVIEW', home: '', claudePath: null, codexPath: null }, version: 'dev' });
      const pairing = new URLSearchParams(location.search).has('pair');
      setNode(pairing ? null : { id: '00000000-0000-0000-0000-000000000000', name: 'Preview', operator_email: 'operator@example.com', agent_email: 'agent@example.com', machine: 'PREVIEW', created_at: '' });
      return;
    }
    (async () => {
      const [config, host, version] = await Promise.all([loadConfig(), hostInfo(), appVersion()]);
      const store = new ConfigStore(config);
      const client = bridgeClient(store);
      setBoot({ store, client, host, version });
      setNode(await connect(store, client, host, setWaiting));
    })().catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="bridge-setup"><p className="error-text">{error}</p></div>;
  if (!boot || node === undefined)
    return (
      <div className="bridge-setup">
        {waiting && (
          <div className="pair-foot">
            <Spinner size={16} /> Connecting to Nebula… ({waiting})
          </div>
        )}
      </div>
    );
  if (!node) return <Pairing boot={boot} onPaired={setNode} />;
  return <Console key={node.id} {...boot} node={node} onUnpaired={() => setNode(null)} />;
}

type PairState = { id: string; code: string; secret: string; expires_at: string };

/** First run (or after being removed): show a pairing QR for a signed-in phone to scan. */
function Pairing({ boot, onPaired }: { boot: Boot; onPaired: (node: Node) => void }) {
  const { client, host } = boot;
  const [req, setReq] = useState<PairState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [round, setRound] = useState(0);
  const now = useNow(1000);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    setReq(null);
    setError(null);
    (async () => {
      await client.auth.signOut({ scope: 'local' }).catch(() => {});
      const r: PairState = await callFn(client, 'pair', { action: 'start', machine: host.machine });
      if (!alive) return;
      setReq(r);
      const poll = async () => {
        if (!alive) return;
        try {
          const s = await callFn(client, 'pair', { action: 'status', id: r.id, secret: r.secret });
          if (s.state === 'approved') {
            setSigningIn(true);
            const { error } = await client.auth.verifyOtp({ email: s.email, token: s.code, type: 'email' });
            if (error) throw new Error(error.message);
            const node = await loadNode(client);
            if (!node) throw new Error('Signed in, but no PC is paired to this agent email');
            return onPaired(node);
          }
          if (s.state === 'expired') return setRound((n) => n + 1);
        } catch (e) {
          setSigningIn(false);
          return setError(String(e instanceof Error ? e.message : e));
        }
        timer = window.setTimeout(poll, 2000);
      };
      timer = window.setTimeout(poll, 2000);
    })().catch((e) => alive && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [client, host.machine, onPaired, round]);

  const left = req ? Math.max(0, Math.round((Date.parse(req.expires_at) - now) / 1000)) : 0;
  return (
    <div className="bridge-setup">
      <div className="auth-card pair-card">
        <Logo size={40} />
        <h1>PAIR THIS PC</h1>
        <p className="lede">
          On your phone, open Nebula, tap <b>⋮ › Pair a PC</b> and scan this code. You choose this PC's operator and agent emails there.
        </p>
        <div className="pair-qr">{req ? <Qr text={pairQr(req.code)} size={220} /> : <Spinner size={28} />}</div>
        {req && (
          <div className="pair-code">
            {req.code.slice(0, 4)}-{req.code.slice(4)}
          </div>
        )}
        <div className="pair-foot">
          {signingIn ? 'Paired · signing in…' : req ? `${host.machine} · new code in ${Math.floor(left / 60)}:${two(left % 60)}` : 'Requesting a pairing code…'}
        </div>
        {error && (
          <>
            <p className="error-text">{error}</p>
            <button className="secondary" onClick={() => setRound((n) => n + 1)}>Try again</button>
          </>
        )}
      </div>
    </div>
  );
}

/** "asnqln@gmail.com" → "asn•••@gmail.com": readable to you, not to a passer-by. */
const mask = (email: string) => {
  const [u, d] = email.split('@');
  return `${u.slice(0, 3)}•••@${d ?? ''}`;
};
const hexId = (s: string | null | undefined, n = 8) => (s ? s.replace(/-/g, '').slice(0, n).toUpperCase() : '—');
const two = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date, utc = false) =>
  utc ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}` : `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
const firstLine = (s: string, n = 110) => {
  const one = s.replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function Console({ store, client, node, host, version, onUnpaired }: Boot & { node: Node; onUnpaired: () => void }) {
  const engine = useMemo(() => new BridgeEngine(store, client, node, host, version), [store, client, node, host, version]);
  engine.onUnpaired = onUnpaired;
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const { messages, live } = useConversation(engine.client, null);
  const { agents, chats } = useChats(engine.client);
  const kindOf = (chatId: string | null | undefined) => agents.find((a) => a.id === chats.find((c) => c.id === chatId)?.agent_id)?.kind ?? null;
  const presence = agents.some((a) => isOnline(a, Date.now()));
  const workers = Object.values(snap.workers);
  const now = useNow(1000);
  const tele = useTelemetry();
  const latency = useLatency(engine.client);
  const [modal, setModal] = useState<'transmit' | 'config' | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [updateState, setUpdateState] = useState<string>('');
  const [awake, setAwake] = useState(() => localStorage.getItem('nebula.awake') !== '0');
  const bootAt = useRef(Date.now());

  useEffect(() => {
    engine.start();
    return () => {
      engine.stop();
    };
  }, [engine]);

  // First run after the rename: retire the old "Relay" install so two bridges don't run.
  useEffect(() => {
    if (!inTauri() || localStorage.getItem('nebula.legacyRemoved')) return;
    invoke<boolean>('remove_legacy_install')
      .then((removed) => {
        localStorage.setItem('nebula.legacyRemoved', '1');
        if (removed) engine.note('Removed the old Relay app from this PC');
      })
      .catch(() => {});
  }, [engine]);

  // Start with Windows by default so the phone can always reach Claude.
  useEffect(() => {
    (async () => {
      let on = await autostartEnabled();
      if (!on && !localStorage.getItem('nebula.autostart.touched')) {
        await enableAutostart();
        localStorage.setItem('nebula.autostart.touched', '1');
        on = true;
      }
      setAutostart(on);
    })().catch(() => setAutostart(false));
  }, []);

  // Keep the display on so the console stays up while nobody is at the PC.
  useEffect(() => {
    localStorage.setItem('nebula.awake', awake ? '1' : '0');
    if (inTauri()) invoke('keep_awake', { on: awake }).catch(() => {});
  }, [awake]);

  // Self-update: check on launch and every few hours; install when idle.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        setUpdateState('Checking for updates…');
        const update = await checkUpdate();
        if (cancelled) return;
        if (!update) return setUpdateState(`Up to date · checked ${clock(new Date().toISOString())}`);
        while (engine.getSnapshot().busy) await new Promise((r) => setTimeout(r, 5000));
        setUpdateState(`Installing v${update.version}…`);
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        if (!cancelled) setUpdateState(`Update check failed: ${String(e).slice(0, 80)}`);
      }
    };
    run();
    const t = window.setInterval(run, UPDATE_CHECK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [engine]);

  // Esc closes a modal; F11 toggles full screen.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null);
      if (e.key === 'F11' && inTauri()) {
        e.preventDefault();
        const w = getCurrentWindow();
        await w.setFullscreen(!(await w.isFullscreen()));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const working = !!snap.current;
  const state = !snap.running ? 'offline' : working ? 'busy' : 'idle';
  const stats = useMemo(() => missionStats(messages, now), [messages, now]);
  const d = new Date(now);

  return (
    <div className={`ops s-${state}`}>
      <header className="ops-top">
        <div className="ops-brand">
          <Logo size={22} />
          <b>NEBULA</b>
          <span className="dim">// OPS CONSOLE</span>
          <span className="stamp-tag">EYES ONLY</span>
        </div>
        <div className="ops-chips">
          <Chip on={live} label="UPLINK" value={live ? 'LIVE' : 'RETRY'} />
          <Chip on={snap.running} label="BRIDGE" value={snap.running ? 'ARMED' : 'PAUSED'} />
          <Chip on={presence} label="PRESENCE" value={presence ? 'BROADCAST' : 'DARK'} />
          <Chip on label="NODE" value={host.machine} />
        </div>
        <div className="ops-actions">
          <button className={`ops-btn ${snap.running ? '' : 'hot'}`} onClick={() => (snap.running ? engine.stop() : engine.start())} title="Pause or resume every agent on this PC">
            {snap.running ? '❚❚ Pause all' : '▶ Resume all'}
          </button>
          <button className="ops-btn danger" disabled={!snap.busy} onClick={() => engine.stopCurrent()} title="Stop every running task">■ Stop all</button>
          <button className="ops-btn" onClick={() => setModal('transmit')}>▲ Transmit</button>
          <button className="ops-btn" onClick={() => setModal('config')}>⚙ Config</button>
        </div>
        <div className="ops-clock">
          <div>
            <span>LOCAL</span>
            <b>{stamp(d)}</b>
          </div>
          <div>
            <span>UTC</span>
            <b>{stamp(d, true)}</b>
          </div>
          <div>
            <span>{d.toLocaleDateString([], { weekday: 'short' }).toUpperCase()}</span>
            <b>{`${d.getFullYear()}.${two(d.getMonth() + 1)}.${two(d.getDate())}`}</b>
          </div>
          <Spinner size={18} tone="blue" />
        </div>
      </header>

      <div className="ops-body">
        <div className="ops-col">
          <SystemPanel tele={tele} />
          <NetPanel tele={tele} />
          <Panel n="03" title="Node identity">
            <KV k="NODE" v={node.name.toUpperCase()} g />
            <KV k="HOST" v={host.machine} />
            <KV k="OS" v={tele.cur?.os || '—'} />
            <KV k="UPTIME" v={tele.cur ? fmtUptime(tele.cur.uptime) : '—'} g />
            <KV k="AGENT" v={mask(node.agent_email)} />
            <KV k="OPERATOR" v={mask(node.operator_email)} />
            <KV k="CLEARANCE" v={permLabel(snap.config.permissionMode)} g />
            <KV k="CHATS" v={String(chats.length)} />
            <KV k="BUILD" v={`v${version}`} />
          </Panel>
          <Panel n="04" title="Packet inspector" tone="green" right={<span className="dim">{fmtBytes((tele.cur?.rx ?? 0) + (tele.cur?.tx ?? 0), true)}</span>} className="grow packet-panel">
            <HexStream rate={Math.min(1, ((tele.cur?.rx ?? 0) + (tele.cur?.tx ?? 0)) / (512 * 1024))} />
          </Panel>
        </div>

        <div className="ops-center">
          <Stage snap={snap} kindOf={kindOf} node={node} state={state} latency={latency[latency.length - 1]} host={host} onStop={() => engine.stopCurrent(snap.currentAgent ?? undefined)} onDismissCode={() => engine.dismissLoginCode()} now={now} />
          <Panel n="05" title="Transmission feed" right={<button className="link" onClick={() => setModal('transmit')}>Open channel ›</button>} className="feed-panel">
            <Feed messages={messages} kindOf={kindOf} />
          </Panel>
        </div>

        <div className="ops-col">
          <Panel n="06" title="Agents" right={<span className="dim">{agents.filter((a) => isOnline(a, now)).length}/{workers.length} ONLINE</span>}>
            <AgentsPanel workers={workers} agents={agents} running={snap.running} now={now} engine={engine} />
          </Panel>
          <Panel n="07" title="Event log" tone="green" right={<Spinner size={13} />} className="grow">
            <EventLog log={snap.log} />
          </Panel>
          <Panel n="08" title="Link & mission" right={<CountdownRing period={HEARTBEAT_MS} />}>
            <div className="lat-row">
              <div>
                <span className="k">LATENCY</span>
                <b className="big g">{latency.length ? `${latency[latency.length - 1]}` : '—'}<small>ms</small></b>
              </div>
              <Spark data={latency} tone="blue" height={34} />
            </div>
            <div className="grid4">
              <Stat k="TODAY" v={stats.today} />
              <Stat k="DONE" v={stats.done} g />
              <Stat k="FAILED" v={stats.failed} warn={stats.failed > 0} />
              <Stat k="QUEUE" v={stats.queued} />
            </div>
            <KV k="AVG RUNTIME" v={stats.avg} />
            <KV k="LAST CONTACT" v={stats.last} />
            <KV k="CONSOLE UP" v={fmtUptime((now - bootAt.current) / 1000)} g />
          </Panel>
        </div>
      </div>

      <Ticker snap={snap} tele={tele} stats={stats} />

      {modal === 'transmit' && (
        <Modal title="Secure channel · mobile uplink" onClose={() => setModal(null)} wide>
          <div className="transmit">
            <MessageList messages={messages} self="agent" agentName={(m) => agentLabel(m, kindOf)} empty={<div className="empty"><p>No transmissions yet. Anything sent from the phone shows up here.</p></div>} />
            <ActivityBar activity={snap.activity} working={working} since={snap.current?.updated_at} onStop={() => engine.stopCurrent()} />
            <Composer placeholder="Send a note to the phone (latest chat)" onSend={(t) => engine.sendNote(t)} enterSends />
          </div>
        </Modal>
      )}
      {modal === 'config' && (
        <Modal title="Bridge configuration" onClose={() => setModal(null)}>
          <ConfigForm
            engine={engine}
            snap={snap}
            host={host}
            autostart={autostart}
            setAutostart={setAutostart}
            awake={awake}
            setAwake={setAwake}
            updateState={updateState}
            onUnpair={async () => {
              await engine.stop();
              await client.auth.signOut({ scope: 'local' }).catch(() => {});
              onUnpaired();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** Every agent on this PC: what the phone sees, what it's doing, its plan usage, and its controls. */
function AgentsPanel({
  workers,
  agents,
  running,
  now,
  engine,
}: {
  workers: EngineSnapshot['workers'][string][];
  agents: Agent[];
  running: boolean;
  now: number;
  engine: BridgeEngine;
}) {
  return (
    <div className="agents">
      {workers.map((w) => {
        const row = agents.find((a) => a.kind === w.id);
        const online = isOnline(row, now);
        const state = !w.binary ? 'missing' : !running ? 'off' : w.current ? 'busy' : w.paused ? 'paused' : online ? 'ready' : 'off';
        const label = { missing: 'NOT INSTALLED', off: running ? 'CONNECTING' : 'BRIDGE PAUSED', busy: 'EXECUTING', paused: 'PAUSED', ready: 'ONLINE' }[state];
        const line = !w.binary
          ? `Install the ${w.name} CLI to bring it online`
          : w.current
            ? w.activity || 'Working…'
            : w.paused
              ? 'New messages wait in its queue'
              : row?.last_seen
                ? `Heartbeat ${ago(row.last_seen, now)}`
                : 'Waiting for first heartbeat';
        return (
          <div key={w.id} className={`agent-row ag-${state}`}>
            <div className="agent-top">
              <i className="dot" />
              <b>{w.name.toUpperCase()}</b>
              <span className="agent-state">{label}</span>
              <div className="agent-btns">
                <button className="mini" disabled={!w.binary} onClick={() => engine.setPaused(w.id, !w.paused)}>
                  {w.paused ? '▶ Resume' : '❚❚ Pause'}
                </button>
                <button className="mini danger" disabled={!w.current} onClick={() => engine.stopCurrent(w.id)}>■ Stop</button>
              </div>
            </div>
            <div className="agent-line">{line}</div>
            {row?.usage?.windows.map((u) => (
              <div key={u.id} className="agent-usage" title={u.resets_at ? `Resets ${new Date(u.resets_at).toLocaleString()}` : undefined}>
                <span>{u.label.toUpperCase()}</span>
                <Meter pct={u.pct} tone={u.pct >= 85 ? 'warn' : 'green'} />
                <b>{Math.round(u.pct)}%</b>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const permLabel = (p: string) => (p === 'acceptEdits' ? 'EDIT' : p === 'default' ? 'READ-ONLY' : 'FULL ACCESS');

function missionStats(messages: Message[], now: number) {
  const dayStart = new Date(new Date(now).toDateString()).getTime();
  const tasks = messages.filter((m) => m.sender === 'user' && m.body.trim() !== '/stop');
  const replies = messages.filter((m) => m.sender === 'agent' && m.meta?.duration_ms);
  const avgMs = replies.length ? replies.reduce((s, m) => s + (m.meta.duration_ms ?? 0), 0) / replies.length : 0;
  const lastMsg = messages[messages.length - 1];
  const since = lastMsg ? Math.round((now - Date.parse(lastMsg.created_at)) / 1000) : null;
  return {
    today: tasks.filter((m) => Date.parse(m.created_at) >= dayStart).length,
    done: tasks.filter((m) => m.status === 'done').length,
    failed: tasks.filter((m) => m.status === 'error').length,
    queued: tasks.filter((m) => m.status === 'queued').length,
    avg: avgMs ? fmtUptime(avgMs / 1000) : '—',
    last: since == null ? '—' : since < 60 ? `${since}s ago` : since < 3600 ? `${Math.floor(since / 60)}m ago` : `${Math.floor(since / 3600)}h ago`,
  };
}

function Chip({ on, label, value }: { on: boolean; label: string; value: string }) {
  return (
    <div className={`chip ${on ? 'on' : ''}`}>
      <i />
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function KV({ k, v, g }: { k: string; v: ReactNode; g?: boolean }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <b className={g ? 'g' : ''} title={typeof v === 'string' ? v : undefined}>{v}</b>
    </div>
  );
}

function Stat({ k, v, g, warn }: { k: string; v: number; g?: boolean; warn?: boolean }) {
  return (
    <div className="stat">
      <span>{k}</span>
      <b className={warn ? 'warn' : g ? 'g' : ''}>{two(v)}</b>
    </div>
  );
}

function SystemPanel({ tele }: { tele: Telemetry }) {
  const c = tele.cur;
  return (
    <Panel n="01" title="System telemetry" tone="green" right={<span className="live-dot">LIVE</span>}>
      <div className="cpu-row">
        <div>
          <span className="k">CPU LOAD</span>
          <b className="big g">{c ? c.cpu.toFixed(1) : '—'}<small>%</small></b>
        </div>
        <Spark data={tele.cpu} max={100} height={46} />
      </div>
      <div className="cores" style={{ gridTemplateColumns: `repeat(${Math.min(16, c?.cores.length || 8)}, 1fr)` }}>
        {(c?.cores ?? Array(8).fill(0)).map((v, i) => (
          <div key={i} className="core" title={`Core ${i}: ${v.toFixed(0)}%`}>
            <i style={{ height: `${Math.max(3, v)}%` }} className={v > 80 ? 'hot' : ''} />
          </div>
        ))}
      </div>
      <div className="row-sub">
        <span>{c?.cores.length ?? '—'} LOGICAL CORES</span>
        <span>{c?.processes ?? '—'} PROCESSES</span>
      </div>
    </Panel>
  );
}

function NetPanel({ tele }: { tele: Telemetry }) {
  const c = tele.cur;
  const memPct = c ? (c.memUsed / c.memTotal) * 100 : 0;
  return (
    <Panel n="02" title="Memory & network">
      <div className="kv">
        <span>MEMORY</span>
        <b>
          {c ? `${fmtBytes(c.memUsed)} / ${fmtBytes(c.memTotal)}` : '—'} <em className="g">{memPct.toFixed(0)}%</em>
        </b>
      </div>
      <Meter pct={memPct} tone={memPct > 85 ? 'warn' : 'blue'} />
      <div className="net">
        <div>
          <span className="k">▼ RX</span>
          <b className="g">{c ? fmtBytes(c.rx, true) : '—'}</b>
          <Spark data={tele.rx} height={30} />
        </div>
        <div>
          <span className="k">▲ TX</span>
          <b className="b">{c ? fmtBytes(c.tx, true) : '—'}</b>
          <Spark data={tele.tx} tone="blue" height={30} />
        </div>
      </div>
    </Panel>
  );
}

function Stage({
  snap,
  kindOf,
  node,
  state,
  latency,
  host,
  now,
  onStop,
  onDismissCode,
}: {
  snap: EngineSnapshot;
  kindOf: (chatId: string | null | undefined) => string | null;
  node: Node;
  state: 'idle' | 'busy' | 'offline';
  latency?: number;
  host: HostInfo;
  now: number;
  onStop: () => void;
  onDismissCode: () => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const r = Math.max(180, Math.min(size.w - 40, size.h - 150, 620));
  const cur = snap.current;
  const headline = state === 'busy' ? 'EXECUTING DIRECTIVE' : state === 'idle' ? 'STANDBY' : 'BRIDGE PAUSED';
  const line = state === 'busy' ? snap.activity || 'Working…' : state === 'idle' ? 'Awaiting directive from mobile uplink' : 'Resume the bridge to accept directives';
  const elapsed = cur ? fmtUptime((now - Date.parse(cur.updated_at)) / 1000) : null;
  const code = snap.loginCode && Date.parse(snap.loginCode.expires_at) > now ? snap.loginCode : null;

  return (
    <div className="stage" ref={ref}>
      <div className="hud-corner tl">
        <span>TARGET</span>
        <b>{node.name.toUpperCase()} // {host.machine}</b>
        <span>ID 0x{hexId(node.id, 6)}</span>
      </div>
      <div className="hud-corner tr">
        <span>SIGNAL</span>
        <b className="g">{latency != null ? `${latency} ms` : 'ACQUIRING'}</b>
        <span>{latency != null ? `QUALITY ${Math.max(60, 100 - latency / 20).toFixed(1)}%` : '—'}</span>
      </div>
      <div className="hud-corner bl">
        <span>CHANNEL</span>
        <b>{cur ? `${agentName(kindOf(cur.chat_id))} // ${hexId(cur.chat_id, 8)}` :`${Object.values(snap.workers).filter((w) => w.binary).length} AGENTS ARMED`}</b>
      </div>
      <div className="hud-corner br">
        <span>MODE</span>
        <b>{permLabel(snap.config.permissionMode)}</b>
      </div>

      <div className="stage-core">
        <Reticle size={r} state={state} label={state === 'busy' ? 'ACTIVE' : state === 'idle' ? 'OPERATOR' : 'OFFLINE'} sub={state === 'busy' ? 'LINKED' : 'SECURE'} />
      </div>

      <div className="stage-status">
        <div className={`headline h-${state}`}>
          {state === 'busy' ? <Spinner size={18} /> : <i className="dot" />}
          <Scramble text={headline} />
          {elapsed && <span className="elapsed">T+{elapsed}</span>}
        </div>
        <div className="subline">
          <span className="g">&gt;</span> <Typewriter text={line} />
        </div>
        {cur && (
          <div className="directive">
            <span className="tag">{agentName(snap.currentAgent)} · DIRECTIVE #{hexId(cur.id, 6)}</span>
            <p>{firstLine(cur.body, 180)}</p>
            <button className="abort" onClick={onStop}>■ ABORT</button>
          </div>
        )}
        <div className={`progress ${state === 'busy' ? 'run' : ''}`}><i /></div>
      </div>

      {code && (
        <div className="auth-alert">
          <span className="tag">⚠ Access request · {mask(code.email)}</span>
          <div className="auth-qr">
            <Qr text={loginQr(code.email, code.code)} size={196} />
          </div>
          <p className="auth-hint">Scan with Nebula on your phone · or type</p>
          <div className="auth-code">{code.code.split('').join(' ')}</div>
          <div className="auth-foot">
            <span>EXPIRES {stamp(new Date(code.expires_at))}</span>
            <button className="link" onClick={onDismissCode}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

const agentName = (id: string | null | undefined) => (id ? id.toUpperCase() : '—');
const agentLabel = (m: Message, kindOf: (chatId: string) => string | null) => {
  const id = m.meta?.agent ?? kindOf(m.chat_id);
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Agent';
};

function Feed({ messages, kindOf }: { messages: Message[]; kindOf: (chatId: string) => string | null }) {
  const rows = messages.filter((m) => m.body.trim() !== '/stop').slice(-9);
  if (!rows.length) return <div className="feed-empty"><Spinner size={14} tone="blue" /> Listening for transmissions…</div>;
  return (
    <div className="feed">
      {rows.map((m) => (
        <div key={m.id} className={`feed-row f-${m.sender}`}>
          <span className="t">{stamp(new Date(m.created_at))}</span>
          <span className="dir">{m.sender === 'user' ? '▲ IN ' : m.sender === 'agent' ? '◆ OUT' : '■ SYS'}</span>
          <span className="ag">{agentName(kindOf(m.chat_id)).slice(0, 6)}</span>
          <span className="id">#{hexId(m.id, 6)}</span>
          <span className="txt">{firstLine(m.body)}</span>
          {m.sender === 'user' && <span className={`st st-${m.status}`}>{m.status === 'processing' ? 'EXEC' : m.status.toUpperCase()}</span>}
        </div>
      ))}
    </div>
  );
}

function EventLog({ log }: { log: EngineSnapshot['log'] }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <div className="evlog" ref={ref}>
      {log.slice(-120).map((l) => (
        <div key={l.id} className={`ev ev-${l.kind}`}>
          <span className="t">{stamp(new Date(l.at))}</span>
          <span className="k">{l.kind === 'tool' ? 'EXEC' : l.kind === 'task' ? 'RECV' : l.kind === 'done' ? 'DONE' : l.kind === 'error' ? 'FAIL' : 'SYS '}</span>
          <span className="x">{l.text}</span>
        </div>
      ))}
      <div className="ev ev-cursor"><span className="t">{stamp(new Date())}</span><span className="caret" /></div>
    </div>
  );
}

function Ticker({ snap, tele, stats }: { snap: EngineSnapshot; tele: Telemetry; stats: ReturnType<typeof missionStats> }) {
  const items = [
    `BRIDGE ${snap.running ? 'ARMED' : 'PAUSED'}`,
    `CPU ${tele.cur?.cpu.toFixed(1) ?? '—'}%`,
    `MEM ${tele.cur ? ((tele.cur.memUsed / tele.cur.memTotal) * 100).toFixed(0) : '—'}%`,
    `DIRECTIVES TODAY ${stats.today}`,
    `COMPLETED ${stats.done}`,
    `AVG RUNTIME ${stats.avg}`,
    ...snap.log.slice(-6).map((l) => l.text.toUpperCase().slice(0, 80)),
    'CHANNEL ENCRYPTED · TLS 1.3',
    'ALL SYSTEMS NOMINAL',
  ];
  const text = items.join('   ◆   ');
  return (
    <footer className="ops-ticker">
      <span className="ticker-tag">LIVE</span>
      <div className="ticker-track">
        <div className="ticker-run">
          <span>{text}</span>
          <span>{text}</span>
        </div>
      </div>
    </footer>
  );
}

function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <header className="modal-head">
          <span className="tag">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width={16} height={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function ConfigForm({
  engine,
  snap,
  host,
  autostart,
  setAutostart,
  awake,
  setAwake,
  updateState,
  onUnpair,
}: {
  engine: BridgeEngine;
  snap: EngineSnapshot;
  host: HostInfo;
  autostart: boolean | null;
  setAutostart: (v: boolean) => void;
  awake: boolean;
  setAwake: (v: boolean) => void;
  updateState: string;
  onUnpair: () => void;
}) {
  const c = snap.config;
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  return (
    <div className="config">
      <button className="secondary" onClick={() => (snap.running ? engine.stop() : engine.start())}>
        {snap.running ? '❚❚ Pause all agents' : '▶ Resume all agents'}
      </button>
      <label className="setting">
        <span>Workspace</span>
        <input defaultValue={c.workspace || host.home} onBlur={(e) => engine.updateConfig({ workspace: e.target.value.trim() })} />
      </label>
      <label className="setting">
        <span>Permissions</span>
        <select value={c.permissionMode || 'bypassPermissions'} onChange={(e) => engine.updateConfig({ permissionMode: e.target.value })}>
          <option value="bypassPermissions">Full access</option>
          <option value="acceptEdits">Edit files only</option>
          <option value="default">Read only (ask = deny)</option>
        </select>
      </label>
      <label className="setting">
        <span>Claude model</span>
        <select value={c.model} onChange={(e) => engine.updateConfig({ model: e.target.value })}>
          <option value="">Default</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
      </label>
      <div className="setting inline">
        <span>Claude Code</span>
        <code className={c.claudePath || host.claudePath ? '' : 'warn'} title={c.claudePath || host.claudePath || ''}>
          {(c.claudePath || host.claudePath || 'Not found').split(/[\\/]/).pop()}
        </code>
      </div>
      <label className="setting">
        <span>Codex model</span>
        <input placeholder="Default" defaultValue={c.codexModel} onBlur={(e) => engine.updateConfig({ codexModel: e.target.value.trim() })} />
      </label>
      <label className="setting">
        <span>Codex CLI path</span>
        <input
          placeholder={snap.workers.codex?.binary || host.codexPath || 'Not found · npm i -g @openai/codex'}
          defaultValue={c.codexPath}
          onBlur={(e) => engine.updateConfig({ codexPath: e.target.value.trim() })}
        />
      </label>
      <label className="setting inline toggle">
        <span>Start with Windows</span>
        <input
          type="checkbox"
          checked={!!autostart}
          onChange={async (e) => {
            localStorage.setItem('nebula.autostart.touched', '1');
            if (e.target.checked) await enableAutostart();
            else await disableAutostart();
            setAutostart(await autostartEnabled());
          }}
        />
      </label>
      <label className="setting inline toggle">
        <span>Keep display awake</span>
        <input type="checkbox" checked={awake} onChange={(e) => setAwake(e.target.checked)} />
      </label>
      <div className="setting inline">
        <span>Full screen</span>
        <code>F11</code>
      </div>
      <div className="setting inline">
        <span>Paired as {engine.node.name}</span>
        <button className={`mini ${confirmUnpair ? 'danger' : ''}`} onClick={() => (confirmUnpair ? onUnpair() : setConfirmUnpair(true))}>
          {confirmUnpair ? 'Sign out + re-pair?' : 'Re-pair this PC'}
        </button>
      </div>
      <div className="update-line">{updateState}</div>
    </div>
  );
}
