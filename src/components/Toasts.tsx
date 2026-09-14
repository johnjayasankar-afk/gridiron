import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { navigate, useLocation } from '../app/router';
import { useFeed, type Toast } from '../state/feed';
import { usePrefs } from '../state/prefs';
import { useUi, type Notice } from '../state/ui';

function ToastItem({ toast }: { toast: Toast }) {
  const [held, setHeld] = useState(false);
  const dismiss = () => useFeed.getState().dismissToast(toast.id);
  useEffect(() => {
    if (held) return;
    const t = setTimeout(dismiss, toast.priority === 1 ? 9000 : 6500);
    return () => clearTimeout(t);
  }, [held]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`toast tone-${toast.tone}`}
      role="group"
      aria-label={toast.title}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="toast-bar" aria-hidden="true" />
      <div className="toast-body">
        <p className="toast-title">{toast.title}</p>
        <p className="toast-detail">{toast.detail}</p>
        {toast.late && <span className="tag">Late update</span>}
      </div>
      <div className="toast-actions">
        {toast.gameId && (
          <>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                navigate({ name: 'game', id: toast.gameId! });
                dismiss();
              }}
            >
              Open
            </button>
            <button type="button" className="link-btn" onClick={() => usePrefs.getState().addToFocus(toast.gameId!)}>
              Focus
            </button>
          </>
        )}
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={dismiss}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function NoticeBar({ notice }: { notice: Notice }) {
  useEffect(() => {
    const t = setTimeout(() => useUi.getState().clearNotice(notice.id), notice.action ? 8000 : 3500);
    return () => clearTimeout(t);
  }, [notice]);
  return (
    <div className="notice" role="status">
      <span>{notice.text}</span>
      {notice.action && (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            notice.action?.();
            useUi.getState().clearNotice(notice.id);
          }}
        >
          {notice.actionLabel ?? 'Undo'}
        </button>
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useFeed((s) => s.toasts);
  const notice = useUi((s) => s.notice);
  const { route } = useLocation();
  return (
    <div className={`toasts${route.name === 'wall' ? ' on-wall' : ''}`}>
      {notice && <NoticeBar key={notice.id} notice={notice} />}
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

export function LiveRegion() {
  const announcement = useFeed((s) => s.announcement);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement && <span key={announcement.at}>{announcement.text}</span>}
    </div>
  );
}
