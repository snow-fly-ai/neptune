import { createClient, isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from '../lib/config';
import type { Node } from '../lib/types';
import { saveConfig, type BridgeConfig, type HostInfo } from './native';

/** The bridge config, shared by the engine and the auth session stored inside it. Saves are serialized. */
export class ConfigStore {
  config: BridgeConfig;
  private saving: Promise<void> = Promise.resolve();

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  patch(patch: Partial<BridgeConfig>) {
    this.config = { ...this.config, ...patch };
    const snapshot = this.config;
    this.saving = this.saving.then(() => saveConfig(snapshot)).catch(() => {});
    return this.saving;
  }
}

/**
 * The bridge signs in as its node's agent email. The session lives in bridge.json
 * (`auth`), so it survives reinstalls and WebView data resets.
 */
export function bridgeClient(store: ConfigStore): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'nebula-bridge',
      storage: {
        getItem: (key) => store.config.auth?.[key] ?? null,
        setItem: (key, value) => store.patch({ auth: { ...store.config.auth, [key]: value } }),
        removeItem: (key) => {
          const auth = { ...store.config.auth };
          delete auth[key];
          return store.patch({ auth });
        },
      },
    },
  });
}

/**
 * The node this PC's agent account runs, or null if it has none (removed from the phone).
 * Throws on network errors, so a PC booting before its network is up doesn't unpair itself.
 */
export async function loadNode(client: SupabaseClient): Promise<Node | null> {
  const { data: s } = await client.auth.getSession();
  const email = s.session?.user.email?.toLowerCase();
  if (!email) return null;
  const { data, error } = await client.from('nodes').select('*').eq('agent_email', email).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Node | null) ?? null;
}

/**
 * Bridges up to 0.4 held the service key. Use it once to sign in as this PC's agent
 * email, then drop it from bridge.json. Throws on network errors (the caller retries).
 */
export async function adoptServiceKey(store: ConfigStore, client: SupabaseClient, host: HostInfo): Promise<boolean> {
  const key = store.config.serviceKey;
  if (!key) return false;
  const admin = createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: nodes, error: listError, status } = await admin.from('nodes').select('*');
  if (listError) {
    if (status === 401 || status === 403) return false;
    throw new Error(listError.message);
  }
  const list = (nodes ?? []) as Node[];
  const node = list.find((n) => n.machine?.toLowerCase() === host.machine.toLowerCase()) ?? (list.length === 1 ? list[0] : null);
  if (!node) return false;
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: node.agent_email });
  const code = data?.properties?.email_otp;
  if (error || !code) throw new Error(error?.message || 'No sign-in code');
  const { error: verifyError } = await client.auth.verifyOtp({ email: node.agent_email, token: code, type: 'email' });
  if (verifyError) throw new Error(verifyError.message);
  await store.patch({ serviceKey: '' });
  return true;
}

/**
 * Signs the bridge in from what bridge.json holds and finds its node; null means pair.
 * Retries through network errors, so booting offline never drops the session.
 */
export async function connect(store: ConfigStore, client: SupabaseClient, host: HostInfo, onWaiting: (why: string) => void): Promise<Node | null> {
  for (;;) {
    try {
      let { data, error } = await client.auth.getSession();
      if (!data.session && error && isAuthRetryableFetchError(error)) throw error;
      if (!data.session && (await adoptServiceKey(store, client, host))) ({ data } = await client.auth.getSession());
      return data.session ? await loadNode(client) : null;
    } catch (e) {
      onWaiting(e instanceof Error ? e.message : String(e));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
