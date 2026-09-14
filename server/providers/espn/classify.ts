/**
 * ESPN play classification.
 *
 * Classification uses only the provider's explicit play type text (and id as a
 * cross-check). A play is never called a touchdown because a score went up; a
 * type Gridiron does not recognise stays `other`. The table below was built
 * from the play types observed across 51 real NFL, FBS, FCS and Division II
 * summaries on 2026-09-13, plus closely related variants of the same wording.
 */
import type { Conversion, PlayKind } from '../../../shared/model.js';

const RULES: ReadonlyArray<readonly [RegExp, PlayKind]> = [
  [/^passing touchdown$/i, 'touchdown_pass'],
  [/^rushing touchdown$/i, 'touchdown_rush'],
  [/return touchdown$/i, 'touchdown_return'], // interception, fumble, punt, kickoff, missed field goal returns
  [/^blocked (punt|field goal) touchdown$/i, 'touchdown_return'],
  [/^field goal good$/i, 'field_goal_good'],
  [/^field goal missed$|^missed field goal return$/i, 'field_goal_missed'],
  [/^blocked field goal$/i, 'field_goal_blocked'],
  [/two.?point|2\s?pt\b|2-pt\b/i, 'two_point'],
  [/^extra point|^pat\b/i, 'extra_point'],
  [/^safety$/i, 'safety'],
  [/^sack opp fumble recovery$/i, 'fumble_lost'],
  [/^sack$/i, 'sack'],
  [/^(pass )?interception( return)?$/i, 'interception'],
  [/^fumble recovery \(opponent\)$|^muffed (punt|kick|kickoff) recovery \(opponent\)$/i, 'fumble_lost'],
  [/^fumble recovery \(own\)$|^muffed (punt|kick|kickoff) recovery \(own\)$/i, 'fumble_recovered_own'],
  [/^fumble$/i, 'fumble'],
  [/^blocked punt$/i, 'punt_blocked'],
  [/^punt return$/i, 'punt_return'],
  [/^punt$/i, 'punt'],
  [/^kickoff return/i, 'kickoff_return'],
  [/^kickoff$/i, 'kickoff'],
  [/^pass reception$|^pass completion$/i, 'pass_complete'],
  [/^pass incompletion$/i, 'pass_incomplete'],
  [/^rush$/i, 'rush'],
  [/^penalty$/i, 'penalty'],
  [/two.?minute warning/i, 'two_minute_warning'],
  [/timeout/i, 'timeout'],
  [/^end period$|^end of (1st|2nd|3rd|4th) quarter$/i, 'end_period'],
  [/^end of half$/i, 'end_half'],
  [/^end of regulation$/i, 'end_regulation'],
  [/^end of game$/i, 'end_game'],
  [/coin toss/i, 'coin_toss'],
];

export function classifyPlayType(typeText: string | null): PlayKind {
  if (!typeText) return 'other';
  const t = typeText.trim();
  for (const [re, kind] of RULES) if (re.test(t)) return kind;
  return 'other';
}

const kickResult = (word: string): Conversion['result'] => {
  const w = word.toLowerCase();
  if (w === 'good' || w === 'succeeds') return 'good';
  if (w === 'blocked') return 'blocked';
  if (w === 'no good' || w === 'failed' || w === 'fails' || w === 'aborted' || w === 'missed') return 'failed';
  return 'unknown';
};

/**
 * The try after a touchdown, when the play text states it explicitly.
 * NFL: "E.Pineiro extra point is GOOD" / "TWO-POINT CONVERSION ATTEMPT. ... ATTEMPT SUCCEEDS."
 * College: "#91 P.Woodring kick attempt good".
 */
export function parseConversion(text: string | null): Conversion | null {
  if (!text) return null;
  let m = /two-point conversion attempt[\s\S]{0,200}?attempt (succeeds|fails)/i.exec(text);
  if (m) return { kind: 'two-point', result: kickResult(m[1]) };
  m = /\b(?:two-point|2-pt|2pt)\b[^.]{0,120}?\b(good|failed|no good|succeeds|fails)\b/i.exec(text);
  if (m) return { kind: 'two-point', result: kickResult(m[1]) };
  m = /extra point is (good|no good|blocked|aborted)/i.exec(text);
  if (m) return { kind: 'kick', result: kickResult(m[1]) };
  m = /\bkick attempt (good|no good|failed|blocked|missed)/i.exec(text);
  if (m) return { kind: 'kick', result: kickResult(m[1]) };
  return null;
}

/** A replay review or challenge, only when the text states its outcome. */
export function parseReview(text: string | null): { outcome: 'upheld' | 'reversed' | 'stands' | 'unknown' } | null {
  if (!text) return null;
  const m = /(?:replay official reviewed|challenged)[\s\S]{0,200}?the play was (upheld|reversed|overturned)/i.exec(text);
  if (m) return { outcome: m[1].toLowerCase() === 'upheld' ? 'upheld' : 'reversed' };
  if (/ruling (?:on the field )?stands/i.test(text)) return { outcome: 'stands' };
  if (/replay official reviewed|challenged the/i.test(text)) return { outcome: 'unknown' };
  return null;
}
