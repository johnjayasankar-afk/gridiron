/** Settings and information dialogs: alerts, boards, display, data and sources, shortcuts, and the replay lab. */
import { CopyPlus, Pencil, RotateCcw, Share2, Trash2 } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ALERT_KINDS, ALERT_LABELS, DEFAULT_ALERT_RULES, type AlertRules } from '../../shared/alerts';
import { BOARD_PARAM, encodeBoard } from '../../shared/boards';
import { clampDelaySeconds, DELAY_PRESETS, MAX_DELAY_SECONDS } from '../../shared/delay';
import type { AlertKind, Division } from '../../shared/model';
import { DIVISION_LABEL } from '../../shared/model';
import { dateKeyToLabel } from '../../shared/util';
import { navigate, setParams } from '../app/router';
import { SHORTCUTS } from '../app/useShortcuts';
import { replayApi, type ReplayScenario } from '../data/api';
import { useNow } from '../lib/motion';
import { shareLink } from '../lib/share';
import { playChime, playFieldSound, unlockSound } from '../lib/sound';
import { clockTime } from '../lib/time';
import { useGraphics } from '../state/graphics';
import { useLive, usePresentedWorld } from '../state/live';
import { usePrefs, type SavedBoard } from '../state/prefs';
import { bestSummary } from '../state/selectors';
import { useUi } from '../state/ui';
import { IconButton, Segmented, Switch } from './controls';
import { Dialog } from './Dialog';
import { OddsHelp, OddsSettings } from './OddsSettings';
import { PushSettings } from './PushSettings';

interface DialogOpen {
  open: boolean;
  onClose: () => void;
}

const KIND_HELP: Partial<Record<AlertKind, string>> = {
  touchdown: 'From a reported touchdown play, never from a six-point score change',
  field_goal: 'From a reported successful field goal',
  turnover: 'Interceptions and lost fumbles as reported',
  red_zone: 'When an offense moves from outside to inside the opponent 20',
  fourth_down_attempt: 'A team goes for it on fourth down, and whether it converted',
  fourth_down: 'Every fourth-down situation, including punts and kicks',
  big_play: 'A reported gain at or beyond the big-play threshold',
  lead_change: 'The leader switches sides',
  close_late: 'A close game inside the late window of the fourth quarter',
  overtime: 'Regulation ends tied',
  kickoff: 'A favorite team’s game starts',
  review: 'A replay review or challenge appears in the play-by-play',
  score_change: 'The score moved but no reported play explains it yet',
};

const COLLEGE_DIVISIONS: Division[] = ['FBS', 'FCS', 'D2', 'D3'];

function NumberField({ label, suffix, min, max, value, onChange }: { label: string; suffix: string; min: number; max: number; value: number; onChange: (value: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <div className="form-row number-row">
      <label htmlFor={id} className="form-label">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = Number(draft);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, Math.round(v))));
          else setDraft(String(value));
        }}
      />
      <span className="form-hint">{suffix}</span>
    </div>
  );
}

