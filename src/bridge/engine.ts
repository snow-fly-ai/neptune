import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { notify } from '../lib/notify';
import { SUPABASE_URL } from '../lib/config';
import type { AgentUsage, Message } from '../lib/types';
import { ADAPTERS, type AgentAdapter, type TaskOutcome } from './agents';
import { cancelProcess, hostInfo, saveConfig, type BridgeConfig, type HostInfo } from './native';
import { inTauri } from '../lib/platform';

export interface LogEntry {
  id: number;
  at: number;
  kind: 'info' | 'task' | 'tool' | 'done' | 'error';
  text: string;
  agent?: string;
}

export interface LoginCode {
  email: string;
  code: string;
  expires_at: string;
}

/** One agent's queue on this PC. */
export interface WorkerState {
  id: string;
  name: string;
  /** CLI path, or null when that agent isn't installed here. */
  binary: string | null;
  busy: boolean;
  /** Paused on this PC: stays online, leaves its queue alone. */
  paused: boolean;
  current: Message | null;
  activity: string | null;
  usage: AgentUsage | null;
}

export interface EngineSnapshot {
  loginCode: LoginCode | null;
  running: boolean;
  workers: Record<string, WorkerState>;
  /** Any agent working; `current`/`activity` show the first busy one for the console. */
  busy: boolean;
  activity: string | null;
  current: Message | null;
  currentAgent: string | null;
  log: LogEntry[];
  config: BridgeConfig;
}

const HEARTBEAT_MS = 20_000;
const POLL_MS = 15_000;

export class BridgeEngine {
  readonly client: SupabaseClient;
  private config: BridgeConfig;
  private host: HostInfo;
  private version: string;
  private listeners = new Set<() => void>();
  private timers: number[] = [];
  private logSeq = 0;
  private lastActivityPush: Record<string, number> = {};
  private pendingActivity: Record<string, number | undefined> = {};
  private snapshot: EngineSnapshot;

  constructor(config: BridgeConfig, host: HostInfo, version: string) {
    this.config = config;
    this.host = host;
    this.version = version;
    this.client = createClient(SUPABASE_URL, config.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const workers: Record<string, WorkerState> = {};
    for (const a of ADAPTERS) {
      workers[a.id] = {
        id: a.id,
        name: a.name,
        binary: a.binary(config, host),
        busy: false,
        paused: (config.pausedAgents ?? []).includes(a.id),
        current: null,
        activity: null,
        usage: null,
      };
    }
    this.snapshot = {
      loginCode: null,
      running: false,
      workers,
      busy: false,
      activity: null,
      current: null,
      currentAgent: null,
      log: [],
      config,
    };
  }

  // ---- store plumbing for React -------------------------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  private set(patch: Partial<EngineSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
  private setWorker(id: string, patch: Partial<WorkerState>) {
    const workers = { ...this.snapshot.workers, [id]: { ...this.snapshot.workers[id], ...patch } };
    const lead = Object.values(workers).find((w) => w.busy && w.current);
    this.set({
      workers,
      busy: Object.values(workers).some((w) => w.busy),
      current: lead?.current ?? null,
      activity: lead?.activity ?? null,
      currentAgent: lead?.id ?? null,
    });
  }
  private log(kind: LogEntry['kind'], text: string, agent?: string) {
    const entry = { id: ++this.logSeq, at: Date.now(), kind, text: agent ? `[${agent.toUpperCase()}] ${text}` : text, agent };
    this.set({ log: [...this.snapshot.log.slice(-299), entry] });
  }

  async updateConfig(patch: Partial<BridgeConfig>) {
    this.config = { ...this.config, ...patch };
    await saveConfig(this.config);
    this.set({ config: this.config });
    this.refreshBinaries();
  }

  private refreshBinaries() {
    for (const a of ADAPTERS) {
      const binary = a.binary(this.config, this.host);
      if (binary !== this.snapshot.workers[a.id].binary) this.setWorker(a.id, { binary });
    }
  }

  /** Picks up CLIs installed while the bridge was running. */
  private async rescanHost() {
    if (!inTauri()) return;
    try {
      this.host = await hostInfo();
      this.refreshBinaries();
    } catch {
      /* keep the last scan */
    }
  }

  private adapters(installedOnly = true) {
    return ADAPTERS.filter((a) => !installedOnly || !!this.snapshot.workers[a.id].binary);
  }

  // ---- lifecycle -------------------------------------------------------------------
  async start() {
    if (this.snapshot.running) return;
    this.set({ running: true });
    const found = this.adapters().map((a) => a.name);
    this.log('info', `Bridge started on ${this.host.machine} · agents: ${found.length ? found.join(', ') : 'none found'}`);
    await this.migrateLegacySession();
    for (const a of this.adapters()) await this.recoverInterrupted(a);

    this.client
      .channel('bridge-inbox')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'sender=eq.user' }, (p) => {
        const m = p.new as Message;
        if (m.body.trim() === '/stop') this.stopChat(m);
        else this.kickAll();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'login_codes' }, (p) => {
        this.showLoginCode(p.new as LoginCode);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') this.log('info', 'Listening for messages (realtime)');
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.log('error', `Realtime ${status.toLowerCase()}; polling instead`);
      });

