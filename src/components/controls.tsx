/** Small shared controls: segmented buttons, icon buttons, a menu and a popover. */
import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  hideLabel?: boolean;
}

export function Segmented<T extends string>({ label, value, options, onChange, className = '' }: { label: string; value: T | null; options: SegmentOption<T>[]; onChange: (value: T) => void; className?: string }) {
  const track = useRef<HTMLDivElement>(null);
  // A glowing indicator slides to the pressed option; it is measured, so labels of any width work.
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      const active = el.querySelector<HTMLElement>('.seg-btn[aria-pressed="true"]');
      if (!active) {
        el.classList.remove('has-indicator');
        return;
      }
      el.style.setProperty('--seg-x', `${active.offsetLeft}px`);
      el.style.setProperty('--seg-w', `${active.offsetWidth}px`);
      if (!el.classList.contains('has-indicator')) {
        el.classList.add('has-indicator');
        frame = requestAnimationFrame(() => el.classList.add('is-ready'));
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, options.length]);
  return (
    <div ref={track} className={`seg ${className}`} role="group" aria-label={label}>
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            className="seg-btn"
            aria-pressed={value === o.value}
            aria-label={o.hideLabel ? o.label : undefined}
            title={o.hideLabel ? o.label : undefined}
            onClick={() => onChange(o.value)}
          >
            {Icon && <Icon size={15} strokeWidth={1.9} aria-hidden="true" />}
            {!o.hideLabel && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function IconButton({ label, icon: Icon, onClick, pressed, className = '', size = 16, disabled }: { label: string; icon: LucideIcon; onClick: () => void; pressed?: boolean; className?: string; size?: number; disabled?: boolean }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}>
      <Icon size={size} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}

export type MenuItem = { label: string; icon?: LucideIcon; hint?: string; onSelect: () => void } | 'separator';

export function Menu({ label, trigger, items, align = 'end' }: { label: string; trigger: ReactNode; items: MenuItem[]; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="menu-wrap">
      <button ref={button} type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div ref={menu} id={id} role="menu" aria-label={label} className={`menu menu-${align}`} onKeyDown={onKey}>
          {items.map((item, i) => {
            if (item === 'separator') return <div key={`s${i}`} role="separator" className="menu-sep" />;
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {Icon && <Icon size={16} strokeWidth={1.9} aria-hidden="true" />}
                <span>{item.label}</span>
                {item.hint && <kbd>{item.hint}</kbd>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A non-modal popover anchored to a button. */
export function Popover({ label, trigger, children, align = 'end', buttonClassName = 'btn btn-ghost btn-sm' }: { label: string; trigger: ReactNode; children: ReactNode; align?: 'start' | 'end'; buttonClassName?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    panel.current?.addEventListener('keydown', onKey);
    const el = panel.current;
    return () => {
      document.removeEventListener('mousedown', onDown);
      el?.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap">
      <button ref={button} type="button" className={buttonClassName} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div ref={panel} id={id} role="dialog" aria-label={label} className={`popover menu-${align}`}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className={`switch-row${disabled ? ' is-disabled' : ''}`}>
      <span className="switch-text">
        <label htmlFor={id}>{label}</label>
        {description && <span className="switch-desc" id={`${id}-d`}>{description}</span>}
      </span>
      <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={description ? `${id}-d` : undefined} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
        <span className="switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}
