/**
 * Agent adapters: how the bridge drives each coding CLI. An adapter builds the
 * command line, turns the CLI's JSON events into phone-friendly activity lines,
 * and reduces a run to one reply. Adding an agent = one adapter here plus its
 * row in the `agents` table.
 */
import type { AgentUsage, MessageMeta, UsageWindow } from '../lib/types';
import { codexRateLimits, runProcess, type BridgeConfig, type HostInfo } from './native';

export interface TaskInput {
  runId: string;
  prompt: string;
  cwd: string;
  /** The chat's agent-side conversation id, if it has one yet. */
  sessionId: string | null;
  config: BridgeConfig;
  host: HostInfo;
}

export interface TaskHooks {
  /** "What I'm doing now" for the phone. `step` marks a tool call for the event log. */
  activity: (text: string, step?: boolean) => void;
  /** The CLI announced (or changed) the conversation id. */
  session: (id: string) => void;
  /** The CLI reported the account's plan limits. */
  usage: (usage: AgentUsage) => void;
}

export interface TaskOutcome {
  cancelled: boolean;
  /** The reply, or null when the CLI ended without producing one. */
  text: string | null;
  isError: boolean;
  sessionId?: string;
  /** Resuming failed because the CLI no longer knows the session. */
  staleSession: boolean;
  stderr: string;
  exitCode: number | null;
  meta: MessageMeta;
}

export interface AgentAdapter {
  id: string;
  name: string;
  /** Resolved path of the CLI, or null when it isn't installed. */
  binary: (config: BridgeConfig, host: HostInfo) => string | null;
  model: (config: BridgeConfig) => string;
  run: (input: TaskInput, hooks: TaskHooks) => Promise<TaskOutcome>;
}

export function systemPrompt(agentName: string, host: HostInfo, cwd: string) {
  return [
    `You are ${agentName}, running headlessly on the user's Windows PC "${host.machine}" through Nebula, a chat app.`,
    `The user is messaging you from the Nebula app on their Android phone. They cannot see your terminal or tool output, only your final reply, which arrives as a push notification and chat message.`,
    `Work autonomously and finish the task end-to-end; don't stop to ask for confirmation on routine steps. If you truly need a decision, ask one clear question and stop.`,
    `Finish with a concise, phone-friendly reply: lead with the outcome, then short bullets. Avoid long code blocks unless asked.`,
    `Working directory: ${cwd}.`,
  ].join('\n');
}

const base = (p: string) => String(p || '').split(/[\\/]/).pop() || p;
const clip = (s: string, n = 90) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const nonEmpty = (s: string | null | undefined) => (s && s.trim() ? s.trim() : undefined);
const epochIso = (secs: unknown) => (typeof secs === 'number' && secs > 0 ? new Date(secs * 1000).toISOString() : null);
const pct = (n: unknown, scale = 1) => Math.max(0, Math.min(100, Math.round(Number(n) * scale * 10) / 10));
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
};
const STALE = /No conversation found|session.*not found|no rollout found|thread.*not found/i;

// ---- Claude Code ----------------------------------------------------------------------

/** `rate_limit_event` → plan usage. `unifiedWindows` lists every window; older CLIs report only the binding one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function claudeUsage(info: any): AgentUsage | null {
  if (!info) return null;
  const windows: UsageWindow[] = [];
  const all = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null;
  if (all) {
    for (const [id, w] of Object.entries(all) as [string, { utilization?: number; resetsAt?: number }][]) {
      if (typeof w?.utilization !== 'number') continue;
      windows.push({ id, label: WINDOW_LABELS[id] ?? id.replace(/_/g, ' '), pct: pct(w.utilization, 100), resets_at: epochIso(w.resetsAt) });
    }
  } else if (typeof info.utilization === 'number' && info.rateLimitType) {
    const id = String(info.rateLimitType);
    windows.push({ id, label: WINDOW_LABELS[id] ?? id, pct: pct(info.utilization, 100), resets_at: epochIso(info.resetsAt) });
  }
  if (!windows.length) return null;
  return { windows, status: info.status, at: new Date().toISOString() };
}

/** One-line, human description of a Claude Code tool call for the phone's activity bar. */
export function describeTool(name: string, input: Record<string, unknown> = {}): string {
  const i = input as Record<string, string>;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `Running ${clip(i.description || i.command, 80)}`;
    case 'Read':
      return `Reading ${base(i.file_path)}`;
    case 'Write':
      return `Writing ${base(i.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${base(i.file_path || i.notebook_path)}`;
    case 'Grep':
      return `Searching for “${clip(i.pattern, 40)}”`;
    case 'Glob':
      return `Finding files ${clip(i.pattern, 40)}`;
    case 'WebSearch':
      return `Searching the web: ${clip(i.query, 60)}`;
    case 'WebFetch':
      return `Reading ${clip(i.url, 60)}`;
    case 'Task':
    case 'Agent':
      return `Delegating: ${clip(i.description, 60)}`;
    case 'TodoWrite':
      return 'Planning next steps';
    default:
      return `Using ${name.replace(/^mcp__[^_]+__/, '')}`;
  }
}

