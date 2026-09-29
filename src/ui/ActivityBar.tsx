import { useNow } from '../lib/useConversation';
import { StopIcon } from './icons';

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Live "what the agent is doing right now" strip above the composer. */
export function ActivityBar({
  activity,
  working,
  since,
  onStop,
}: {
  activity: string | null | undefined;
  working: boolean;
  /** ISO time the current task started, for the elapsed counter. */
  since?: string;
  onStop?: () => void;
}) {
  const now = useNow(1000);
  if (!working) return null;
  return (
    <div className="activity">
      <span className="spinner" />
      <span className="activity-text caret">{activity || 'Working…'}</span>
      {since && <span className="activity-time">{elapsed(now - Date.parse(since))}</span>}
      {onStop && (
        <button className="activity-stop" onClick={onStop}>
          <StopIcon width={12} height={12} /> ABORT
        </button>
      )}
    </div>
  );
}
