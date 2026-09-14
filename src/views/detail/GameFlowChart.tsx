/**
 * Game flow: the reported score margin across the game clock. Each scoring play
 * is a point that names the play and opens it on the field. When the provider
 * reports win probability, a second view draws it play by play. Only reported
 * values are drawn; nothing is projected forward.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import { flowStats, gameFlow } from '../../../shared/gameFlow';
import { marketTrack } from '../../../shared/marketHistory';
import type { GameDetail, GameSummary } from '../../../shared/model';
import { isLiveOrPaused } from '../../../shared/model';
import { formatChance, formatSwing } from '../../../shared/odds';
import { winProbabilitySeries } from '../../../shared/winProbability';
import { Segmented } from '../../components/controls';
import { accentFor } from '../../field/color';
import { useIsDark } from '../../lib/theme';
import { usePrefs } from '../../state/prefs';
import { WinProbabilityPlot } from './WinProbabilityPlot';

const SCORE_KIND: Record<string, string> = { touchdown: 'Touchdown', field_goal: 'Field goal', safety: 'Safety', conversion: 'Conversion', unknown: 'Score' };

type FlowView = 'margin' | 'probability';
const VIEWS: Array<{ value: FlowView; label: string }> = [
  { value: 'margin', label: 'Score margin' },
  { value: 'probability', label: 'Win probability' },
];

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export interface GameFlowChartProps {
  game: GameSummary;
  detail: GameDetail;
  /** The play shown on the field, to mark its point. */
  selectedOrder: number | null;
  onSelectPlay: (order: number) => void;
}

