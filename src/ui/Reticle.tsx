import { useId, useMemo } from 'react';

export type ReticleState = 'idle' | 'busy' | 'offline';

/** Deterministic PRNG so ticks and rays don't reshuffle on re-render. */
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

const C = 200;
const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};
const arc = (r: number, from: number, to: number) => {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
};

/**
 * The "operator" mark: a solid core ringed by partial arcs that counter-rotate,
 * with ticks and rays radiating perpendicular to the rings and fading out.
 * `detail` trims the finer layers for small sizes.
 */
export function Reticle({
  size = 400,
  state = 'idle',
  detail = 'full',
  label,
  sub,
}: {
  size?: number;
  state?: ReticleState;
  detail?: 'full' | 'lite' | 'mini';
  label?: string;
  sub?: string;
}) {
  const id = useId().replace(/:/g, '');
  const full = detail === 'full';
  const mini = detail === 'mini';

  const { ticks, rays, inner } = useMemo(() => {
    const r = rng(7);
    const ticks = Array.from({ length: 120 }, (_, i) => ({ deg: i * 3, len: i % 10 === 0 ? 14 : i % 5 === 0 ? 9 : 4 + r() * 3 }));
    const rays = Array.from({ length: 64 }, () => ({ deg: r() * 360, len: 14 + r() ** 2 * 58, w: r() > 0.85 ? 2.2 : 1 }));
    const inner = Array.from({ length: 36 }, (_, i) => ({ deg: i * 10 + 5, len: 3 + r() * 9 }));
    return { ticks, rays, inner };
  }, []);

  return (
    <div className={`reticle is-${state} d-${detail}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 400 400" width={size} height={size} aria-hidden>
        <defs>
          <radialGradient id={`${id}-core`}>
            <stop offset="0" stopColor="var(--r-core-hi)" />
            <stop offset="0.55" stopColor="var(--r-core)" />
            <stop offset="1" stopColor="var(--r-core-lo)" />
          </radialGradient>
          <radialGradient id={`${id}-fade`} cx="200" cy="200" r="200" gradientUnits="userSpaceOnUse">
            <stop offset="0.6" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.98" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id={`${id}-mask`}>
            <rect width="400" height="400" fill={`url(#${id}-fade)`} />
          </mask>
          <linearGradient id={`${id}-sweep`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--r-a)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--r-a)" stopOpacity="0.5" />
          </linearGradient>
        </defs>

        {/* Outer rays: perpendicular to the ring, fading as they extend. */}
        {!mini && (
          <g className="spin s-rays" mask={`url(#${id}-mask)`}>
            {rays.map((r, i) => {
              const [x1, y1] = polar(142, r.deg);
              const [x2, y2] = polar(142 + r.len, r.deg);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--r-b)" strokeWidth={r.w} strokeOpacity={0.75} />;
            })}
          </g>
        )}

        {/* Degree ring with ticks. */}
        <g className="spin s-ticks">
          <circle cx={C} cy={C} r={126} fill="none" stroke="var(--r-b)" strokeOpacity={0.25} />
          {!mini &&
            ticks.map((t, i) => {
              const [x1, y1] = polar(126, t.deg);
              const [x2, y2] = polar(126 + t.len, t.deg);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--r-b)" strokeOpacity={t.len > 10 ? 0.9 : 0.45} strokeWidth={t.len > 10 ? 1.6 : 1} />;
            })}
          {full &&
            [0, 90, 180, 270].map((d) => {
              const [x, y] = polar(160, d);
              return (
                <text key={d} x={x} y={y + 3} textAnchor="middle" className="r-deg">
                  {String(d).padStart(3, '0')}
                </text>
              );
            })}
        </g>

        {/* Broken outer arc with end caps. */}
        <g className="spin s-outer">
          <path d={arc(112, 20, 250)} fill="none" stroke="var(--r-b)" strokeWidth={2} strokeLinecap="round" />
          <path d={arc(112, 275, 340)} fill="none" stroke="var(--r-b)" strokeWidth={2} strokeOpacity={0.5} strokeLinecap="round" />
          {[20, 250].map((d) => {
            const [x, y] = polar(112, d);
            return <circle key={d} cx={x} cy={y} r={3.2} fill="var(--r-b)" />;
          })}
        </g>

        {/* Radar sweep. */}
        {!mini && (
          <g className="spin s-sweep">
            <path d={`M${C},${C} L${polar(108, 0).join(',')} A108,108 0 0 1 ${polar(108, 50).join(',')} Z`} fill={`url(#${id}-sweep)`} opacity={0.45} />
          </g>
        )}

        {/* Counter-rotating green arcs. */}
        <g className="spin rev s-mid">
          <path d={arc(94, 0, 110)} fill="none" stroke="var(--r-a)" strokeWidth={5} strokeLinecap="round" />
          <path d={arc(94, 150, 190)} fill="none" stroke="var(--r-a)" strokeWidth={5} strokeLinecap="round" strokeOpacity={0.6} />
          <path d={arc(94, 225, 330)} fill="none" stroke="var(--r-a)" strokeWidth={2} strokeLinecap="round" />
          {!mini && <circle cx={polar(94, 340)[0]} cy={polar(94, 340)[1]} r={4} fill="var(--r-a)" className="r-blink" />}
        </g>

        {/* Dashed inner ring with short inward ticks. */}
        <g className="spin s-inner">
          <circle cx={C} cy={C} r={74} fill="none" stroke="var(--r-b)" strokeWidth={1.4} strokeDasharray="2 6" />
          {!mini &&
            inner.map((t, i) => {
              const [x1, y1] = polar(74, t.deg);
              const [x2, y2] = polar(74 - t.len, t.deg);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--r-b)" strokeOpacity={0.6} />;
            })}
        </g>

        {/* The one complete circle. */}
        <circle cx={C} cy={C} r={58} fill="none" stroke="var(--r-a)" strokeWidth={2.5} className="r-ring" />
        <circle cx={C} cy={C} r={50} fill={`url(#${id}-core)`} className="r-core" />
        <circle cx={C} cy={C} r={50} fill="none" stroke="var(--r-a)" strokeOpacity={0.5} className="r-pulse" />
        {full && !label && (
          <>
            <line x1={C - 18} y1={C} x2={C + 18} y2={C} stroke="var(--r-ink)" strokeOpacity={0.5} />
            <line x1={C} y1={C - 18} x2={C} y2={C + 18} stroke="var(--r-ink)" strokeOpacity={0.5} />
          </>
        )}
      </svg>
      {(label || sub) && (
        <div className="reticle-text">
          {label && <div className="reticle-label">{label}</div>}
          {sub && <div className="reticle-sub">{sub}</div>}
        </div>
      )}
    </div>
  );
}
