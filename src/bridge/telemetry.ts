import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { inTauri } from '../lib/platform';

export interface SysStats {
  cpu: number;
  cores: number[];
  memUsed: number;
  memTotal: number;
  /** Bytes since the previous sample (~1s). */
  rx: number;
  tx: number;
  uptime: number;
  processes: number;
  os: string;
}

export interface Telemetry {
  cur: SysStats | null;
  cpu: number[];
  mem: number[];
  rx: number[];
  tx: number[];
}

const HISTORY = 90;
const push = (a: number[], v: number) => [...a.slice(-(HISTORY - 1)), v];

/** Browser preview has no native side; synthesize plausible numbers so the UI can be seen. */
let t = 0;
function simulated(): SysStats {
  t++;
  const n = (f: number, a = 1) => (Math.sin(t / f) + 1) / 2 * a;
  return {
    cpu: 8 + n(7, 30) + Math.random() * 8,
    cores: Array.from({ length: 12 }, (_, i) => Math.min(100, n(3 + i, 60) + Math.random() * 15)),
    memUsed: (9.2 + n(20, 0.8)) * 2 ** 30,
    memTotal: 16 * 2 ** 30,
    rx: (n(5, 400) + Math.random() * 200) * 1024,
    tx: (n(9, 120) + Math.random() * 60) * 1024,
    uptime: 86400 * 2 + 3600 * 5 + t,
    processes: 290 + Math.round(n(13, 12)),
    os: 'Windows 11 (26200)',
  };
}

/** Live CPU / memory / network samples, once a second. */
export function useTelemetry(): Telemetry {
  const [s, setS] = useState<Telemetry>({ cur: null, cpu: [], mem: [], rx: [], tx: [] });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const cur = inTauri() ? await invoke<SysStats>('sys_stats').catch(() => null) : simulated();
      if (!alive || !cur) return;
      setS((p) => ({
        cur,
        cpu: push(p.cpu, cur.cpu),
        mem: push(p.mem, (cur.memUsed / Math.max(1, cur.memTotal)) * 100),
        rx: push(p.rx, cur.rx),
        tx: push(p.tx, cur.tx),
      }));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return s;
}

/** Round-trip time to the backend, sampled every 5 seconds. */
export function useLatency(client: SupabaseClient) {
  const [hist, setHist] = useState<number[]>([]);
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const start = performance.now();
      const { error } = await client.from('agents').select('id').limit(1);
      if (alive && !error) setHist((h) => push(h, Math.round(performance.now() - start)).slice(-40));
    };
    ping();
    const id = window.setInterval(ping, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [client]);
  return hist;
}

export function fmtBytes(b: number, perSec = false) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${units[i]}${perSec ? '/s' : ''}`;
}

export function fmtUptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${p(h)}:${p(m)}:${p(s)}`;
}
