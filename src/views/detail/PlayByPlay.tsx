/** Play-by-play with filters, search, jump to latest, and click-to-inspect. Provider gaps are shown, never filled. */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { downDistance, teamFor } from '../../../shared/format';
import type { GameDetail, GameSummary, PlayEvent } from '../../../shared/model';
import { ADMIN_KINDS } from '../../../shared/model';
import { filterPlays, PLAY_FILTERS, playTags, type PlayFilter } from '../../../shared/replayFrames';
import { periodLong } from '../../../shared/util';
import { useReducedMotion } from '../../lib/motion';

const TAG_LABEL: Partial<Record<PlayFilter, string>> = { scoring: 'Score', turnovers: 'Turnover', big: 'Big play', fourth: '4th down', penalties: 'Penalty', reviews: 'Review' };

export function PlayByPlay({ detail, game, selectedOrder, onSelect, bigPlayYards }: { detail: GameDetail; game: GameSummary; selectedOrder: number | null; onSelect: (order: number | null) => void; bigPlayYards: number }) {
  const [filter, setFilter] = useState<PlayFilter>('all');
  const [query, setQuery] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const reduced = useReducedMotion();
  const plays = useMemo(() => [...filterPlays(detail.plays, filter, query, bigPlayYards)].reverse(), [detail.plays, filter, query, bigPlayYards]);
  const gapsAfter = useMemo(() => new Map(detail.gaps.filter((g) => g.afterPlayId).map((g) => [g.afterPlayId as string, g])), [detail.gaps]);

  // Keep the selected play visible by scrolling the list itself, never the page, so the field stays in view during replay.
  useEffect(() => {
    if (selectedOrder === null) return;
    const container = list.current;
    const item = container?.querySelector<HTMLElement>(`[data-order="${selectedOrder}"]`);
    if (!container || !item) return;
    const c = container.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    if (r.top < c.top + 40 || r.bottom > c.bottom - 8) {
      container.scrollTo({ top: container.scrollTop + (r.top - c.top) - c.height / 3, behavior: reduced ? 'auto' : 'smooth' });
    }
  }, [selectedOrder, reduced]);

  if (!detail.plays.length) {
    return <p className="empty-note">{game.coverage.level === 'score-only' ? 'This game has score-only coverage: the provider does not report play-by-play for it.' : 'No plays reported yet.'}</p>;
  }

  let lastPeriod: number | null | undefined;
  const row = (p: PlayEvent) => {
    const admin = ADMIN_KINDS.has(p.kind);
    const tags = admin ? [] : [...playTags(p, bigPlayYards)];
    const team = teamFor(game, p.offense);
    const selected = selectedOrder === p.order;
    const header =
      p.period !== lastPeriod ? (
        <li className="pbp-period eyebrow" aria-hidden="true">
          {periodLong(p.period, game.status.regulationPeriods) ?? 'Period not reported'}
        </li>
      ) : null;
    lastPeriod = p.period;
    const gap = gapsAfter.get(p.id);
    return (
      <Fragment key={p.id}>
        {gap && <li className="pbp-gap">Provider history gap after this point: {gap.reason}</li>}
        {header}
        <li className={`pbp-item${admin ? ' is-admin' : ''}${selected ? ' is-selected' : ''}`} data-order={p.order}>
          {admin ? (
            <div className="pbp-row">
              <span className="pbp-clock mono">{p.clock ?? ''}</span>
              <span className="pbp-body">
                <span className="pbp-desc">{p.description}</span>
              </span>
            </div>
          ) : (
            <button type="button" className="pbp-row" aria-pressed={selected} onClick={() => onSelect(selected ? null : p.order)}>
              <span className="pbp-clock mono">{p.clock ?? ''}</span>
              <span className="pbp-body">
                <span className="pbp-situation mono">
                  {team?.abbreviation ?? ''} {p.start?.downDistanceText ?? downDistance(p.start) ?? ''}
                </span>
                <span className="pbp-desc">{p.description}</span>
              </span>
              <span className="pbp-tags">
                {tags
                  .filter((t) => TAG_LABEL[t])
                  .map((t) => (
                    <span key={t} className={`tag tag-${t}`}>
                      {TAG_LABEL[t]}
                    </span>
                  ))}
              </span>
            </button>
          )}
        </li>
      </Fragment>
    );
  };

  return (
    <div className="pbp">
      <div className="pbp-tools">
        <div className="chip-row" role="group" aria-label="Filter plays">
          {PLAY_FILTERS.map((f) => (
            <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="pbp-actions">
          <label className="search-field">
            <span className="sr-only">Search plays</span>
            <input type="search" placeholder="Search plays" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              onSelect(null);
              list.current?.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
            }}
          >
            Jump to latest
          </button>
        </div>
      </div>
      <p className="pbp-count mono" aria-live="polite">
        {plays.length} of {detail.plays.length} entries · newest first
      </p>
      {detail.gaps.length > 0 && <p className="banner banner-attention">The provider&apos;s history has {detail.gaps.length} {detail.gaps.length === 1 ? 'gap' : 'gaps'}. They are marked below and are never filled in.</p>}
      <ol className="pbp-list" ref={list}>
        {plays.map(row)}
      </ol>
    </div>
  );
}
