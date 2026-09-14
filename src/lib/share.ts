/** Copying and sharing: plain-text game summaries and validated share links. */
import { downDistance, scoreText, spotLabel, statusShort, teamFor } from '../../shared/format';
import type { GameSummary, Situation } from '../../shared/model';
import { isLiveOrPaused } from '../../shared/model';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** "BUF 24, MIA 17 · Q3 7:42 · BUF ball, 3rd & 7 at MIA 35". Unknown parts are left out. */
export function gameSummaryText(game: GameSummary, situation: Situation | null): string {
  const parts = [scoreText(game), statusShort(game.status)];
  if (situation && isLiveOrPaused(game.status.kind)) {
    const team = teamFor(game, situation.possession);
    const dd = downDistance(situation);
    const spot = situation.spot.schematicYard === null ? null : spotLabel(situation.spot, game);
    const line = [team ? `${team.abbreviation} ball` : null, dd && spot ? `${dd} at ${spot}` : (dd ?? spot)].filter(Boolean).join(', ');
    if (line) parts.push(line);
  }
  return `${parts.join(' · ')} (Gridiron, ESPN data)`;
}

export async function shareLink(url: string, title: string): Promise<'shared' | 'copied' | 'failed'> {
  if (typeof navigator.share === 'function' && window.matchMedia?.('(pointer: coarse)').matches) {
    try {
      await navigator.share({ url, title });
      return 'shared';
    } catch {
      /* fall back to copying */
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed';
}
