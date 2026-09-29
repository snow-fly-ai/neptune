import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cancel, checkPermissions, Format, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner';
import { inTauri } from '../lib/platform';

/** The camera is only there in the Android app; elsewhere codes are typed. */
export const canScan = () => inTauri() && /android/i.test(navigator.userAgent);

let abort: (() => void) | null = null;

/** Ends a running scan. The plugin's own cancel never settles the scan promise, so we do. */
export function cancelScan() {
  abort?.();
  cancel().catch(() => {});
}

/**
 * Scans one QR code with the camera shown behind a transparent webview.
 * Resolves with its text, or null if cancelled.
 */
export async function scanQr(): Promise<string | null> {
  let perm = await checkPermissions();
  if (perm !== 'granted') perm = await requestPermissions();
  if (perm !== 'granted') throw new Error('Nebula needs the camera to scan. Allow it in Android settings, or type the code.');
  document.documentElement.classList.add('scanning');
  window.dispatchEvent(new Event('nebula-scan'));
  try {
    return await Promise.race([
      scan({ windowed: true, formats: [Format.QRCode] }).then((r) => r.content),
      new Promise<null>((resolve) => (abort = () => resolve(null))),
    ]);
  } catch (e) {
    if (/cancel/i.test(String(e))) return null;
    throw e;
  } finally {
    abort = null;
    document.documentElement.classList.remove('scanning');
    window.dispatchEvent(new Event('nebula-scan'));
  }
}

/** Viewfinder and a cancel button over the camera while a scan runs. Mount once. */
export function ScanOverlay() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(document.documentElement.classList.contains('scanning'));
    window.addEventListener('nebula-scan', sync);
    return () => window.removeEventListener('nebula-scan', sync);
  }, []);
  // Android's back button cancels the scan instead of leaving the screen.
  useEffect(() => {
    if (!on) return;
    history.pushState({ scan: true }, '');
    const onPop = () => cancelScan();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if ((history.state as { scan?: boolean } | null)?.scan) history.back();
    };
  }, [on]);
  if (!on) return null;
  return createPortal(
    <div className="scan-overlay">
      <p>Point at the QR code on your PC</p>
      <div className="scan-frame">
        <i />
      </div>
      <button className="secondary" onClick={() => cancelScan()}>
        Cancel
      </button>
    </div>,
    document.body,
  );
}
