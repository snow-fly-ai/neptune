/**
 * Agent adapters: how the bridge drives each coding CLI. An adapter builds the
 * command line, turns the CLI's JSON events into phone-friendly activity lines,
 * and reduces a run to one reply. Adding an agent = one adapter here plus its
 * row in the `agents` table.
 */
import type { MessageMeta } from '../lib/types';
import { runProcess, type BridgeConfig, type HostInfo } from './native';

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
    `You are ${agentName}, running headlessly on the user's Windows PC "${host.machine}" through Relay, a chat app.`,
    `The user is messaging you from the Relay app on their Android phone. They cannot see your terminal or tool output, only your final reply, which arrives as a push notification and chat message.`,
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
const STALE = /No conversation found|session.*not found|no rollout found|thread.*not found/i;

// ---- Claude Code ----------------------------------------------------------------------

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

/** Relay's permission modes mapped onto Codex's sandbox/approval flags. */
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
    // `codex exec` has no system-prompt flag, so a new thread gets the Relay context up front.
    const input = sessionId
      ? prompt
      : `<relay_context>\n${systemPrompt('Codex', host, cwd)}\n</relay_context>\n\n${prompt}`;
    const args = ['exec', '--json', '--skip-git-repo-check', '--cd', cwd, ...codexSandbox(config.permissionMode)];
    if (nonEmpty(config.codexModel)) args.push('--model', config.codexModel.trim());
    // A prompt of "-" reads it from stdin.
    args.push(...(sessionId ? ['resume', sessionId, '-'] : ['-']));

    const started = Date.now();
    let thread: string | undefined;
    let reply = '';
    let failure = '';
    let completed = false;
    const usage = { input: 0, output: 0 };
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
          usage.output += e.usage?.output_tokens ?? 0;
          break;
        case 'turn.failed':
          failure = e.error?.message || 'The turn failed.';
          break;
        case 'error':
          failure = e.message || failure;
          break;
      }
    });

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
        input_tokens: usage.input || undefined,
        output_tokens: usage.output || undefined,
        is_error: isError,
      },
    };
  },
};

export const ADAPTERS: AgentAdapter[] = [claude, codex];