const claude: AgentAdapter = {
  id: 'claude',
  name: 'Claude',
  binary: (c, h) => nonEmpty(c.claudePath) ?? h.claudePath,
  model: (c) => c.model,
  async run({ runId, prompt, cwd, sessionId, config, host }, hooks) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', config.permissionMode || 'bypassPermissions'];
    if (sessionId) args.push('--resume', sessionId);
    if (nonEmpty(config.model)) args.push('--model', config.model.trim());
    args.push('--append-system-prompt', systemPrompt('Claude', host, cwd));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = null;
    const res = await runProcess({ runId, program: this.binary(config, host)!, args, cwd, stdin: prompt }, (e) => {
      if (e.type === 'system' && e.subtype === 'init' && e.session_id) hooks.session(e.session_id);
      if (e.type === 'result') result = e;
      if (e.type === 'rate_limit_event') {
        const u = claudeUsage(e.rate_limit_info);
        if (u) hooks.usage(u);
      }
      if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) {
          if (c.type === 'tool_use') hooks.activity(describeTool(c.name, c.input), true);
          else if (c.type === 'text' && c.text?.trim()) hooks.activity('Writing a reply…');
          else if (c.type === 'thinking') hooks.activity('Thinking…');
        }
      }
    });

    const common = { cancelled: res.cancelled, stderr: res.stderr, exitCode: res.exitCode };
    const stale = !!sessionId && STALE.test(`${res.stderr} ${result?.result ?? ''}`);
    if (!result) return { ...common, text: null, isError: true, staleSession: stale, meta: {} };

    const text = String(result.result || '').trim() || (result.is_error ? `Something went wrong (${result.subtype}).` : 'Done.');
    const loginHint = /not logged in|\/login/i.test(text)
      ? '\n\nThe Claude Code CLI on the PC isn’t signed in. Run `claude auth login` on the PC once.'
      : '';
    return {
      ...common,
      text: text + loginHint,
      isError: !!result.is_error,
      sessionId: result.session_id,
      staleSession: stale,
      meta: {
        cost_usd: result.total_cost_usd,
        duration_ms: result.duration_ms,
        session_id: result.session_id,
        turns: result.num_turns,
        is_error: result.is_error,
        input_tokens: result.usage?.input_tokens,
        output_tokens: result.usage?.output_tokens,
        cache_read_tokens: result.usage?.cache_read_input_tokens,
        cache_write_tokens: result.usage?.cache_creation_input_tokens,
        model: Object.keys(result.modelUsage ?? {})[0],
      },
    };
  },
};

// ---- Codex CLI ------------------------------------------------------------------------

