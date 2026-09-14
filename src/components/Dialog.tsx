import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,summary,iframe,audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"])';

/** What Tab can reach inside `root`: nothing disabled (a disabled fieldset included), inert, invisible or taken out of the tab order. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (x) => x.tabIndex >= 0 && !x.matches(':disabled') && !x.closest('[inert]') && x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden',
  );
}

/** Another modal layered above this one (the command palette, say) owns the keyboard while focus is inside it. */
const inOtherModal = (node: EventTarget | null, own: HTMLElement) => node instanceof Element && !own.contains(node) && node.closest('[aria-modal="true"]') !== null;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  footer?: ReactNode;
}

/** A modal dialog: focus moves in and is trapped, Escape closes, and focus returns to the opener. */
export function Dialog({ open, onClose, title, description, children, size = 'md', className = '', initialFocus, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (!el) return;
    (initialFocus?.current ?? tabbables(el).find((x) => !x.classList.contains('dialog-close')) ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close.current();
    };
    // Tab wraps inside the dialog. It is handled on the document so it also works when focus has already left,
    // for example when the focused control was removed or disabled.
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const active = document.activeElement;
      if (inOtherModal(active, el)) return;
      const list = tabbables(el);
      if (!list.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (!active || active === el || !el.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Focus that lands behind the dialog by any other route comes back in.
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && (el.contains(e.target) || inOtherModal(e.target, el))) return;
      (tabbables(el)[0] ?? el).focus();
    };
    el.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onTab);
    document.addEventListener('focusin', onFocusIn);
    document.body.classList.add('modal-open');
    return () => {
      el.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onTab);
      document.removeEventListener('focusin', onFocusIn);
      document.body.classList.remove('modal-open');
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, initialFocus]);

  if (!open) return null;
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`dialog dialog-${size} ${className}`} tabIndex={-1}>
        <header className="dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p className="dialog-desc">{description}</p>}
          </div>
          <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
