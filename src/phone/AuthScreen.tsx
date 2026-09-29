import { useState } from 'react';
import { phoneClient } from './client';
import { MailIcon } from '../ui/icons';
import { Reticle } from '../ui/Reticle';

export function AuthScreen() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    // Codes are delivered to the Nebula bridge on the PC (see supabase/functions/request-code).
    const { data, error } = await phoneClient.functions.invoke('request-code', {
      body: { email: email.trim().toLowerCase() },
    });
    setBusy(false);
    if (error || data?.error) {
      setError(data?.error || error?.message || 'Could not send a code');
      return;
    }
    setStep('code');
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    const { error } = await phoneClient.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: 'email',
    });
    setBusy(false);
    if (error) setError(/expired|invalid/i.test(error.message) ? 'That code is wrong or expired. Request a new one.' : error.message);
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <Reticle size={170} detail="lite" state={busy ? 'busy' : 'idle'} />
        <h1>NEBULA</h1>
        <p className="lede">Secure uplink to Claude on your PC. It works while you're away and reports back when done.</p>
        <div className="auth-steps">
          <span className="on">01 IDENTIFY</span>—<span className={step === 'code' ? 'on' : ''}>02 VERIFY</span>—<span>03 LINK</span>
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
                placeholder="you@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            </label>
            <button className="primary" disabled={busy || !/\S+@\S+\.\S+/.test(email)}>
              {busy ? 'Requesting…' : 'Request access code'}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <p className="hint">
              Your code for <b>{email}</b> is showing in the Nebula bridge on your PC.
            </p>
            <input
              className="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              placeholder="••••••"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
            <button className="primary" disabled={busy || code.length < 6}>
              {busy ? 'Verifying…' : 'Authenticate'}
            </button>
            <button type="button" className="ghost" onClick={() => { setStep('email'); setCode(''); setError(null); }}>
              Use a different email
            </button>
          </form>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