/** `codex exec --json` item → activity line. Returns null for items that aren't worth showing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeCodexItem(item: any): string | null {
  switch (item?.type) {
    case 'command_execution':
      return `Running ${clip(item.command, 80)}`;
    case 'file_change': {
      const files = (item.changes ?? []).map((c: { path: string }) => base(c.path));
      return files.length ? `Editing ${files.slice(0, 2).join(', ')}${files.length > 2 ? ` +${files.length - 2}` : ''}` : 'Editing files';
    }
    case 'mcp_tool_call':
      return `Using ${item.tool || item.server || 'a tool'}`;
    case 'web_search':
      return `Searching the web: ${clip(item.query, 60)}`;
    case 'todo_list':
      return 'Planning next steps';
    case 'reasoning':
      return 'Thinking…';
    default:
      return null;
  }
}

/**
 * Codex `rate_limits` ({ primary, secondary }, each { used_percent, window_minutes, resets_at | resets_in_seconds })
 * → plan usage. Codex writes these into its session log rather than the exec stream.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function codexUsage(limits: any): AgentUsage | null {
  if (!limits || typeof limits !== 'object') return null;
  const windows: UsageWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = limits[key];
    if (!w || typeof w.used_percent !== 'number') continue;
    const mins = Number(w.window_minutes) || 0;
    const label = mins === 300 ? '5-hour' : mins === 10080 ? 'Weekly' : mins ? (mins % 1440 ? `${Math.round(mins / 60)}-hour` : `${mins / 1440}-day`) : key;
    const resets = epochIso(w.resets_at) ?? (typeof w.resets_in_seconds === 'number' ? new Date(Date.now() + w.resets_in_seconds * 1000).toISOString() : null);
    windows.push({ id: key, label, pct: pct(w.used_percent), resets_at: resets });
  }
  return windows.length ? { windows, at: new Date().toISOString() } : null;
}

/** Nebula's permission modes mapped onto Codex's sandbox/approval flags. */
function codexSandbox(mode: string) {
  if (mode === 'acceptEdits') return ['--full-auto'];
  if (mode === 'default') return ['--sandbox', 'read-only'];
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

const codex: AgentAdapter = {
  id: 'codex',
  name: 'Codex',
  binary: (c, h) => nonEmpty(c.codexPath) ?? h.codexPath,
  model: (c) => c.codexModel,
  async run({ runId, prompt, cwd, sessionId, config, host }, hooks) {
    // `codex exec` has no system-prompt flag, so a new thread gets the Nebula context up front.
    const input = sessionId
      ? prompt
      : `<nebula_context>\n${systemPrompt('Codex', host, cwd)}\n</nebula_context>\n\n${prompt}`;
    const args = ['exec', '--json', '--skip-git-repo-check', '--cd', cwd, ...codexSandbox(config.permissionMode)];
    if (nonEmpty(config.codexModel)) args.push('--model', config.codexModel.trim());
    // A prompt of "-" reads it from stdin.
    args.push(...(sessionId ? ['resume', sessionId, '-'] : ['-']));

    const started = Date.now();
    let thread: string | undefined;
    let reply = '';
    let failure = '';
    let completed = false;
    const usage = { input: 0, cached: 0, output: 0 };
    const res = await runProcess({ runId, program: this.binary(config, host)!, args, cwd, stdin: input }, (e) => {
      switch (e.type) {
        case 'thread.started':
          thread = e.thread_id;
          if (thread) hooks.session(thread);
          break;
        case 'turn.started':
          hooks.activity('Thinking…');
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = e.item;
          if (item?.type === 'agent_message') {
            if (e.type === 'item.completed' && item.text) reply = item.text;
            hooks.activity('Writing a reply…');
          } else if (item?.type === 'error') {
            failure = item.message || failure;
          } else {
            const text = describeCodexItem(item);
            if (text) hooks.activity(text, e.type === 'item.started' && item?.type !== 'reasoning');
          }
          break;
        }
        case 'turn.completed':
          completed = true;
          usage.input += e.usage?.input_tokens ?? 0;
          usage.cached += e.usage?.cached_input_tokens ?? 0;
          usage.output += e.usage?.output_tokens ?? 0;
          break;
        case 'turn.failed':
          failure = e.error?.message || 'The turn failed.';
          break;
        case 'error':
          failure = e.message || failure;
          break;
      }
      if (e.rate_limits) {
        const u = codexUsage(e.rate_limits);
        if (u) hooks.usage(u);
      }
    });
    if (thread) {
      const u = codexUsage(await codexRateLimits(thread).catch(() => null));
      if (u) hooks.usage(u);
    }

    const common = { cancelled: res.cancelled, stderr: res.stderr, exitCode: res.exitCode };
    const stale = !!sessionId && !thread && STALE.test(`${res.stderr} ${failure}`);
    const isError = !!failure && !completed;
    const text = reply.trim() || (failure ? `Codex failed: ${failure}` : completed ? 'Done.' : null);
    const loginHint = /401|unauthori[sz]ed|not logged in|login/i.test(failure)
      ? '\n\nThe Codex CLI on the PC isn’t signed in. Run `codex login` on the PC once.'
      : '';
    return {
      ...common,
      text: text && text + loginHint,
      isError: isError || (!reply && !completed),
      sessionId: thread ?? sessionId ?? undefined,
      staleSession: stale,
      meta: {
        duration_ms: Date.now() - started,
        session_id: thread ?? sessionId ?? undefined,
        // Codex counts cached tokens inside input_tokens.
        input_tokens: usage.input - usage.cached || undefined,
        cache_read_tokens: usage.cached || undefined,
        output_tokens: usage.output || undefined,
        model: nonEmpty(config.codexModel),
        is_error: isError,
      },
    };
  },
};

export const ADAPTERS: AgentAdapter[] = [claude, codex];