    this.heartbeat();
    this.timers.push(window.setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(window.setInterval(() => this.kickAll(), POLL_MS));
    window.addEventListener('beforeunload', this.goOffline);
    this.kickAll();
  }

  async stop() {
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
    await this.client.removeAllChannels();
    await this.goOffline();
    this.set({ running: false });
    this.log('info', 'Bridge paused');
  }

  /** Before chats existed there was one Claude session in bridge.json; hand it to the first Claude chat. */
  private async migrateLegacySession() {
    const sid = this.config.sessionId;
    if (!sid) return;
    const { data } = await this.client
      .from('chats')
      .select('id')
      .eq('agent_id', 'claude')
      .is('session_id', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) await this.client.from('chats').update({ session_id: sid }).eq('id', data.id);
    await this.updateConfig({ sessionId: '' });
  }

  /** Phone sign-in codes are shown here (and as a Windows notification) rather than emailed. */
  private showLoginCode(c: LoginCode) {
    if (Date.parse(c.expires_at) < Date.now()) return;
    this.set({ loginCode: c });
    this.log('info', `Sign-in code requested for ${c.email}`);
    notify('Nebula sign-in code', `${c.code} for ${c.email}`);
  }

  /** A line in the console's event log. */
  note(text: string) {
    this.log('info', text);
  }

  dismissLoginCode() {
    this.set({ loginCode: null });
  }

  /** Pausing lets a running task finish; the agent just stops taking new ones until resumed. */
  async setPaused(agent: string, paused: boolean) {
    const w = this.snapshot.workers[agent];
    if (!w || w.paused === paused) return;
    this.setWorker(agent, { paused });
    const list = new Set(this.config.pausedAgents ?? []);
    if (paused) list.add(agent);
    else list.delete(agent);
    await this.updateConfig({ pausedAgents: [...list] });
    this.log('info', paused ? 'Paused · new messages wait in its queue' : 'Resumed', agent);
    if (this.snapshot.running) {
      await this.client.from('agents').update({ paused }).eq('id', agent);
      if (!paused) this.kick(ADAPTERS.find((a) => a.id === agent)!);
    }
  }

  private async saveUsage(agent: string, usage: AgentUsage) {
    this.setWorker(agent, { usage });
    const { error } = await this.client.from('agents').update({ usage }).eq('id', agent);
    if (error) this.log('error', `Could not save usage: ${error.message}`, agent);
  }

  private goOffline = async () => {
    const ids = ADAPTERS.map((a) => a.id);
    await this.client.from('agents').update({ online: false, paused: false, activity: null, current_chat_id: null }).in('id', ids);
  };

  private async heartbeat() {
    await this.rescanHost();
    const rows = this.adapters().map((a) => {
      const w = this.snapshot.workers[a.id];
      return {
        id: a.id,
        name: a.name,
        online: true,
        paused: w.paused,
        last_seen: new Date().toISOString(),
        machine: this.host.machine,
        version: this.version,
        activity: w.busy ? w.activity : null,
        current_chat_id: w.current?.chat_id ?? null,
      };
    });
    if (!rows.length) return;
    const { error } = await this.client.from('agents').upsert(rows);
    if (error) this.log('error', `Heartbeat failed: ${error.message}`);
  }

