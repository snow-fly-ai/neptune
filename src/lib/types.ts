export type Sender = 'user' | 'agent' | 'system';
export type MessageStatus = 'sent' | 'queued' | 'processing' | 'done' | 'error' | 'cancelled';

export interface MessageMeta {
  agent?: string;
  cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  is_error?: boolean;
  turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  /** Prompt tokens served from / written to the cache (Claude). */
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  model?: string;
}

export interface Message {
  id: string;
  chat_id: string;
  sender: Sender;
  body: string;
  status: MessageStatus;
  reply_to: string | null;
  meta: MessageMeta;
  created_at: string;
  updated_at: string;
}

/** One row per agent (claude, codex, …), kept fresh by whatever runs that agent. */
export interface Agent {
  id: string;
  name: string;
  online: boolean;
  activity: string | null;
  current_chat_id: string | null;
  machine: string | null;
  version: string | null;
  last_seen: string | null;
  /** Paused on the desktop: online, but its queue waits. */
  paused: boolean;
  usage: AgentUsage | null;
  updated_at: string;
}

/** One plan-limit window, e.g. Claude's 5-hour or weekly limit. */
export interface UsageWindow {
  id: string;
  label: string;
  /** 0–100. */
  pct: number;
  resets_at: string | null;
}

/** Plan limits as the agent's CLI last reported them. */
export interface AgentUsage {
  windows: UsageWindow[];
  status?: string;
  /** When the CLI reported this. */
  at: string;
}

export interface Chat {
  id: string;
  agent_id: string;
  title: string | null;
  session_id: string | null;
  preview: string | null;
  last_sender: Sender | null;
  created_at: string;
  updated_at: string;
}