function untilSixAm(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function AlertSettingsDialog({ open, onClose }: DialogOpen) {
  const rules = usePrefs((s) => s.alertRules);
  const quiet = usePrefs((s) => s.quiet);
  const sound = usePrefs((s) => s.sound);
  const notifications = usePrefs((s) => s.notifications);
  const snoozeUntil = usePrefs((s) => s.snoozeUntil);
  const muted = usePrefs((s) => s.mutedGames);
  const announce = usePrefs((s) => s.announce);
  const world = usePresentedWorld();
  const now = useNow(30_000);
  const [soundNote, setSoundNote] = useState<string | null>(null);
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const set = usePrefs.getState().set;
  const setRules = (patch: Partial<AlertRules>) => usePrefs.getState().setAlertRules({ ...rules, ...patch });

  const toggleSound = async (on: boolean) => {
    if (!on) {
      set({ sound: false });
      setSoundNote(null);
      return;
    }
    if (await unlockSound()) {
      set({ sound: true });
      playChime('test');
      setSoundNote('Sound is on. That was the test chime.');
    } else setSoundNote('This browser blocked audio. Click anywhere on the page, then try again.');
  };

  const toggleNotifications = async (on: boolean) => {
    if (!on) {
      set({ notifications: false });
      setNotifyNote(null);
      return;
    }
    if (typeof Notification === 'undefined') {
      setNotifyNote('This browser does not support notifications.');
      return;
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission === 'granted') {
      set({ notifications: true });
      setNotifyNote('Notifications appear only while Gridiron is in the background.');
    } else setNotifyNote('Notifications are blocked for this site in your browser settings.');
  };

  const snoozed = snoozeUntil !== null && snoozeUntil > now ? snoozeUntil : null;

  return (
    <Dialog open={open} onClose={onClose} title="Alerts" description="Choose which moments Gridiron surfaces and how it tells you." size="lg">
      <div className="settings-grid">
        <section className="settings-section">
          <h3 className="settings-title">Which games</h3>
          <Segmented<AlertRules['scope']>
            label="Alert scope"
            value={rules.scope}
            options={[
              { value: 'all', label: 'All games' },
              { value: 'monitored', label: 'Pinned and focus' },
              { value: 'favorites', label: 'Favorites' },
            ]}
            onChange={(scope) => setRules({ scope })}
          />
          <p className="form-hint">
            {rules.scope === 'all' ? 'Every game on the selected day. Play-by-play is loaded for live games so scoring plays can be identified.' : rules.scope === 'monitored' ? 'Only games you pinned or added to Focus.' : 'Only games involving your favorite teams.'}
          </p>

          <h3 className="settings-title">Thresholds</h3>
          <NumberField label="Big play" suffix="yards or more" min={10} max={99} value={rules.bigPlayYards} onChange={(bigPlayYards) => setRules({ bigPlayYards })} />
          <NumberField label="Close game" suffix="points or fewer" min={1} max={16} value={rules.closeMargin} onChange={(closeMargin) => setRules({ closeMargin })} />
          <NumberField label="Late window" suffix="minutes left in the fourth quarter" min={1} max={15} value={Math.round(rules.lateSeconds / 60)} onChange={(m) => setRules({ lateSeconds: m * 60 })} />

          <h3 className="settings-title">Delivery</h3>
          <Switch label="Quiet mode" description="Keep moments in the feed without pop-ups or sound" checked={quiet} onChange={(v) => set({ quiet: v })} />
          <Switch label="Sound" description="A short chime for new moments. Off until you turn it on here." checked={sound} onChange={(v) => void toggleSound(v)} />
          {soundNote && (
            <p className="form-hint" role="status">
              {soundNote}
            </p>
          )}
          <Switch label="Browser notifications" description="Gridiron asks for permission only when you turn this on" checked={notifications} onChange={(v) => void toggleNotifications(v)} />
          {notifyNote && (
            <p className="form-hint" role="status">
              {notifyNote}
            </p>
          )}
          <div className="form-row">
            <span className="form-label">Snooze pop-ups, sound and notifications</span>
            <div className="button-row">
              {snoozed ? (
                <>
                  <span className="tag tag-attention">Snoozed until {clockTime(snoozed)}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ snoozeUntil: null })}>
                    Resume now
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ snoozeUntil: Date.now() + 15 * 60_000 })}>
                    15 minutes
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ snoozeUntil: Date.now() + 60 * 60_000 })}>
                    1 hour
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ snoozeUntil: Date.now() + untilSixAm() })}>
                    Until 6 AM
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">Moments</h3>
          <div className="switch-list">
            {ALERT_KINDS.map((k) => (
              <Switch key={k} label={ALERT_LABELS[k]} description={KIND_HELP[k]} checked={rules.enabled[k]} onChange={(v) => setRules({ enabled: { ...rules.enabled, [k]: v } })} />
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => usePrefs.getState().setAlertRules(DEFAULT_ALERT_RULES)}>
            <RotateCcw size={14} aria-hidden="true" /> Restore defaults
          </button>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">Screen reader announcements</h3>
          <p className="form-hint">Spoken politely, one at a time, for the kinds you choose.</p>
          <div className="check-grid">
            {ALERT_KINDS.map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={announce.includes(k)} onChange={(e) => set({ announce: e.target.checked ? [...announce, k] : announce.filter((x) => x !== k) })} />
                <span>{ALERT_LABELS[k]}</span>
              </label>
            ))}
          </div>

          <h3 className="settings-title">Muted games</h3>
          {muted.length === 0 ? (
            <p className="form-hint">No muted games. Use the bell on a card or game page to mute one.</p>
          ) : (
            <ul className="plain-list">
              {muted.map((gid) => {
                const g = bestSummary(world, gid);
                return (
                  <li key={gid} className="list-row">
                    <span>{g ? `${g.away.abbreviation} at ${g.home.abbreviation}` : 'A game from another day'}</span>
                    <button type="button" className="link-btn" onClick={() => usePrefs.getState().toggleMute(gid)}>
                      Unmute
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <PushSettings open={open} />
      </div>
    </Dialog>
  );
}

const LEAGUE_NAME = { all: 'All leagues', nfl: 'NFL', cfb: 'College' } as const;

export function BoardsDialog({ open, onClose }: DialogOpen) {
  const boards = usePrefs((s) => s.boards);
  const activeBoardId = usePrefs((s) => s.activeBoardId);
  const favorites = usePrefs((s) => s.favorites.length);
  const pinned = usePrefs((s) => s.pinned.length);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const ui = useUi.getState();

  const save = (e: FormEvent) => {
    e.preventDefault();
    const board = usePrefs.getState().saveBoard(name || 'My board');
    setName('');
    ui.showNotice(`Saved “${board.name}”`);
  };
  const share = async (b: SavedBoard) => {
    const param = encodeBoard({ name: b.name, teams: b.teams, games: b.games, focus: b.focus, league: b.league, divisions: b.divisions, layout: b.layout, density: b.density });
    const result = await shareLink(`${window.location.origin}/?${BOARD_PARAM}=${param}`, `Gridiron board: ${b.name}`);
    ui.showNotice(result === 'failed' ? 'Could not copy the board link' : 'Board link copied');
  };
  const remove = (b: SavedBoard) => {
    const removed = usePrefs.getState().deleteBoard(b.id);
    if (removed) ui.showNotice(`Deleted “${removed.name}”`, { label: 'Undo', run: () => usePrefs.getState().restoreBoard(removed) });
  };

  return (
    <Dialog open={open} onClose={onClose} title="Boards" description="Save your setup: favorite teams, pinned games, focus, league and layout. Team boards follow their teams to whichever day you open." size="md">
      <form className="board-save" onSubmit={save}>
        <label className="form-row grow">
          <span className="form-label">Save the current setup</span>
          <input type="text" maxLength={60} placeholder="Board name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary btn-sm">
          Save board
        </button>
      </form>
      <p className="form-hint">
        Includes {favorites} favorite {favorites === 1 ? 'team' : 'teams'} and {pinned} pinned {pinned === 1 ? 'game' : 'games'}.
      </p>
      {boards.length === 0 ? (
        <p className="empty-note">No saved boards yet.</p>
      ) : (
        <ul className="board-list">
          {boards.map((b) => (
            <li key={b.id} className={`board${b.id === activeBoardId ? ' is-active' : ''}`}>
              {editing === b.id ? (
                <form
                  className="board-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    usePrefs.getState().renameBoard(b.id, draft);
                    setEditing(null);
                  }}
                >
                  <label className="sr-only" htmlFor={`rename-${b.id}`}>
                    New name for {b.name}
                  </label>
                  <input id={`rename-${b.id}`} type="text" autoFocus maxLength={60} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <button type="submit" className="btn btn-primary btn-sm">
                    Save
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div className="board-main">
                    <p className="board-name">
                      {b.name}
                      {b.id === activeBoardId && <span className="tag tag-live">Active</span>}
                    </p>
                    <p className="board-meta mono">
                      {b.teams.length} teams · {b.games.length} pinned · {b.layout} · {LEAGUE_NAME[b.league]}
                    </p>
                  </div>
                  <div className="board-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        usePrefs.getState().applyBoard(b);
                        navigate({ name: b.layout === 'wall' ? 'wall' : b.layout === 'focus' ? 'focus' : 'slate' });
                        onClose();
                        ui.showNotice(`Applied “${b.name}”`);
                      }}
                    >
                      Apply
                    </button>
                    <IconButton label={`Copy a share link for ${b.name}`} icon={Share2} onClick={() => void share(b)} />
                    <IconButton
                      label={`Rename ${b.name}`}
                      icon={Pencil}
                      onClick={() => {
                        setEditing(b.id);
                        setDraft(b.name);
                      }}
                    />
                    <IconButton label={`Duplicate ${b.name}`} icon={CopyPlus} onClick={() => usePrefs.getState().duplicateBoard(b.id)} />
                    <IconButton label={`Delete ${b.name}`} icon={Trash2} onClick={() => remove(b)} />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-section-foot">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            usePrefs.getState().resetLayout();
            ui.showNotice('Layout reset to the defaults');
          }}
        >
          <RotateCcw size={14} aria-hidden="true" /> Reset layout
        </button>
      </div>
    </Dialog>
  );
}

export function SettingsDialog({ open, onClose }: DialogOpen) {
  const theme = usePrefs((s) => s.theme);
  const effects = usePrefs((s) => s.effects);
  const fieldStyle = usePrefs((s) => s.fieldStyle);
  const density = usePrefs((s) => s.density);
  const delaySeconds = usePrefs((s) => s.delaySeconds);
  const divisions = usePrefs((s) => s.divisions);
  const fieldSound = usePrefs((s) => s.fieldSound);
  const graphics = useGraphics();
  const [custom, setCustom] = useState(String(delaySeconds));
  const [fieldSoundNote, setFieldSoundNote] = useState<string | null>(null);
  const set = usePrefs.getState().set;
  const isPreset = (DELAY_PRESETS as readonly number[]).includes(delaySeconds);

  // The browser only allows audio after an interaction, and turning this on is
  // one, so the context is opened here and a play's sound is used as the test.
  const toggleFieldSound = async (on: boolean) => {
    if (!on) {
      set({ fieldSound: false });
      setFieldSoundNote(null);
      return;
    }
    if (await unlockSound()) {
      set({ fieldSound: true });
      playFieldSound('firstDown');
      setFieldSoundNote('Field sounds are on. That was a first down.');
    } else setFieldSoundNote('This browser blocked audio. Click anywhere on the page, then try again.');
  };

  return (
    <Dialog open={open} onClose={onClose} title="Display" size="md">
      <section className="settings-section">
        <h3 className="settings-title">Appearance</h3>
        <Segmented
          label="Appearance"
          value={theme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' },
          ]}
          onChange={(v) => set({ theme: v })}
        />
        {theme === 'system' && <p className="form-hint">Follows the light or dark setting on this device, and changes when it does.</p>}
      </section>
      <section className="settings-section">
        <h3 className="settings-title">Graphics and motion</h3>
        <Segmented
          label="Effects"
          value={effects}
          options={[
            { value: 'full', label: 'Full 3D' },
            { value: 'reduced', label: 'Reduced' },
            { value: 'flat', label: '2D' },
          ]}
          onChange={(v) => set({ effects: v })}
        />
        <Segmented
          label="Field style"
          value={fieldStyle}
          options={[
            { value: 'holo', label: 'Holographic' },
            { value: 'classic', label: 'Classic turf' },
          ]}
          onChange={(v) => set({ fieldStyle: v })}
        />
        <p className="form-hint">
          {effects === 'full' ? 'Interactive 3D fields with play animations.' : effects === 'reduced' ? '3D fields with brief fades instead of motion, at a lower resolution.' : 'Flat 2D fields: the lightest option for battery and older devices.'} A reduced-motion setting on your device is always respected.
        </p>
        <p className="form-hint">
          3D: {graphics.status === 'ok' ? `available · ${graphics.views} ${graphics.views === 1 ? 'field' : 'fields'} drawn · resolution ${graphics.dpr}x` : graphics.status === 'lost' ? 'paused after the graphics context was lost' : 'not supported in this browser, so fields are 2D'}
        </p>
        {graphics.status === 'lost' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => graphics.retry()}>
            Retry 3D
          </button>
        )}
        <Switch
          label="Field sounds"
          description="Short sounds for what happens on the field, on a game page only. Quieter than the alert chime, and off until you turn it on here."
          checked={fieldSound}
          onChange={(v) => void toggleFieldSound(v)}
        />
        {fieldSoundNote && <p className="form-hint">{fieldSoundNote}</p>}
      </section>
      <section className="settings-section">
        <h3 className="settings-title">Cards</h3>
        <Segmented
          label="Card density"
          value={density}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
          onChange={(v) => set({ density: v })}
        />
      </section>
      <OddsSettings />
      <section className="settings-section">
        <h3 className="settings-title">Spoiler delay</h3>
        <p className="form-hint">Hold everything back by the same amount (scores, fields, plays, alerts and Watch next) to stay behind a broadcast.</p>
        <Segmented<string>
          label="Spoiler delay"
          value={isPreset ? String(delaySeconds) : null}
          options={DELAY_PRESETS.map((s) => ({ value: String(s), label: s === 0 ? 'Off' : `${s}s` }))}
          onChange={(v) => usePrefs.getState().setDelay(Number(v))}
        />
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            usePrefs.getState().setDelay(clampDelaySeconds(Number(custom)));
          }}
        >
          <label className="form-row">
            <span className="form-label">Custom delay in seconds (0 to {MAX_DELAY_SECONDS})</span>
            <input type="number" min={0} max={MAX_DELAY_SECONDS} value={custom} onChange={(e) => setCustom(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-ghost btn-sm">
            Apply
          </button>
        </form>
        {!isPreset && <p className="form-hint">Current delay: {delaySeconds} seconds.</p>}
      </section>
      <section className="settings-section">
        <h3 className="settings-title">College divisions</h3>
        <div className="check-row">
          {COLLEGE_DIVISIONS.map((d) => (
            <label key={d} className="check">
              <input
                type="checkbox"
                checked={divisions.includes(d)}
                onChange={(e) => {
                  const next = e.target.checked ? [...divisions, d] : divisions.filter((x) => x !== d);
                  if (next.length) set({ divisions: COLLEGE_DIVISIONS.filter((x) => next.includes(x)) });
                }}
              />
              <span>{DIVISION_LABEL[d]}</span>
            </label>
          ))}
        </div>
        <p className="form-hint">Division II and III add many games and are polled only while selected.</p>
      </section>
    </Dialog>
  );
}

export function HelpDialog({ open, onClose }: DialogOpen) {
  const health = useLive((s) => s.health);
  const hello = useLive((s) => s.hello);
  const coverage = useLive((s) => s.world.coverage);
  const transport = useLive((s) => s.connection.transport);
  const provider = hello?.provider ?? health?.provider ?? null;
  return (
    <Dialog open={open} onClose={onClose} title="Data and sources" size="lg">
      <div className="prose">
        <section>
          <h3>Where the data comes from</h3>
          <p>{provider ? provider.description : 'Provider details load with the first connection.'}</p>
          <p>
            The Gridiron server polls the provider and shares the same requests across every open tab. Your browser talks only to the Gridiron server{transport === 'sse' ? ', over a server stream' : transport === 'poll' ? ', by polling' : ''}. Provider keys, when a licensed provider is configured, stay on the server.
          </p>
        </section>
        <section>
          <h3>Coverage{coverage ? ` for ${dateKeyToLabel(coverage.date)}` : ''}</h3>
          {coverage ? (
            <>
              <div className="table-wrap">
                <table className="stats">
                  <caption className="sr-only">Coverage by division</caption>
                  <thead>
                    <tr>
                      <th scope="col">Division</th>
                      <th scope="col">Games</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.divisions.map((d) => (
                      <tr key={d.division}>
                        <th scope="row">{d.label}</th>
                        <td className="mono">{d.games}</td>
                        <td>{d.health === 'connected' ? 'OK' : d.health === 'stale' ? 'Delayed' : d.health === 'unavailable' ? 'Unavailable' : 'Waiting'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="form-hint">{coverage.discovery}</p>
              {coverage.limitations.length > 0 && (
                <ul>
                  {coverage.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p>Coverage details appear once the slate loads.</p>
          )}
          <p>College play-by-play is not complete. Some games, especially outside FBS, are reported with scores only; their cards say “Score-only coverage”.</p>
        </section>
        <section>
          <h3>How updates work</h3>
          <ul>
            <li>Scoreboards refresh about every 25 seconds while games are live and every few minutes otherwise.</li>
            <li>A game you open refreshes about every 12 seconds, games on screen about every 25 seconds, and other live games about once a minute.</li>
            <li>Failed requests back off and retry. The last good information stays on screen marked as delayed; it is never replaced with invented data.</li>
            <li>Clocks are shown exactly as last reported and are never counted down locally, so a clock can look paused between updates.</li>
            <li>The provider has its own delay on top of this. None of this is official real-time tracking.</li>
          </ul>
        </section>
        <section>
          <h3>Reading the field</h3>
          <ul>
            <li>Fields are schematic. The real stadium direction is not reported, so the away team always defends the left end zone.</li>
            <li>The ball sits at the reported yard line on the centre of the field, because no provider reports where the ball is across the field.</li>
            <li>Movement between reported spots uses simple shapes: a sweep for runs, an arc for passes, a high arc for kicks. Routes, formations, landing points and tackle locations are not reported and are never drawn.</li>
            <li>Blue marks the line of scrimmage and amber the line to gain. On goal to go the goal line is highlighted instead.</li>
            <li>When a spot is not reported, the field says “Ball spot unavailable” instead of guessing.</li>
            <li>Markings follow the 2026 NFL and NCAA rulebooks: hash mark spacing, number placement, the NFL try line, goal post dimensions and pylons.</li>
          </ul>
        </section>
        <section>
          <h3>Alerts and Watch next</h3>
          <ul>
            <li>Touchdowns, field goals, safeties and turnovers come only from reported play types, never from a score change alone. An unexplained change is labeled “Score changed”.</li>
            <li>Games already in progress when you arrive are not replayed as new moments. A correction updates or withdraws a moment instead of repeating it.</li>
            <li>Watch next uses fixed, visible rules: overtime, one-score games late, red-zone chances to tie or lead, fourth downs, recent big moments and favorites. There are no probabilities or excitement scores.</li>
          </ul>
        </section>
        <OddsHelp />
        <section>
          <h3>Replay lab and licensed data</h3>
          <p>The replay lab plays captured provider responses through the same code as live and is labeled everywhere. A licensed provider such as Sportradar can replace the public feed on the server without changing the interface.</p>
        </section>
        <section>
          <h3>No video</h3>
          <p>Broadcast networks are listed as reported. Gridiron does not stream games, link to streams or imply access to video.</p>
        </section>
      </div>
    </Dialog>
  );
}

export function ShortcutsDialog({ open, onClose }: DialogOpen) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="sm">
      <dl className="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div key={s.label} className="shortcut">
            <dt>
              {s.keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </dt>
            <dd>{s.label}</dd>
          </div>
        ))}
      </dl>
      <p className="form-hint">Single-key shortcuts are ignored while you type in a field.</p>
    </Dialog>
  );
}

export function ReplayLabDialog({ open, onClose }: DialogOpen) {
  const [scenarios, setScenarios] = useState<ReplayScenario[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source = useLive((s) => s.source);

  useEffect(() => {
    if (!open || scenarios) return;
    replayApi
      .scenarios()
      .then((r) => setScenarios(r.scenarios))
      .catch((e: Error) => setError(e.message));
  }, [open, scenarios]);

  const start = (id: string) => {
    usePrefs.getState().set({ dayMode: 'today', date: null });
    navigate({ name: 'slate' }, { params: { replay: id, date: null } });
    onClose();
  };
  const captured = scenarios?.filter((s) => !s.synthetic) ?? [];
  const synthetic = scenarios?.filter((s) => s.synthetic) ?? [];
  const row = (s: ReplayScenario) => (
    <li key={s.id} className="scenario">
      <div className="scenario-main">
        <p className="scenario-name">
          {s.label}
          {s.synthetic && <span className="tag tag-attention">Synthetic</span>}
        </p>
        <p className="form-hint">{s.description}</p>
        <p className="mono muted scenario-date">{dateKeyToLabel(s.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</p>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => start(s.id)}>
        Start
      </button>
    </li>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Replay lab"
      description="Replays captured ESPN responses through the same normalization, polling engine, alerts and fields as live. Replays are labeled on every screen and are never shown as live."
      size="md"
    >
      {error && <p className="banner banner-attention">The replay lab is unavailable: {error}</p>}
      {!scenarios && !error && <p className="muted">Loading scenarios…</p>}
      {captured.length > 0 && (
        <section className="settings-section">
          <h3 className="settings-title">Captured real games</h3>
          <ul className="scenario-list">{captured.map(row)}</ul>
        </section>
      )}
      {synthetic.length > 0 && (
        <section className="settings-section">
          <h3 className="settings-title">Synthetic test scenarios</h3>
          <p className="form-hint">Captured games with deliberate edits, such as an overturned touchdown, a delayed burst, missing spots or a provider outage, to show how Gridiron copes.</p>
          <ul className="scenario-list">{synthetic.map(row)}</ul>
        </section>
      )}
      {source.kind === 'replay' && (
        <div className="dialog-section-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setParams({ replay: null });
              onClose();
            }}
          >
            Exit the replay and return to live
          </button>
        </div>
      )}
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useUi((s) => s.dialog);
  const close = () => useUi.getState().setDialog(null);
  return (
    <>
      <AlertSettingsDialog open={dialog === 'alerts'} onClose={close} />
      <BoardsDialog open={dialog === 'boards'} onClose={close} />
      <SettingsDialog open={dialog === 'settings'} onClose={close} />
      <HelpDialog open={dialog === 'help'} onClose={close} />
      <ShortcutsDialog open={dialog === 'shortcuts'} onClose={close} />
      <ReplayLabDialog open={dialog === 'replay'} onClose={close} />
    </>
  );
}