  private setActivity(agent: string, text: string | null, force = false) {
    this.setWorker(agent, { activity: text });
    const push = () => {
      const w = this.snapshot.workers[agent];
      this.lastActivityPush[agent] = Date.now();
      this.pendingActivity[agent] = undefined;
      this.client
        .from('agents')
        .update({ activity: w.activity, current_chat_id: w.busy ? (w.current?.chat_id ?? null) : null, last_seen: new Date().toISOString() })
        .eq('id', agent)
        .then();
    };
    const wait = 1200 - (Date.now() - (this.lastActivityPush[agent] ?? 0));
    if (force || wait <= 0) {
      window.clearTimeout(this.pendingActivity[agent]);
      push();
    } else if (this.pendingActivity[agent] === undefined) {
      this.pendingActivity[agent] = window.setTimeout(push, wait);
    }
  }

  /** A task left "processing" means the bridge died mid-run; don't silently re-run it. */
  private async recoverInterrupted(a: AgentAdapter) {
    const { data } = await this.client
      .from('messages')
      .select('id, chat_id, chats!inner(agent_id)')
      .eq('sender', 'user')
      .eq('status', 'processing')
      .eq('chats.agent_id', a.id);
    for (const m of (data ?? []) as { id: string; chat_id: string }[]) {
      await this.client.from('messages').update({ status: 'error' }).eq('id', m.id);
      await this.reply(m.chat_id, m.id, 'That task was interrupted because the Nebula bridge restarted. Send it again if you still need it.', 'system');
    }
  }

