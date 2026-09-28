import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Message } from '../lib/types';
import { Markdown } from './Markdown';
import { AlertIcon, CheckIcon, ClockIcon, DownIcon, XIcon } from './icons';
import { clock, dayLabel, duration } from './time';

interface Props {
  messages: Message[];
  /** Whose messages sit on the right side. */
  self: 'user' | 'claude';
  empty?: ReactNode;
  onCancel?: (m: Message) => void;
}

function Status({ m, onCancel }: { m: Message; onCancel?: (m: Message) => void }) {
  switch (m.status) {
    case 'queued':
      return (
        <span className="status">
          <ClockIcon width={12} height={12} /> Queued
          {onCancel && (
            <button className="status-cancel" onClick={() => onCancel(m)} aria-label="Cancel">
              <XIcon width={11} height={11} />
            </button>
          )}
        </span>
      );
    case 'processing':
      return <span className="status working"><span className="pulse" /> Executing</span>;
    case 'done':
      return <span className="status done"><CheckIcon width={13} height={13} /> Complete</span>;
    case 'error':
      return <span className="status error"><AlertIcon width={12} height={12} /> Failed</span>;
    case 'cancelled':
      return <span className="status">Cancelled</span>;
    default:
      return null;
  }
}

export function MessageList({ messages, self, empty, onCancel }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = atBottom;
    setShowJump(!atBottom);
  };

  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useLayoutEffect(() => {
    if (pinned.current) toBottom();
  }, [messages]);

  // Keep the latest message visible when the keyboard resizes the view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => pinned.current && toBottom());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="messages-wrap">
      <div className="messages" ref={scroller} onScroll={onScroll}>
        {messages.length === 0 && empty}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || dayLabel(prev.created_at) !== dayLabel(m.created_at);
          const grouped = !newDay && prev && prev.sender === m.sender && Date.parse(m.created_at) - Date.parse(prev.created_at) < 120_000;
          if (m.sender === 'system') {
            return (
              <Fragment key={m.id}>
                {newDay && <div className="day">{dayLabel(m.created_at)}</div>}
                <div className="system-note">{m.body}</div>
              </Fragment>
            );
          }
          const mine = m.sender === self;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day">{dayLabel(m.created_at)}</div>}
              <div className={`row ${mine ? 'mine' : 'theirs'} ${grouped ? 'grouped' : ''}`}>
                <div className={`bubble ${m.sender} ${m.meta?.is_error ? 'is-error' : ''}`}>
                  {!grouped && (
                    <div className="bubble-head">
                      {m.sender === 'claude' ? '◆ Claude · response' : '▲ Directive'}
                      <i>#{m.id.slice(0, 6)}</i>
                    </div>
                  )}
                  {m.sender === 'claude' ? <Markdown text={m.body} /> : <div className="plain">{m.body}</div>}
                </div>
                <div className="meta">
                  <span>{clock(m.created_at)}</span>
                  {m.sender === 'user' && <Status m={m} onCancel={onCancel} />}
                  {m.sender === 'claude' && m.meta?.duration_ms ? <span>· {duration(m.meta.duration_ms)}</span> : null}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
      {showJump && (
        <button className="jump" onClick={() => toBottom(true)} aria-label="Jump to latest">
          <DownIcon width={18} height={18} />
        </button>
      )}
    </div>
  );
}
