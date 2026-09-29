import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface BridgeConfig {
  serviceKey: string;
  workspace: string;
  permissionMode: string;
  claudePath: string;
  /** Legacy single-chat Claude session; moved onto the first Claude chat on upgrade. */
  sessionId: string;
  model: string;
  codexPath: string;
  codexModel: string;
}

export const emptyConfig = (): BridgeConfig => ({
  serviceKey: '',
  workspace: '',
  permissionMode: '',
  claudePath: '',
  sessionId: '',
  model: '',
  codexPath: '',
  codexModel: '',
});

export interface HostInfo {
  machine: string;
  home: string;
  claudePath: string | null;
  codexPath: string | null;
}

export interface ProcessResult {
  exitCode: number | null;
  stderr: string;
  cancelled: boolean;
}

export interface ProcessArgs {
  runId: string;
  program: string;
  args: string[];
  cwd: string;
  stdin?: string;
}

export const loadConfig = async () => ({ ...emptyConfig(), ...(await invoke<Partial<BridgeConfig>>('load_config')) });
export const saveConfig = (config: BridgeConfig) => invoke<void>('save_config', { config });
export const hostInfo = () => invoke<HostInfo>('host_info');
export const cancelProcess = (runId: string) => invoke<boolean>('cancel_agent', { runId });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StreamEvent = any;

/** Runs a CLI on the PC; `onEvent` gets each JSON line it prints to stdout. */
export async function runProcess(args: ProcessArgs, onEvent: (e: StreamEvent) => void): Promise<ProcessResult> {
  const unlisten = await listen<{ runId: string; event: StreamEvent }>('agent-event', (e) => {
    if (e.payload.runId === args.runId) onEvent(e.payload.event);
  });
  try {
    return await invoke<ProcessResult>('run_agent', { args });
  } finally {
    unlisten();
  }
}
