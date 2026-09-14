/** The odds and win probability setting in Display, and its section in Data and sources. */
import type { OddsFormat } from '../../shared/odds';
import { usePrefs } from '../state/prefs';
import { Segmented, Switch } from './controls';

export const ODDS_FORMATS: Array<{ value: OddsFormat; label: string }> = [
  { value: 'american', label: 'American' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'percent', label: 'Chance' },
];

export const GAMBLING_NOTE = 'For information only, not betting advice. 21+. Gambling problem? Call 1-800-GAMBLER.';

export function OddsSettings() {
  const showOdds = usePrefs((s) => s.showOdds);
  const format = usePrefs((s) => s.oddsFormat);
  const set = usePrefs.getState().set;
  return (
    <section className="settings-section">
      <h3 className="settings-title">Odds and win probability</h3>
      <Switch label="Show odds and win probability" description="ESPN's win probability and matchup predictor, the sportsbook lines ESPN reports, and Kalshi prices" checked={showOdds} onChange={(v) => set({ showOdds: v })} />
      <Segmented<OddsFormat> label="Odds format" value={format} options={ODDS_FORMATS} onChange={(v) => set({ oddsFormat: v })} />
      <p className="form-hint">Chance writes odds and prices as the probability they imply. {GAMBLING_NOTE}</p>
    </section>
  );
}

export function OddsHelp() {
  return (
    <section>
      <h3>Odds and win probability</h3>
      <ul>
        <li>Win probability is ESPN's model, reported after each play. Before kickoff, Gridiron shows ESPN's matchup predictor instead. Both are shown as reported; Gridiron never calculates a chance of its own.</li>
        <li>Spread, moneyline and total come from the sportsbook ESPN names beside them. Before kickoff they are the current lines; during a game, the latest lines ESPN reported; after it, the closing lines.</li>
        <li>Kalshi prices come from Kalshi's public market data. The Gridiron server reads them about every 15 seconds while a game is live and shares them with every viewer. A price of 55% means the contract trades around 55 cents: the middle of the best bid and ask when they are close, otherwise the last trade.</li>
        <li>Everything here follows the spoiler delay. Replays include the captured closing lines and win probability, but no Kalshi prices.</li>
        <li>{GAMBLING_NOTE}</li>
      </ul>
    </section>
  );
}
