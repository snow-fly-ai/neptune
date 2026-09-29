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
  updated_at: string;
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
