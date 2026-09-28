import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const SendIcon = (p: P) => (
  <svg {...base} {...p}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
export const StopIcon = (p: P) => (
  <svg {...base} {...p}><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" /></svg>
);
export const CheckIcon = (p: P) => (
  <svg {...base} {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const ClockIcon = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const AlertIcon = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>
);
export const MoreIcon = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="5.5" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="18.5" r="1.3" fill="currentColor" /></svg>
);
export const DownIcon = (p: P) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12l7 7 7-7" /></svg>
);
export const MailIcon = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M4 7l8 6 8-6" /></svg>
);
export const RefreshIcon = (p: P) => (
  <svg {...base} {...p}><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>
);
export const XIcon = (p: P) => (
  <svg {...base} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);

/** Brand mark: a green core inside broken blue rings (a still of the Reticle). */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <rect width="1024" height="1024" rx="200" fill="#04070B" />
      <path d="M512 172a340 340 0 0 1 340 340" fill="none" stroke="#60A5FA" strokeWidth="34" strokeLinecap="round" />
      <path d="M852 512a340 340 0 0 1-230 322" fill="none" stroke="#60A5FA" strokeWidth="34" strokeLinecap="round" strokeOpacity="0.5" />
      <path d="M172 512a340 340 0 0 1 190-305" fill="none" stroke="#60A5FA" strokeWidth="34" strokeLinecap="round" />
      <path d="M512 262a250 250 0 0 1 216 375" fill="none" stroke="#22C55E" strokeWidth="44" strokeLinecap="round" />
      <path d="M296 640a250 250 0 0 1-30-160" fill="none" stroke="#22C55E" strokeWidth="44" strokeLinecap="round" />
      <circle cx="512" cy="512" r="176" fill="none" stroke="#22C55E" strokeWidth="18" />
      <circle cx="512" cy="512" r="130" fill="#22C55E" />
    </svg>
  );
}
