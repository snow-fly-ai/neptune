// Issues a one-time Supabase Auth sign-in code for a node's operator email and hands
// it to that node's PC (via public.login_requests), which shows it as a QR code for
// the phone to scan. Nothing is emailed: the free tier's mailer can't carry codes.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const { email: raw } = await req.json().catch(() => ({ email: '' }));
  const email = String(raw || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'Enter a valid email' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: nodes } = await admin.from('nodes').select('id').eq('operator_email', email);
  // Same response either way so the endpoint can't be used to probe which emails exist.
  if (!nodes?.length) return json({ ok: true });

  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await admin.from('login_requests').select('id', { count: 'exact', head: true }).eq('email', email).gt('created_at', since);
  if ((count ?? 0) >= 5 * nodes.length) return json({ error: 'Too many codes requested. Try again in a few minutes.' }, 429);

  // Make sure the user exists (the signup guard trigger only admits node emails).
  await admin.auth.admin.createUser({ email, email_confirm: true }).catch(() => {});

  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const code = data?.properties?.email_otp;
  if (error || !code) return json({ error: error?.message || 'Could not create a code' }, 500);

  await admin.from('login_requests').delete().lt('expires_at', new Date().toISOString());
  // Every PC this email operates shows it, so it works from whichever one is at hand.
  const { error: insertError } = await admin.from('login_requests').insert(nodes.map((n) => ({ node_id: n.id, email, code })));
  if (insertError) return json({ error: insertError.message }, 500);

  return json({ ok: true });
});
