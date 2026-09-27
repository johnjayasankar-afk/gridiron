/**
 * The seam between Gridiron and a data provider.
 *
 * Everything above this interface (the engine, the API, the client) works only
 * with the normalized model in shared/model.ts. A licensed provider such as
 * Sportradar is added by implementing SportsProvider; the UI does not change.
 * See docs/PROVIDERS.md for the replacement guide.
 */
import type { ConferenceInfo, Division, DivisionCoverage, GameDetail, GameId, GameSummary, LeagueId } from '../../shared/model.js';

export interface ProviderInfo {
  id: string;
  name: string;
  /** Plain statement of what the source is and how dependable it is. */
  description: string;
  licensed: boolean;
  /** True when the provider can push events instead of being polled. */
  push: boolean;
  /** Divisions this provider can report, for the coverage panel. */
  divisions: Division[];
}

export interface ProviderError {
  scope: string; // e.g. "NFL scoreboard", "FCS scoreboard"
  message: string;
  status: number | null;
}

export interface SlateResult {
  league: LeagueId;
  dateKey: string;
  games: GameSummary[];
  divisions: DivisionCoverage[];
  /** Conference names for the teams in these games, when the provider can name them. */
  conferences?: ConferenceInfo[];
  /** Partial failures: some divisions may succeed while others fail. */
  errors: ProviderError[];
  /** True when no scoreboard for this league could be read at all. */
  failed: boolean;
  receivedAt: number;
  discovery: string;
  limitations: string[];
}

export type DetailResult =
  | { ok: true; detail: GameDetail; receivedAt: number }
  | { ok: false; error: ProviderError; receivedAt: number };

/** A push provider's event, after the provider has normalized it. */
export interface ProviderPushEvent {
  gameId: GameId;
  kind: 'summary' | 'detail';
  summary?: GameSummary;
  detail?: GameDetail;
  receivedAt: number;
}

export interface SlateOptions {
  /** College divisions to include. Ignored for the NFL. */
  divisions: Division[];
}

export interface SportsProvider {
  readonly info: ProviderInfo;
  fetchSlate(league: LeagueId, dateKey: string, options: SlateOptions): Promise<SlateResult>;
  fetchDetail(gameId: GameId, knownDivisions?: Division[]): Promise<DetailResult>;
  /**
   * What the provider's data got wrong, counted since the process started.
   *
   * Normalizing already notices these: an event it cannot read, a play that
   * arrives twice, a ball spot whose label and yard line disagree. Until now it
   * counted them and nothing ever asked, so the numbers only existed inside the
   * provider. They belong on /api/health, where a run of them is the first sign
   * that the feed has changed shape under us.
   *
   * Counts, never a verdict, and never a reason to show a viewer something the
   * provider did not report.
   */
  dataQuality?(): Record<string, number>;
  /**
   * Optional push stream. A push provider still implements fetchSlate and
   * fetchDetail, which the engine uses to reconcile after reconnects.
   */
  subscribe?(onEvent: (event: ProviderPushEvent) => void): () => void;
}
