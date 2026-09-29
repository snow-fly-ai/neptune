import type { SupabaseClient } from '@supabase/supabase-js';

/** Calls an edge function; its `{ error }` body (even on a non-2xx status) becomes the thrown message. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callFn(client: SupabaseClient, name: string, body: object): Promise<any> {
  const { data, error } = await client.functions.invoke(name, { body });
  if (data?.error) throw new Error(data.error);
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}
