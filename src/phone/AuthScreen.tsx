import { useState } from 'react';
import { clientFor } from './accounts';
import { canScan, scanQr } from './scan';
import { parseQr } from '../lib/config';
import { callFn } from '../lib/fn';
import { MailIcon } from '../ui/icons';
import { Reticle } from '../ui/Reticle';

/** Signs an operator account in: enter the email, then scan the QR code the PC shows. */
export function AuthScreen({ onSignedIn, onCancel }: { onSignedIn: (email: string) => void; onCancel?: () => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addr = email.trim().toLowerCase();

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    // The code goes to the Nebula bridge on this email's PC (see supabase/functions/request-code).
    try {
      await callFn(clientFor(addr), 'request-code', { email: addr });
      setStep('code');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not request a code');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (token: string) => {
    setBusy(true);
    setError(null);
    const { error } = await clientFor(addr).auth.verifyOtp({ email: addr, token: token.trim(), type: 'email' });
    setBusy(false);
    if (error) setError(/expired|invalid/i.test(error.message) ? 'That code is wrong or expired. Request a new one.' : error.message);
    else onSignedIn(addr);
  };

  const scanCode = async () => {
    setError(null);
    try {
      const text = await scanQr();
      if (!text) return;
      const qr = parseQr(text);
      if (qr?.kind !== 'login') return setError("That isn't a Nebula sign-in code.");
      if (qr.email !== addr) return setError(`That code is for ${qr.email}.`);
      await verify(qr.code);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const reset = () => {
    setStep('email');
    setCode('');
    setError(null);
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <Reticle size={170} detail="lite" state={busy ? 'busy' : 'idle'} />
        <h1>NEBULA</h1>
        <p className="lede">
          {onCancel ? 'Add another operator account, for example the one for your work PC.' : "Secure uplink to the agents on your PC. They work while you're away and report back when done."}
        </p>
        <div className="auth-steps">
          <span className="on">01 IDENTIFY</span>—<span className={step === 'code' ? 'on' : ''}>02 SCAN</span>—<span>03 LINK</span>
        </div>

        {step === 'email' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
          >
            <label className="field">
              <MailIcon width={18} height={18} />
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="operator@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            </label>
            <button className="primary" disabled={busy || !/\S+@\S+\.\S+/.test(email)}>
              {busy ? 'Requesting…' : 'Request access'}
            </button>
            {onCancel && (
              <button type="button" className="ghost" onClick={onCancel}>
                Cancel
              </button>
            )}
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verify(code);
            }}
          >
            <p className="hint">
              The Nebula app on the PC for <b>{addr}</b> is showing a QR code.
            </p>
            {canScan() && (
              <button type="button" className="primary" disabled={busy} onClick={scanCode}>
                {busy ? 'Verifying…' : 'Scan QR code'}
              </button>
            )}
            <input
              className="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              placeholder={canScan() ? 'or type code' : '••••••'}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            {code.length >= 6 && (
              <button className="primary" disabled={busy}>
                {busy ? 'Verifying…' : 'Authenticate'}
              </button>
            )}
            <button type="button" className="ghost" onClick={reset}>
              Use a different email
            </button>
          </form>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
