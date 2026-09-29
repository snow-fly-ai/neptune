export const SUPABASE_URL = 'https://onbkumnokabovfduxzow.supabase.co';
// Publishable key: safe to ship in the client; row-level security guards the data.
export const SUPABASE_KEY = 'sb_publishable_ZiRNUwppZngXSqAsziMr-w_5yOo_WNW';

export const GITHUB_REPO = 'snow-fly-ai/nebula';

/** Agent counts as online if it sent a heartbeat this recently. */
export const ONLINE_WINDOW_MS = 75_000;

/** QR payloads: the PC shows them, the phone scans them. */
export const loginQr = (email: string, code: string) => `nebula:login:${email}:${code}`;
export const pairQr = (code: string) => `nebula:pair:${code}`;

export type QrPayload = { kind: 'login'; email: string; code: string } | { kind: 'pair'; code: string };

export function parseQr(text: string): QrPayload | null {
  const t = text.trim();
  let m = /^nebula:login:(\S+@\S+):(\d{6,10})$/i.exec(t);
  if (m) return { kind: 'login', email: m[1].toLowerCase(), code: m[2] };
  m = /^nebula:pair:([A-Z0-9]{8})$/i.exec(t);
  if (m) return { kind: 'pair', code: m[1].toUpperCase() };
  return null;
}
