/**
 * Push alerts on this device, inside the alert settings: turn them on for the
 * favorite teams, choose the moments, and send a test. The server sends them
 * when real plays and scores are reported, even while Gridiron is closed.
 */
import { useEffect, useState } from 'react';
import { ALERT_LABELS } from '../../shared/alerts';
import { PUSH_KINDS, PUSH_TEAM_KEY } from '../../shared/push';
import { currentSubscription, disablePush, enablePush, fetchPushKey, pushSupport, sendTestPush } from '../data/push';
import { usePrefs } from '../state/prefs';
import { Switch } from './controls';

type Availability = { status: 'checking' } | { status: 'ready' } | { status: 'unavailable'; reason: string };

const setPush = (patch: Partial<ReturnType<typeof usePrefs.getState>['push']>) => usePrefs.getState().set({ push: { ...usePrefs.getState().push, ...patch } });

export function PushSettings({ open }: { open: boolean }) {
  const push = usePrefs((s) => s.push);
  const favorites = usePrefs((s) => s.favorites);
  const [availability, setAvailability] = useState<Availability>({ status: 'checking' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const teams = favorites.filter((f) => PUSH_TEAM_KEY.test(f.key));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAvailability({ status: 'checking' });
    void (async () => {
      const support = await pushSupport();
      if (cancelled) return;
      if (!support.supported) {
        setAvailability({ status: 'unavailable', reason: support.reason });
        return;
      }
      try {
        const key = await fetchPushKey();
        if (cancelled) return;
        if (!key.available) {
          setAvailability({ status: 'unavailable', reason: key.reason ?? 'Push alerts are not available on this server.' });
          return;
        }
        setAvailability({ status: 'ready' });
        // The browser holds the truth: a subscription removed outside Gridiron turns the switch off.
        if (usePrefs.getState().push.enabled && !(await currentSubscription()) && !cancelled) setPush({ enabled: false });
      } catch (e) {
        if (!cancelled) setAvailability({ status: 'unavailable', reason: `The server did not answer: ${(e as Error).message}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggle = async (on: boolean) => {
    setNote(null);
    if (on && !teams.length) {
      setNote('Star a team first: push alerts follow your favorite teams.');
      return;
    }
    setBusy(true);
    try {
      if (on) {
        const result = await enablePush(
          teams.map((t) => t.key),
          push.kinds,
        );
        if (result.ok) {
          setPush({ enabled: true });
          setNote('Push alerts are on. Send a test to check this device.');
        } else setNote(result.reason);
      } else {
        await disablePush();
        setPush({ enabled: false });
        setNote('Push alerts are off for this browser.');
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    const result = await sendTestPush();
    setBusy(false);
    setNote(result.ok ? 'Test sent. It usually arrives within a few seconds.' : result.reason);
  };

  return (
    <section className="settings-section push-settings" aria-labelledby="push-settings-title">
      <h3 id="push-settings-title" className="settings-title">
        Push alerts on this device
      </h3>
      <p className="form-hint">Sent by this server when a real play or score is reported for your favorite teams, even while Gridiron is closed. Replay lab sessions never send them.</p>
      {availability.status === 'checking' && <p className="form-hint">Checking this browser…</p>}
      {availability.status === 'unavailable' && (
        <p className="form-hint push-unavailable" role="status">
          {availability.reason}
        </p>
      )}
      <p className="push-teams">
        {teams.length ? (
          <>
            Following <strong>{teams.slice(0, 6).map((t) => t.abbreviation).join(', ')}</strong>
            {teams.length > 6 ? ` and ${teams.length - 6} more` : ''}
          </>
        ) : (
          'No favorite teams yet. Star a team on a scoreboard, a team page or in search.'
        )}
      </p>
      <fieldset className="push-controls" disabled={availability.status !== 'ready' || busy}>
        <legend className="sr-only">Push alert settings</legend>
        <Switch label="Push alerts" description={push.enabled ? 'On for this browser' : 'Your browser asks for permission when you turn this on'} checked={push.enabled} onChange={(v) => void toggle(v)} />
        <div className="check-grid">
          {PUSH_KINDS.map((kind) => {
            const checked = push.kinds.includes(kind);
            return (
              <label key={kind} className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  // At least one kind stays chosen.
                  disabled={checked && push.kinds.length === 1}
                  onChange={(e) => setPush({ kinds: e.target.checked ? [...push.kinds, kind] : push.kinds.filter((k) => k !== kind) })}
                />
                <span>{ALERT_LABELS[kind]}</span>
              </label>
            );
          })}
        </div>
        {push.enabled && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void test()}>
            Send a test alert
          </button>
        )}
      </fieldset>
      {note && (
        <p className="form-hint" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