  // ---- queue -------------------------------------------------------------------------
  private async claimNext(agent: string): Promise<Message | null> {
    const { data, error } = await this.client.rpc('claim_next_message', { p_agent: agent }).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Message | null) ?? null;
  }

  kickAll = () => {
    for (const a of this.adapters()) this.kick(a);
  };

  /** Works one agent's queue, one task at a time. Different agents run side by side. */
  private async kick(a: AgentAdapter) {
    const w = this.snapshot.workers[a.id];
    if (!this.snapshot.running || w.busy || w.paused) return;
    this.setWorker(a.id, { busy: true });
    try {
      let m: Message | null;
      while (this.snapshot.running && !this.snapshot.workers[a.id].paused && (m = await this.claimNext(a.id))) {
        this.setWorker(a.id, { current: m });
        await this.handle(a, m);
        this.setWorker(a.id, { current: null });
      }
    } catch (e) {
      this.log('error', `Queue error: ${String(e)}`, a.id);
    } finally {
      this.setWorker(a.id, { busy: false, current: null });
      this.setActivity(a.id, null, true);
    }
  }

  private async reply(chatId: string, replyTo: string | null, body: string, sender: 'agent' | 'system' = 'agent', meta: object = {}) {
    const { error } = await this.client.from('messages').insert({ chat_id: chatId, sender, body, status: 'sent', reply_to: replyTo, meta });
    if (error) this.log('error', `Could not post reply: ${error.message}`);
  }

  private async finish(m: Message, status: Message['status']) {
    await this.client.from('messages').update({ status }).eq('id', m.id);
  }

  private async chatSession(chatId: string): Promise<string | null> {
    const { data } = await this.client.from('chats').select('session_id').eq('id', chatId).maybeSingle();
    return (data?.session_id as string | null) ?? null;
  }

  private async setChatSession(chatId: string, sessionId: string | null) {
    await this.client.from('chats').update({ session_id: sessionId }).eq('id', chatId);
  }

  private async handle(a: AgentAdapter, m: Message) {
    const body = m.body.trim();
    this.log('task', body.length > 140 ? `${body.slice(0, 139)}…` : body, a.id);

    if (body === '/new') {
      await this.setChatSession(m.chat_id, null);
      await this.reply(m.chat_id, m.id, `Started a fresh ${a.name} session in this chat. I won’t remember the earlier messages.`, 'system');
      return this.finish(m, 'done');
    }
    if (body === '/stop') {
      return this.finish(m, 'done');
    }
    if (body === '/status') {
      const session = await this.chatSession(m.chat_id);
      const model = a.model(this.config);
      await this.reply(
        m.chat_id,
        m.id,
        `**Agent:** ${a.name}${model ? ` · ${model}` : ''}\n\n**Bridge:** ${this.host.machine} · v${this.version}\n\n**Workspace:** \`${this.workspace()}\`\n\n**Permissions:** ${this.config.permissionMode || 'bypassPermissions'}\n\n**Session:** ${session ? `\`${session.slice(0, 8)}\`` : 'new'}`,
      );
      return this.finish(m, 'done');
    }
    await this.runTask(a, m);
  }

  private workspace() {
    return this.config.workspace || this.host.home;
  }

  /** Cancels the running task in the chat a phone /stop was sent from. */
  private stopChat(stopMsg: Message) {
    for (const w of Object.values(this.snapshot.workers)) {
      if (w.current && w.current.chat_id === stopMsg.chat_id) {
        this.log('info', 'Stop requested from phone', w.id);
        cancelProcess(w.current.id);
      }
    }
    // Mark the /stop itself handled so it never runs as a task.
    this.client.from('messages').update({ status: 'done' }).eq('id', stopMsg.id).eq('status', 'queued').then();
  }

  /** Desktop abort: stops one agent's task, or every running task. */
  stopCurrent(agent?: string) {
    for (const w of Object.values(this.snapshot.workers)) {
      if (w.current && (!agent || w.id === agent)) {
        this.log('info', 'Stop requested', w.id);
        cancelProcess(w.current.id);
      }
    }
  }

  private async runTask(a: AgentAdapter, m: Message, retried = false): Promise<void> {
    const binary = a.binary(this.config, this.host);
    if (!binary) {
      await this.reply(m.chat_id, m.id, `I can’t find the ${a.name} CLI on the PC. Install it, or set its path in the Nebula bridge config.`, 'system');
      return this.finish(m, 'error');
    }
    const cwd = this.workspace();
    const sessionId = retried ? null : await this.chatSession(m.chat_id);
    this.setActivity(a.id, 'Thinking…', true);
    let steps = 0;
    let out: TaskOutcome;
    try {
      out = await a.run(
        { runId: m.id, prompt: m.body, cwd, sessionId, config: this.config, host: this.host },
        {
          activity: (text, step) => {
            if (step) {
              steps++;
              this.log('tool', text, a.id);
            }
            this.setActivity(a.id, text);
          },
          session: (id) => {
            if (id !== sessionId) this.setChatSession(m.chat_id, id);
          },
          usage: (u) => {
            this.saveUsage(a.id, u);
          },
        },
      );
    } catch (e) {
      this.log('error', String(e), a.id);
      await this.reply(m.chat_id, m.id, `I couldn't start ${a.name}: ${String(e)}`, 'system');
      return this.finish(m, 'error');
    }

    if (out.cancelled) {
      this.log('info', 'Task stopped', a.id);
      await this.reply(m.chat_id, m.id, 'Stopped. Anything already changed stays as it is.', 'system');
      return this.finish(m, 'cancelled');
    }

    if (!retried && sessionId && out.staleSession) {
      this.log('info', 'Previous session not found; starting a new one', a.id);
      await this.setChatSession(m.chat_id, null);
      return this.runTask(a, m, true);
    }

    if (out.text == null) {
      const tail = out.stderr.trim().split('\n').slice(-6).join('\n') || `exit code ${out.exitCode}`;
      this.log('error', tail, a.id);
      await this.reply(m.chat_id, m.id, `${a.name} exited without a result:\n\n\`\`\`\n${tail}\n\`\`\``, 'system');
      return this.finish(m, 'error');
    }

    if (out.sessionId) await this.setChatSession(m.chat_id, out.sessionId);
    await this.reply(m.chat_id, m.id, out.text, 'agent', { ...out.meta, agent: a.id });
    const secs = Math.round((out.meta.duration_ms || 0) / 1000);
    this.log(out.isError ? 'error' : 'done', `${out.isError ? 'Failed' : 'Done'} · ${steps} steps · ${secs}s`, a.id);
    return this.finish(m, out.isError ? 'error' : 'done');
  }

  /** Lets the desktop post a note to the phone, into the most recently active chat. */
  async sendNote(body: string) {
    const { data } = await this.client.from('chats').select('id').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!data) return this.log('error', 'No chat to post into yet');
    await this.reply(data.id, null, body, 'agent', { agent: 'bridge' });
  }
}
