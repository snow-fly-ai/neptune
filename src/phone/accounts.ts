import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from '../lib/config';

// The phone can stay signed in to several operator accounts (say, home and work)
// and switch between them. Each account keeps its own session under its own key.

const LIST_KEY = 'nebula.accounts';
const ACTIVE_KEY = 'nebula.account';
/** Before accounts, the one session lived here. */
const LEGACY_KEY = 'nebula-auth';

const clients = new Map<string, SupabaseClient>();

export function clientFor(email: string): SupabaseClient {
  let c = clients.get(email);
  if (!c) {
    c = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: `nebula-auth:${email}` },
    });
    clients.set(email, c);
  }
  return c;
}

export function listAccounts(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

export function saveAccounts(list: string[]) {
  localStorage.setItem(LIST_KEY, JSON.stringify([...new Set(list)]));
}

export const activeAccount = () => localStorage.getItem(ACTIVE_KEY);
export const setActiveAccount = (email: string | null) =>
  email ? localStorage.setItem(ACTIVE_KEY, email) : localStorage.removeItem(ACTIVE_KEY);

/** Carries a pre-accounts session over, so updating doesn't sign anyone out. */
export function adoptLegacySession() {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const email = JSON.parse(raw)?.user?.email?.toLowerCase();
    if (email) {
      localStorage.setItem(`nebula-auth:${email}`, raw);
      saveAccounts([...listAccounts(), email]);
      if (!activeAccount()) setActiveAccount(email);
    }
  } catch {
    /* unreadable: sign in again */
  }
  localStorage.removeItem(LEGACY_KEY);
}

/** Signs out and forgets the account on this phone. */
export async function forgetAccount(email: string) {
  if (!clients.has(email) && !listAccounts().includes(email)) return;
  // Drop it first: signing out fires SIGNED_OUT, which calls back in here.
  const client = clientFor(email);
  clients.delete(email);
  saveAccounts(listAccounts().filter((e) => e !== email));
  if (activeAccount() === email) setActiveAccount(listAccounts()[0] ?? null);
  await client.auth.signOut({ scope: 'local' }).catch(() => {});
  client.removeAllChannels();
}
