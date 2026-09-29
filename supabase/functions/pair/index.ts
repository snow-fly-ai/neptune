// Pairs a new PC with Nebula. The PC starts a request and shows its code as a QR;
// a phone signed in as any operator scans it and chooses the PC's email pair; the
// PC then receives a one-time sign-in code for its agent email and signs itself in.
//
//   start   {machine}                                   (PC)    → {id, code, secret, expires_at}
//   status  {id, secret}                                (PC)    → {state: pending|expired} | {state: approved, email, code}
//   peek    {code}                                      (phone) → {machine}
//   approve {code, name, operator_email, agent_email}   (phone) → {ok, operator_code?}
//
// Every operator is trusted with every node: this is one person's set of accounts.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const EMAIL = /^\S+@\S+\.\S+$/;
// No 0/O/1/I so the code can be typed from the screen too.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % 32]).join('');
const randomSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
const normCode = (c: unknown) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function signInCode(email: string) {
  await admin.auth.admin.createUser({ email, email_confirm: true }).catch(() => {});
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const code = data?.properties?.email_otp;
  if (error || !code) throw new Error(error?.message || 'Could not create a sign-in code');
  return code;
}

/** The signed-in phone's email, if it operates at least one node. */
async function operator(req: Request) {
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { count } = await admin.from('nodes').select('id', { count: 'exact', head: true }).eq('operator_email', email);
  return count ? email : null;
}

async function pending(code: string) {
  const { data } = await admin
    .from('pair_requests')
    .select('*')
    .eq('code', code)
    .is('agent_code', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const body = await req.json().catch(() => ({}));

  try {
    switch (body.action) {
      case 'start': {
        await admin.from('pair_requests').delete().lt('expires_at', new Date().toISOString());
        const { count } = await admin.from('pair_requests').select('id', { count: 'exact', head: true });
        if ((count ?? 0) >= 20) return json({ error: 'Too many pairing requests. Try again in a few minutes.' }, 429);
        const machine = String(body.machine || '').slice(0, 60) || null;
        const { data, error } = await admin
          .from('pair_requests')
          .insert({ code: randomCode(8), secret: randomSecret(), machine })
          .select('id, code, secret, expires_at')
          .single();
        if (error) throw error;
        return json(data);
      }

      case 'status': {
        const { data } = await admin.from('pair_requests').select('*').eq('id', body.id).eq('secret', String(body.secret || '')).maybeSingle();
        if (!data) return json({ state: 'expired' });
        if (data.agent_code) {
          // Handed over once; the PC signs in with it right away.
          await admin.from('pair_requests').delete().eq('id', data.id);
          return json({ state: 'approved', email: data.agent_email, code: data.agent_code });
        }
        if (Date.parse(data.expires_at) < Date.now()) return json({ state: 'expired' });
        return json({ state: 'pending' });
      }

      case 'peek': {
        if (!(await operator(req))) return json({ error: 'Sign in first' }, 401);
        const row = await pending(normCode(body.code));
        if (!row) return json({ error: 'That pairing code is wrong or expired. The PC shows a fresh one.' }, 404);
        return json({ machine: row.machine });
      }

      case 'approve': {
        const caller = await operator(req);
        if (!caller) return json({ error: 'Sign in first' }, 401);
        const row = await pending(normCode(body.code));
        if (!row) return json({ error: 'That pairing code is wrong or expired. The PC shows a fresh one.' }, 404);

        const name = String(body.name || '').trim().slice(0, 40) || row.machine || 'PC';
        const op = String(body.operator_email || '').trim().toLowerCase();
        const agent = String(body.agent_email || '').trim().toLowerCase();
        if (!EMAIL.test(op) || !EMAIL.test(agent)) return json({ error: 'Enter both emails' }, 400);
        if (op === agent) return json({ error: 'The operator and agent emails must differ' }, 400);

        // Re-pairing a PC that already has a node keeps its chats.
        const { data: existing } = await admin.from('nodes').select('*').eq('agent_email', agent).maybeSingle();
        let nodeId: string;
        if (existing) {
          if (existing.operator_email !== op) return json({ error: `${agent} is already the agent of ${existing.name}, operated by another email` }, 409);
          nodeId = existing.id;
          await admin.from('nodes').update({ name, machine: row.machine }).eq('id', nodeId);
        } else {
          const { data: node, error } = await admin
            .from('nodes')
            .insert({ name, operator_email: op, agent_email: agent, machine: row.machine })
            .select('id')
            .single();
          if (error) return json({ error: /operator or an agent/.test(error.message) ? 'An email can be an operator or an agent, not both' : error.message }, 400);
          nodeId = node.id;
        }

        const agentCode = await signInCode(agent);
        await admin.from('pair_requests').update({ node_id: nodeId, agent_email: agent, agent_code: agentCode }).eq('id', row.id);
        // A different operator email: sign the phone into that account as well.
        const operatorCode = op === caller ? undefined : await signInCode(op);
        return json({ ok: true, node_id: nodeId, operator_code: operatorCode });
      }

      default:
        return json({ error: 'Unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
