import { useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { clientFor } from './accounts';
import { useClient } from './client';
import { canScan, scanQr } from './scan';
import { parseQr } from '../lib/config';
import { callFn } from '../lib/fn';
import { BackIcon } from '../ui/icons';
import { Reticle } from '../ui/Reticle';

/**
 * Pairs a new PC: scan the QR code its Nebula app shows, then choose the PC's
 * email pair. The PC signs itself in; a new operator email is signed in here too.
 */
export function PairScreen({
  session,
  onBack,
  onPaired,
}: {
  session: Session;
  onBack: () => void;
  /** `account` is set when the PC got a different operator email, now signed in on this phone. */
  onPaired: (name: string, account?: string) => void;
}) {
  const client = useClient();
  const [code, setCode] = useState('');
  const [machine, setMachine] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [operator, setOperator] = useState(session.user.email ?? '');
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const found = machine !== null;

  const call = (body: object) => callFn(client, 'pair', body);

  const lookup = async (raw: string) => {
    setBusy(true);
    setError(null);
    try {
      const data = await call({ action: 'peek', code: raw });
      setCode(raw.toUpperCase().replace(/[^A-Z0-9]/g, ''));
      setMachine(data.machine ?? '');
      setName((n) => n || data.machine || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scanCode = async () => {
    setError(null);
    try {
      const text = await scanQr();
      if (!text) return;
      const qr = parseQr(text);
      if (qr?.kind !== 'pair') return setError("That isn't a Nebula pairing code.");
      await lookup(qr.code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const approve = async () => {
    setBusy(true);
    setError(null);
    const op = operator.trim().toLowerCase();
    try {
      const data = await call({ action: 'approve', code, name: name.trim(), operator_email: op, agent_email: agent.trim().toLowerCase() });
      if (data.operator_code) {
        const { error } = await clientFor(op).auth.verifyOtp({ email: op, token: data.operator_code, type: 'email' });
        if (error) throw new Error(`Paired, but signing in as ${op} failed: ${error.message}`);
        onPaired(name.trim() || machine || 'PC', op);
      } else onPaired(name.trim() || machine || 'PC');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const valid = /\S+@\S+\.\S+/.test(operator) && /\S+@\S+\.\S+/.test(agent) && operator.trim().toLowerCase() !== agent.trim().toLowerCase();

  return (
    <div className="phone">
      <header className="chat-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <div className="who">
          <div className="name">
            PAIR A PC<small>// NEW NODE</small>
          </div>
          <div className="sub">{found ? `Found ${machine || 'the PC'}` : 'Install Nebula on the PC and open it'}</div>
        </div>
      </header>

      <div className="pair">
        <Reticle size={130} detail="lite" state={busy ? 'busy' : 'idle'} />
        {!found ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              lookup(code);
            }}
          >
            <p className="hint">The new PC shows a pairing QR code when Nebula opens for the first time.</p>
            {canScan() && (
              <button type="button" className="primary" disabled={busy} onClick={scanCode}>
                Scan pairing code
              </button>
            )}
            <input
              className="code"
              autoCapitalize="characters"
              maxLength={9}
              placeholder={canScan() ? 'or type it' : 'CODE'}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            {code.replace(/[^A-Z0-9]/gi, '').length === 8 && (
              <button className="primary" disabled={busy}>
                {busy ? 'Checking…' : 'Continue'}
              </button>
            )}
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              approve();
            }}
          >
            <label className="setting">
              <span>PC name</span>
              <input value={name} maxLength={40} placeholder="Work laptop" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="setting">
              <span>Operator email · you sign in with it here</span>
              <input type="email" inputMode="email" value={operator} onChange={(e) => setOperator(e.target.value)} />
            </label>
            <label className="setting">
              <span>Agent email · the PC signs in with it</span>
              <input type="email" inputMode="email" placeholder="work-agent@gmail.com" value={agent} onChange={(e) => setAgent(e.target.value)} autoFocus />
            </label>
            <p className="hint small">
              Each email is only an ID and never gets mail. An email is either an operator or an agent, not both. A different operator email becomes its own account on this phone.
            </p>
            <button className="primary" disabled={busy || !valid}>
              {busy ? 'Pairing…' : 'Pair this PC'}
            </button>
          </form>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