export function GameFlowChart({ game, detail, selectedOrder, onSelectPlay }: GameFlowChartProps) {
  const dark = useIsDark();
  const box = useRef<HTMLDivElement>(null);
  const dots = useRef<Array<HTMLButtonElement | null>>([]);
  const width = useWidth(box);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [active, setActive] = useState<number | null>(null);
  const [roving, setRoving] = useState<number | null>(null);
  const [view, setView] = useState<FlowView>('margin');
  const showOdds = usePrefs((s) => s.showOdds);
  const series = useMemo(() => gameFlow(game, detail.scoring), [game, detail.scoring]);
  const stats = useMemo(() => flowStats(series), [series]);
  const orders = useMemo(() => new Map(detail.plays.map((p) => [p.id, p.order])), [detail.plays]);
  const probability = useMemo(() => (showOdds ? winProbabilitySeries(game, detail) : null), [showOdds, game, detail]);
  const track = useMemo(() => (probability ? marketTrack(probability, detail) : null), [probability, detail]);

  const kind = game.status.kind;
  if (kind === 'scheduled' || kind === 'postponed' || kind === 'canceled' || game.coverage.level === 'score-only') return null;
  const points = series.points;
  const last = points[points.length - 1];
  const end = series.end;
  const itemized = !end || (end.home === last.home && end.away === last.away);
  // Points on the board with no itemized scoring at all cannot be placed on the clock honestly.
  if (!itemized && points.length === 1 && !probability) return null;

  const mode: FlowView = view === 'probability' && probability ? 'probability' : 'margin';
  const colors = { home: accentFor(game.home.color, dark), away: accentFor(game.away.color, dark) };
  const compact = width > 0 && width < 560;
  const height = compact ? 150 : 184;
  const pad = { top: 12, right: 12, bottom: 24, left: compact ? 42 : 52 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const zero = pad.top + innerH / 2;
  const X = (x: number) => pad.left + x * innerW;
  const Y = (margin: number) => zero - (margin / series.extent) * (innerH / 2);

  const scoring = points.slice(1);
  let line = `M${X(0)},${zero}`;
  for (const p of scoring) line += `H${X(p.x)}V${Y(p.margin)}`;
  const tailX = X(end ? end.x : last.x);
  line += `H${tailX}`;
  const area = `${line}V${zero}H${X(0)}Z`;
  const step = series.extent > 28 ? 14 : 7;
  const grid: number[] = [];
  for (let m = step; m < series.extent; m += step) grid.push(m, -m);
  const live = isLiveOrPaused(kind);
  const half = Math.floor(game.status.regulationPeriods / 2);
  const focusIndex = roving !== null && roving < scoring.length ? roving : scoring.length - 1;
  const leads = (['away', 'home'] as const).filter((side) => stats.largestLead[side] > 0);

  const onDotKey = (e: KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = Math.min(scoring.length - 1, index + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = scoring.length - 1;
    else return;
    e.preventDefault();
    setRoving(next);
    dots.current[next]?.focus();
  };

  const tip = active !== null ? (scoring[active] ?? null) : null;

  // Win probability headline: where it stands now, and the biggest single-play swing.
  const nowPoint = probability ? probability.points[probability.points.length - 1] : null;
  const nowAway = nowPoint ? Math.max(0, 1 - nowPoint.home - nowPoint.tie) : 0;
  const biggest = probability ? [...probability.swings].sort((a, b) => Math.abs(b.swing ?? 0) - Math.abs(a.swing ?? 0))[0] : undefined;

  return (
    <section className="panel flow" aria-label="Game flow">
      <header className="flow-head">
        <div>
          <div className="flow-title">
            <p className="eyebrow">Game flow</p>
            {probability && <Segmented<FlowView> className="flow-view" label="Chart" value={mode} options={VIEWS} onChange={setView} />}
          </div>
          {mode === 'margin' ? (
            <p className="flow-stats">
              {leads.length > 0 && (
                <span>
                  Largest lead
                  {leads.map((side) => (
                    <strong key={side}>
                      <i className="flow-key" style={{ background: colors[side] }} aria-hidden="true" />
                      {game[side].abbreviation} +{stats.largestLead[side]}
                    </strong>
                  ))}
                </span>
              )}
              <span>
                Lead changes <strong>{stats.leadChanges}</strong>
              </span>
              <span>
                Ties <strong>{stats.ties}</strong>
              </span>
            </p>
          ) : (
            nowPoint && (
              <p className="flow-stats">
                <span>
                  {kind === 'final' ? 'At the end' : 'Now'}
                  <strong>
                    <i className="flow-key" style={{ background: nowPoint.home >= nowAway ? colors.home : colors.away }} aria-hidden="true" />
                    {nowPoint.home >= nowAway ? `${game.home.abbreviation} ${formatChance(nowPoint.home)}` : `${game.away.abbreviation} ${formatChance(nowAway)}`}
                  </strong>
                </span>
                {biggest && biggest.swing !== null && (
                  <span>
                    Biggest swing
                    <strong>
                      {(biggest.swing >= 0 ? game.home : game.away).abbreviation} {formatSwing(Math.abs(biggest.swing))}
                    </strong>
                    {biggest.label}
                  </span>
                )}
                {track && (
                  <span>
                    <i className="flow-key is-market" aria-hidden="true" />
                    {track.source} price, {game.home.abbreviation} to win
                  </span>
                )}
              </p>
            )
          )}
        </div>
        <p className="flow-state mono">{kind === 'final' ? 'Final' : live && end ? `As of ${end.label}` : ''}</p>
      </header>

      <div className="flow-chart" ref={box} style={{ height }}>
        {width > 0 && mode === 'probability' && probability && (
          <WinProbabilityPlot game={game} series={probability} width={width} height={height} colors={colors} uid={uid} live={live} selectedOrder={selectedOrder} onSelectPlay={onSelectPlay} market={track} />
        )}
        {width > 0 && mode === 'margin' && (
          <>
            <svg className="flow-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
              <defs>
                <clipPath id={`${uid}-top`}>
                  <rect x={0} y={0} width={width} height={zero} />
                </clipPath>
                <clipPath id={`${uid}-bottom`}>
                  <rect x={0} y={zero} width={width} height={height - zero} />
                </clipPath>
              </defs>
              {grid.map((m) => (
                <line key={m} className="flow-grid" x1={pad.left} x2={width - pad.right} y1={Y(m)} y2={Y(m)} />
              ))}
              {series.periods.map((p, i) =>
                i > 0 ? <line key={`d-${p.label}`} className={`flow-period${i === half ? ' is-half' : ''}`} x1={X(p.x0)} x2={X(p.x0)} y1={pad.top} y2={height - pad.bottom} /> : null,
              )}
              {series.periods.map((p) => (
                <text key={`t-${p.label}`} className="flow-axis" x={X((p.x0 + p.x1) / 2)} y={height - 7} textAnchor="middle">
                  {p.label}
                </text>
              ))}
              <line className="flow-zero" x1={pad.left} x2={width - pad.right} y1={zero} y2={zero} />
              <text className="flow-team" x={pad.left - 10} y={Y(series.extent / 2)} textAnchor="end" dominantBaseline="middle">
                {game.home.abbreviation}
              </text>
              <text className="flow-team" x={pad.left - 10} y={Y(-series.extent / 2)} textAnchor="end" dominantBaseline="middle">
                {game.away.abbreviation}
              </text>
              <text className="flow-axis" x={pad.left - 10} y={Y(series.extent)} textAnchor="end" dominantBaseline="hanging">
                +{series.extent}
              </text>
              <text className="flow-axis" x={pad.left - 10} y={Y(-series.extent)} textAnchor="end">
                +{series.extent}
              </text>
              <path className="flow-area" d={area} clipPath={`url(#${uid}-top)`} style={{ fill: colors.home }} />
              <path className="flow-area" d={area} clipPath={`url(#${uid}-bottom)`} style={{ fill: colors.away }} />
              <path className="flow-line" d={line} clipPath={`url(#${uid}-top)`} style={{ stroke: colors.home }} />
              <path className="flow-line" d={line} clipPath={`url(#${uid}-bottom)`} style={{ stroke: colors.away }} />
              {!itemized && end && <path className="flow-gap" d={`M${tailX},${Y(last.margin)}V${Y(end.margin)}`} />}
              {live && end && <line className="flow-now-line" x1={tailX} x2={tailX} y1={pad.top} y2={height - pad.bottom} />}
            </svg>

            {scoring.map((p, i) => {
              const order = p.event?.playId ? (orders.get(p.event.playId) ?? null) : null;
              const team = p.team ? game[p.team] : null;
              const what = SCORE_KIND[p.event?.kind ?? 'unknown'] ?? 'Score';
              const text = `${p.label}, ${team ? `${team.abbreviation} ` : ''}${what.toLowerCase()}. ${game.away.abbreviation} ${p.away}, ${game.home.abbreviation} ${p.home}.`;
              return (
                <button
                  key={p.event?.id ?? i}
                  ref={(el) => {
                    dots.current[i] = el;
                  }}
                  type="button"
                  className={`flow-dot${order !== null && order === selectedOrder ? ' is-selected' : ''}${active === i ? ' is-active' : ''}`}
                  style={{ left: X(p.x), top: Y(p.margin), '--dot': p.team ? colors[p.team] : 'var(--text-tone)' } as CSSProperties}
                  tabIndex={i === focusIndex ? 0 : -1}
                  aria-label={order !== null ? `${text} Show this play on the field.` : text}
                  aria-disabled={order === null ? true : undefined}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                  onFocus={() => {
                    setActive(i);
                    setRoving(i);
                  }}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  onKeyDown={(e) => onDotKey(e, i)}
                  onClick={() => {
                    if (order !== null) onSelectPlay(order);
                  }}
                />
              );
            })}

            {live && end && <span className="flow-now" style={{ left: tailX, top: Y(end.margin) }} aria-hidden="true" />}

            {tip && (
              <div className={`flow-tip${Y(tip.margin) < 92 ? ' is-below' : ''}`} style={{ left: Math.min(Math.max(X(tip.x), 118), Math.max(118, width - 118)), top: Y(tip.margin) }} aria-hidden="true">
                <p className="flow-tip-meta mono">{[tip.label, SCORE_KIND[tip.event?.kind ?? 'unknown']].filter(Boolean).join(' · ')}</p>
                <p className="flow-tip-score">
                  {tip.team && <i className="flow-key" style={{ background: colors[tip.team] }} />}
                  {game.away.abbreviation} {tip.away} · {game.home.abbreviation} {tip.home}
                </p>
                {tip.event?.description && <p className="flow-tip-desc">{tip.event.description}</p>}
              </div>
            )}
          </>
        )}
        {mode === 'margin' && scoring.length === 0 && <p className="flow-empty">No points reported yet</p>}
      </div>
      {mode === 'margin' && !itemized && <p className="flow-note">Some scoring is not itemized by the provider yet, so the latest change is drawn dashed.</p>}
      {mode === 'probability' && (
        <p className="flow-note">
          {track
            ? `ESPN's model after each reported play. Dashed: ${track.source}'s price for ${game.home.abbreviation} to win${track.captured ? ', captured each minute' : ''}, placed between plays by time, up to the latest play. Select a marked swing, or any point on the line, to see that play on the field.`
            : "ESPN's model after each reported play. The biggest swings are marked; select one, or any point on the line, to see that play on the field."}
        </p>
      )}
    </section>
  );
}
