import { createContext, useContext } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The signed-in account the phone is showing (see accounts.ts). */
export const ClientContext = createContext<SupabaseClient | null>(null);

export function useClient(): SupabaseClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('No account client');
  return c;
}
