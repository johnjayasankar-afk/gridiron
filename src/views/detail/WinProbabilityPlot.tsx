/**
 * The win probability view of the game flow chart: the home team's chance after each
 * reported play, across the game clock. The biggest swings are buttons that open their
 * play on the field; pointing anywhere names the nearest play, and a click opens it.
 * When an exchange's price history is known, the home team's contract price is drawn
 * dashed on the same scale, placed by the time of the plays around each price.
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { formatCents, trackPriceAt, type MarketTrack } from '../../../shared/marketHistory';
import type { GameSummary } from '../../../shared/model';
import { formatChance, formatSwing } from '../../../shared/odds';
import type { ProbabilityPoint, ProbabilitySeries } from '../../../shared/winProbability';

export interface WinProbabilityPlotProps {
  game: GameSummary;
  series: ProbabilitySeries;
  width: number;
  height: number;
  colors: { home: string; away: string };
  uid: string;
  live: boolean;
  selectedOrder: number | null;
  onSelectPlay: (order: number) => void;
  /** The home team's market price across the game, when known. */
  market: MarketTrack | null;
}

export function WinProbabilityPlot({ game, series, width, height, colors, uid, live, selectedOrder, onSelectPlay, market }: WinProbabilityPlotProps) {
  const [hover, setHover] = useState<ProbabilityPoint | null>(null);
  const [roving, setRoving] = useState(0);
  const dots = useRef<Array<HTMLButtonElement | null>>([]);
  const pad = { top: 12, right: 12, bottom: 24, left: width < 560 ? 42 : 52 };
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const X = (x: number) => pad.left + x * innerW;
  const Y = (home: number) => pad.top + (1 - home) * innerH;
  const mid = Y(0.5);
  const points = series.points;
  const first = points[0];
  const last = points[points.length - 1];

  let line = '';
  points.forEach((p, i) => {
    line += `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.home).toFixed(1)}`;
  });
  const area = `${line}L${X(last.x).toFixed(1)},${mid.toFixed(1)}L${X(first.x).toFixed(1)},${mid.toFixed(1)}Z`;
  let marketLine = '';
  market?.points.forEach((p, i) => {
    marketLine += `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.price).toFixed(1)}`;
  });
  const marketEnd = market ? market.points[market.points.length - 1] : null;
  const marketText = (x: number) => {
    const p = trackPriceAt(market, x);
    return p ? `${market?.source ?? 'Market'} ${game.home.abbreviation} ${formatCents(p.price)}` : null;
  };
  const selected = selectedOrder === null ? null : (points.find((p) => p.order === selectedOrder) ?? null);
  const half = Math.floor(game.status.regulationPeriods / 2);
  const swings = series.swings;
  const focusIndex = Math.min(roving, Math.max(0, swings.length - 1));

  /** The latest point at or nearest the pointer's position across the game. */
  const nearest = (clientX: number, box: DOMRect): ProbabilityPoint => {
    const x = (clientX - box.left - pad.left) / innerW;
    let best = first;
    for (const p of points) if (Math.abs(p.x - x) <= Math.abs(best.x - x)) best = p;
    return best;
  };
  const leaderText = (p: ProbabilityPoint) => {
    const away = Math.max(0, 1 - p.home - p.tie);
    return p.home >= away ? `${game.home.abbreviation} ${formatChance(p.home)}` : `${game.away.abbreviation} ${formatChance(away)}`;
  };
  const swingText = (p: ProbabilityPoint) => {
    const swing = p.swing ?? 0;
    return `${(swing >= 0 ? game.home : game.away).abbreviation} ${formatSwing(Math.abs(swing))}`;
  };
  const onDotKey = (e: KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = Math.min(swings.length - 1, index + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = swings.length - 1;
    else return;
    e.preventDefault();
    setRoving(next);
    dots.current[next]?.focus();
  };

  return (
    <>
      <svg className="flow-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={`${uid}-wp-top`}>
            <rect x={0} y={0} width={width} height={mid} />
          </clipPath>
          <clipPath id={`${uid}-wp-bottom`}>
            <rect x={0} y={mid} width={width} height={height - mid} />
          </clipPath>
        </defs>
        {[0.25, 0.75].map((v) => (
          <line key={v} className="flow-grid" x1={pad.left} x2={width - pad.right} y1={Y(v)} y2={Y(v)} />
        ))}
        {series.periods.map((p, i) =>
          i > 0 ? <line key={`d-${p.label}`} className={`flow-period${i === half ? ' is-half' : ''}`} x1={X(p.x0)} x2={X(p.x0)} y1={pad.top} y2={height - pad.bottom} /> : null,
        )}
        {series.periods.map((p) => (
          <text key={`t-${p.label}`} className="flow-axis" x={X((p.x0 + p.x1) / 2)} y={height - 7} textAnchor="middle">
            {p.label}
          </text>
        ))}
        <line className="flow-zero" x1={pad.left} x2={width - pad.right} y1={mid} y2={mid} />
        <text className="flow-team" x={pad.left - 10} y={Y(0.8)} textAnchor="end" dominantBaseline="middle">
          {game.home.abbreviation}
        </text>
        <text className="flow-team" x={pad.left - 10} y={Y(0.2)} textAnchor="end" dominantBaseline="middle">
          {game.away.abbreviation}
        </text>
        <text className="flow-axis" x={pad.left - 10} y={mid} textAnchor="end" dominantBaseline="middle">
          50%
        </text>
        <path className="flow-area" d={area} clipPath={`url(#${uid}-wp-top)`} style={{ fill: colors.home }} />
        <path className="flow-area" d={area} clipPath={`url(#${uid}-wp-bottom)`} style={{ fill: colors.away }} />
        <path className="wp-line" d={line} clipPath={`url(#${uid}-wp-top)`} style={{ stroke: colors.home }} />
        <path className="wp-line" d={line} clipPath={`url(#${uid}-wp-bottom)`} style={{ stroke: colors.away }} />
        {market && <path className="wp-market" d={marketLine} />}
        {marketEnd && <circle className="wp-market-end" cx={X(marketEnd.x)} cy={Y(marketEnd.price)} r={2.5} />}
        {selected && <line className="wp-selected" x1={X(selected.x)} x2={X(selected.x)} y1={pad.top} y2={height - pad.bottom} />}
        {hover && <line className="wp-hover" x1={X(hover.x)} x2={X(hover.x)} y1={pad.top} y2={height - pad.bottom} />}
      </svg>

      <div
        className="wp-hit"
        style={{ left: pad.left, top: pad.top, width: innerW, height: innerH }}
        aria-hidden="true"
        onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.parentElement!.getBoundingClientRect()))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const p = nearest(e.clientX, e.currentTarget.parentElement!.getBoundingClientRect());
          if (p.order !== null) onSelectPlay(p.order);
        }}
      />

      {swings.map((p, i) => (
        <button
          key={p.playId}
          ref={(el) => {
            dots.current[i] = el;
          }}
          type="button"
          className={`flow-dot wp-dot${p.order !== null && p.order === selectedOrder ? ' is-selected' : ''}${hover === p ? ' is-active' : ''}`}
          style={{ left: X(p.x), top: Y(p.home), '--dot': (p.swing ?? 0) >= 0 ? colors.home : colors.away } as CSSProperties}
          tabIndex={i === focusIndex ? 0 : -1}
          aria-label={`${p.label}, win probability swing ${swingText(p)} points, now ${leaderText(p)}.${marketText(p.x) ? ` ${marketText(p.x)}.` : ''}${p.description ? ` ${p.description}` : ''}${p.order !== null ? ' Show this play on the field.' : ''}`}
          aria-disabled={p.order === null ? true : undefined}
          onPointerEnter={() => setHover(p)}
          onPointerLeave={() => setHover(null)}
          onFocus={() => {
            setHover(p);
            setRoving(i);
          }}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => onDotKey(e, i)}
          onClick={() => {
            if (p.order !== null) onSelectPlay(p.order);
          }}
        />
      ))}

      {live && <span className="flow-now" style={{ left: X(last.x), top: Y(last.home) }} aria-hidden="true" />}

      {hover && (
        <div className={`flow-tip${Y(hover.home) < 92 ? ' is-below' : ''}`} style={{ left: Math.min(Math.max(X(hover.x), 118), Math.max(118, width - 118)), top: Y(hover.home) }} aria-hidden="true">
          <p className="flow-tip-meta mono">{[hover.label, hover.swing !== null && Math.abs(hover.swing) >= 0.005 ? swingText(hover) : null].filter(Boolean).join(' · ')}</p>
          <p className="flow-tip-score">{leaderText(hover)}</p>
          {marketText(hover.x) && <p className="flow-tip-market mono">{marketText(hover.x)}</p>}
          {hover.description && <p className="flow-tip-desc">{hover.description}</p>}
        </div>
      )}
    </>
  );
}
