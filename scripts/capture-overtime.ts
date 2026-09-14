/**
 * Captures two real overtime games from the 2025 season for the overtime replays:
 * an NFL game decided in overtime and a college game that went to double
 * overtime (where a two-point attempt is mandatory).
 *
 *   npx tsx scripts/capture-overtime.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimScoreboard, trimSummary } from './capture-fixtures';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'espn');
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football';

const GAMES = [
  { league: 'nfl', prefix: 'nfl', id: '401772834', date: '20250914', group: null, note: 'New York Giants at Dallas Cowboys, Final/OT' },
  { league: 'college-football', prefix: 'cfb', id: '401754525', date: '20250906', group: '80', note: 'Baylor at SMU, Final/2OT' },
] as const;

const save = (rel: string, data: unknown) => {
  const file = join(ROOT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
};

for (const g of GAMES) {
  const sbUrl = `${SITE}/${g.league}/scoreboard?dates=${g.date}&limit=500${g.group ? `&groups=${g.group}` : ''}`;
  const sb = (await (await fetch(sbUrl)).json()) as { events?: Array<{ id: string }> };
  const event = (sb.events ?? []).filter((e) => e.id === g.id);
  if (!event.length) throw new Error(`${g.id} not found on ${sbUrl}`);
  save(`scoreboard/event-${g.prefix}-${g.id}.json`, trimScoreboard({ ...sb, events: event }));
  const summary = await (await fetch(`${SITE}/${g.league}/summary?event=${g.id}`)).json();
  save(`summary/${g.prefix}-${g.id}.json`, trimSummary(summary));
  console.log(`captured ${g.prefix}-${g.id}: ${g.note}`);
}
