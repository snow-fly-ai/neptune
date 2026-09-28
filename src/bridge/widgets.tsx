import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Framed HUD panel with corner brackets and a numbered header. */
export function Panel({
  n,
  title,
  right,
  tone = 'blue',
  className = '',
  children,
}: {
  n: string;
  title: string;
  right?: ReactNode;
  tone?: 'blue' | 'green';
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel tone-${tone} ${className}`}>
      <header className="panel-head">
        <span className="panel-n">[{n}]</span>
        <span className="panel-title">{title}</span>
        <span className="panel-rule" />
        {right && <span className="panel-right">{right}</span>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** Minimal SVG sparkline; `max` pins the scale (e.g. 100 for percentages). */
export function Spark({ data, max, tone = 'green', height = 36, fill = true }: { data: number[]; max?: number; tone?: 'green' | 'blue'; height?: number; fill?: boolean }) {
  const W = 200;
  const H = height;
  const top = Math.max(max ?? 0, ...data, 1e-9);
  const n = Math.max(data.length, 2);
  const pts = data.map((v, i) => [((i + (n - data.length)) / (n - 1)) * W, H - (v / top) * (H - 2) - 1]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const color = tone === 'green' ? 'var(--green)' : 'var(--blue-hi)';
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }}>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="rgba(96,165,250,0.08)" />
      ))}
      {fill && pts.length > 1 && <polygon points={`${pts[0][0]},${H} ${line} ${pts[pts.length - 1][0]},${H}`} fill={color} opacity={0.12} />}
      {pts.length > 1 && <polyline points={line} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** Segmented block meter. */
export function Meter({ pct, tone = 'green', segments = 24 }: { pct: number; tone?: 'green' | 'blue' | 'warn'; segments?: number }) {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * segments);
  return (
    <div className={`meter m-${tone}`}>
      {Array.from({ length: segments }, (_, i) => (
        <i key={i} className={i < on ? 'on' : ''} />
      ))}
    </div>
  );
}

/** Scrolling hex dump on a canvas; `rate` (0–1) speeds it up with network activity. */
export function HexStream({ rate }: { rate: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const hex = '0123456789ABCDEF';
    const b = () => hex[(Math.random() * 16) | 0] + hex[(Math.random() * 16) | 0];
    let rows: { addr: string; bytes: string[]; hot: number }[] = [];
    let addr = (Math.random() * 0xffffff) | 0;
    let raf = 0;
    let last = 0;
    const lineH = 15;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const interval = 180 - rateRef.current * 140;
      if (t - last < interval) return;
      last = t;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr;
        cv.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = Math.max(4, Math.floor((w - 70) / 21));
      addr = (addr + cols) & 0xffffff;
      rows.push({ addr: addr.toString(16).toUpperCase().padStart(6, '0'), bytes: Array.from({ length: cols }, b), hot: Math.random() < 0.3 ? (Math.random() * cols) | 0 : -1 });
      const max = Math.ceil(h / lineH);
      rows = rows.slice(-max);
      ctx.clearRect(0, 0, w, h);
      ctx.font = '11px "Geist Mono Variable", Consolas, monospace';
      ctx.textBaseline = 'top';
      rows.forEach((r, i) => {
        const y = h - (rows.length - i) * lineH;
        const age = (rows.length - 1 - i) / max;
        ctx.fillStyle = `rgba(96,165,250,${0.55 - age * 0.45})`;
        ctx.fillText(r.addr, 2, y);
        r.bytes.forEach((byte, j) => {
          const hot = j === r.hot || j === r.hot + 1;
          ctx.fillStyle = hot ? `rgba(187,247,208,${1 - age * 0.7})` : `rgba(34,197,94,${0.75 - age * 0.62})`;
          ctx.fillText(byte, 64 + j * 21, y);
        });
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="hexstream" />;
}

/** Types each new value out character by character. */
export function Typewriter({ text, speed = 18 }: { text: string; speed?: number }) {
  const [shown, setShown] = useState('');
  useEffect(() => {
    let i = 0;
    setShown('');
    const id = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, speed);
    return () => window.clearInterval(id);
  }, [text, speed]);
  return <span className="caret">{shown}</span>;
}

/** Characters that scramble before resolving; for decorative status words. */
export function Scramble({ text }: { text: string }) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    const glyphs = '!<>-_\\/[]{}=+*^?#01';
    let frame = 0;
    const id = window.setInterval(() => {
      frame++;
      setOut(
        text
          .split('')
          .map((c, i) => (c === ' ' || i < frame / 2 ? c : glyphs[(Math.random() * glyphs.length) | 0]))
          .join(''),
      );
      if (frame / 2 > text.length) window.clearInterval(id);
    }, 30);
    return () => window.clearInterval(id);
  }, [text]);
  return <>{out}</>;
}

/** Small spinning double arc, for "waiting" states. */
export function Spinner({ size = 16, tone = 'green' }: { size?: number; tone?: 'green' | 'blue' }) {
  return (
    <svg className={`spin-ind t-${tone}`} width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="8" fill="none" strokeWidth="1.5" strokeDasharray="12 38" className="a" />
      <circle cx="10" cy="10" r="4.5" fill="none" strokeWidth="1.5" strokeDasharray="6 22" className="b" />
    </svg>
  );
}

/** Ring that drains over `period` ms and restarts; ties a visual to the heartbeat. */
export function CountdownRing({ period, size = 22 }: { period: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" className="countdown" style={{ ['--period' as string]: `${period}ms` }} aria-hidden>
      <circle cx="11" cy="11" r="9" fill="none" stroke="rgba(96,165,250,0.2)" strokeWidth="2" />
      <circle cx="11" cy="11" r="9" fill="none" stroke="var(--blue-hi)" strokeWidth="2" pathLength={100} strokeDasharray="100" className="cd" />
    </svg>
  );
}
