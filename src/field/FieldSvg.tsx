/**
 * The 2D field: the accessible, low-power fallback for WebGL. It draws the same
 * rulebook markings and the same reported spot as the 3D field, top-down.
 */
import { memo, useId } from 'react';
import type { DrivePlayTone, DriveTrack } from '../../shared/driveTrack';
import { attackDirection, firstDownTarget, lateralZ, schematicYardFromProgress } from '../../shared/field';
import { SKY_STRENGTH, multiplyHex, skyFor, skyLabel, skyLook, skyTint } from '../../shared/sky';
import { markingsFor, NUMBERED_LINES } from '../../shared/fieldMarkings';
import type { GameSummary, Situation } from '../../shared/model';
import { accessibleSummary, SPOT_UNAVAILABLE } from '../../shared/format';
import { accentFor, mixColor } from './color';

const S = 10; // pixels per yard
const PAD = 2.2; // border band in yards
const W = (120 + PAD * 2) * S;
const H = (160 / 3 + PAD * 2) * S;
const X = (schematicYard: number) => (PAD + 10 + schematicYard) * S; // schematic yard 0 = away goal line
const Z = (zYards: number) => (PAD + 160 / 6 + zYards) * S; // z = 0 is the centre line

export interface FieldSvgProps {
  game: GameSummary;
  situation: Situation | null;
  compact?: boolean;
  /** Schematic yard the ball came from on the most recent reported play. */
  fromYard?: number | null;
  historical?: boolean;
  /** The drive to draw behind the ball, as the 3D field draws it. The game page only. */
  drive?: DriveTrack | null;
  /** Draw the unavailable-spot message inside the SVG (standalone use). Cards draw it as DOM instead. */
  showMessage?: boolean;
  className?: string;
}

export const FieldSvg = memo(function FieldSvg({ game, situation, compact = false, fromYard = null, historical = false, drive = null, showMessage = false, className = '' }: FieldSvgProps) {
  const id = useId().replace(/:/g, '');
  const m = markingsFor(game.league);
  const spot = situation?.spot ?? null;
  const known = spot !== null && spot.schematicYard !== null;
  const offense = situation?.possession ?? spot?.offense ?? null;
  const ballX = known ? X(spot!.schematicYard!) : null;
  // Across the field: the centre line unless the data carries a lateral position.
  const ballZ = Z(known ? lateralZ(spot!.lateral) : 0);
  const target = known && offense && spot!.progress !== null ? firstDownTarget(spot!.progress, situation?.distance ?? null, situation?.goalToGo === true) : null;
  const targetX = target && offense ? X(schematicYardFromProgress(target.progress, offense)) : null;
  const dir = offense ? attackDirection(offense) : 1;
  // The arrow says which way the offense is going, so it says who they are too,
  // the same as the 3D field does. With no reported possession there is no arrow.
  const held = offense ? accentFor(game[offense].color, true) : null;

  /*
   * The drive, the same three readings the 3D field draws and from the same
   * tested source: the ground between where it began and where the ball is, as a
   * ramp that is faintest at the start; the play it began at, dashed so it can
   * never be taken for the line of scrimmage or the line to gain; and one mark
   * per play the provider gave an end spot for, along the near sideline.
   */
  const driveTeam = drive?.offense ? accentFor(game[drive.offense].color, true) : null;
  const band = drive && drive.start !== null && drive.ball !== null && Math.abs(drive.ball - drive.start) >= 0.8 ? { from: X(drive.start), to: X(drive.ball) } : null;
  const driveTicks = drive?.plays.filter((play) => play.to !== null) ?? [];
  const toneFill = (tone: DrivePlayTone, team: string) =>
    tone === 'loss' || tone === 'conceded' || tone === 'turnover' || tone === 'penalty' ? '#f4aa5c' : tone === 'score' ? '#a7f3d0' : team;
  const redZone = known && offense && spot!.progress !== null && spot!.progress >= 80;
  /*
   * The same sky the 3D field is lit by, multiplied through the same arithmetic
   * in shared/sky, so the fallback is this field drawn another way rather than a
   * second opinion about what an overcast afternoon looks like. And the same
   * rule about mowing: stripes are a grass field's, because a mower laying the
   * blades one way and then the other is what makes them.
   */
  const sky = skyFor(game.weather, game.venue?.indoor);
  const wash = skyTint(skyLook(sky), SKY_STRENGTH.classic);
  const mown = game.venue?.grass !== false;
  const turfA = multiplyHex('#1d5a3c', wash);
  const turfB = multiplyHex(mown ? '#21633f' : '#1d5a3c', wash);
  const surround = multiplyHex('#163a28', wash);
  const awayZone = multiplyHex(mixColor(game.away.color ?? '#1c3326', '#13241b', 0.55), wash);
  const homeZone = multiplyHex(mixColor(game.home.color ?? '#1c3326', '#13241b', 0.55), wash);
  const line = 'rgba(244, 248, 243, 0.92)';
  const numbersFill = 'rgba(244, 248, 243, 0.78)';

  const yardLines = [];
  for (let y = 0; y <= 100; y += 5) {
    const goal = y === 0 || y === 100;
    yardLines.push(<line key={`yl${y}`} x1={X(y)} x2={X(y)} y1={Z(-m.halfWidth)} y2={Z(m.halfWidth)} stroke={line} strokeWidth={goal ? Math.max(2.2, m.goalLineWidth * S * 5) : 1.4} />);
  }
  const hashes = [];
  if (!compact) {
    for (let y = 1; y < 100; y++) {
      if (y % 5 === 0) continue;
      for (const sign of [-1, 1]) {
        hashes.push(<line key={`h${y}${sign}`} x1={X(y)} x2={X(y)} y1={Z(sign * m.hashInner)} y2={Z(sign * (m.hashInner + m.hashLength))} stroke={line} strokeWidth={1} opacity={0.85} />);
        hashes.push(<line key={`s${y}${sign}`} x1={X(y)} x2={X(y)} y1={Z(sign * (m.halfWidth - m.sidelineMarkInset))} y2={Z(sign * (m.halfWidth - m.sidelineMarkInset - m.sidelineMarkLength))} stroke={line} strokeWidth={1} opacity={0.85} />);
      }
    }
  }

  return (
    <svg
      className={`field-svg ${className}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-labelledby={`${id}-t ${id}-d`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={`${id}-t`}>{`${game.away.abbreviation} at ${game.home.abbreviation} field (schematic, top-down)`}</title>
      <desc id={`${id}-d`}>{`${accessibleSummary(game, situation)} Schematic orientation: ${game.away.abbreviation} defends the left end zone.${sky ? ` Reported at the venue: ${skyLabel(sky)}.` : ''}`}</desc>
      <defs>
        <pattern id={`${id}-stripes`} width={10 * S} height={H} patternUnits="userSpaceOnUse" x={X(0)}>
          <rect width={5 * S} height={H} fill={turfA} />
          <rect x={5 * S} width={5 * S} height={H} fill={turfB} />
        </pattern>
        <radialGradient id={`${id}-halo`}>
          <stop offset="0" stopColor="#6ee7b7" stopOpacity="0.55" />
          <stop offset="1" stopColor="#6ee7b7" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x={0} y={0} width={W} height={H} rx={18} fill={surround} />
      {m.border.extent === 'full' ? (
        <rect x={PAD * S * 0.15} y={PAD * S * 0.15} width={W - PAD * S * 0.3} height={H - PAD * S * 0.3} rx={14} fill="none" stroke="rgba(244,248,243,0.28)" strokeWidth={PAD * S * 0.7} />
      ) : (
        <>
          <rect x={X(10)} y={Z(-m.halfWidth) - PAD * S * 0.8} width={X(90) - X(10)} height={PAD * S * 0.55} fill="rgba(244,248,243,0.26)" />
          <rect x={X(10)} y={Z(m.halfWidth) + PAD * S * 0.25} width={X(90) - X(10)} height={PAD * S * 0.55} fill="rgba(244,248,243,0.26)" />
        </>
      )}
      <rect x={X(0)} y={Z(-m.halfWidth)} width={100 * S} height={m.width * S} fill={`url(#${id}-stripes)`} />
      <rect x={X(-10)} y={Z(-m.halfWidth)} width={10 * S} height={m.width * S} fill={awayZone} />
      <rect x={X(100)} y={Z(-m.halfWidth)} width={10 * S} height={m.width * S} fill={homeZone} />
      <text x={X(-5)} y={Z(0)} className="field-svg-endzone" transform={`rotate(-90 ${X(-5)} ${Z(0)})`} textAnchor="middle" dominantBaseline="central">
        {game.away.abbreviation}
      </text>
      <text x={X(105)} y={Z(0)} className="field-svg-endzone" transform={`rotate(90 ${X(105)} ${Z(0)})`} textAnchor="middle" dominantBaseline="central">
        {game.home.abbreviation}
      </text>
      <rect x={X(-10)} y={Z(-m.halfWidth)} width={120 * S} height={m.width * S} fill="none" stroke={line} strokeWidth={2} />
      {redZone && offense && (
        <rect
          x={dir === 1 ? X(80) : X(0)}
          y={Z(-m.halfWidth)}
          width={20 * S}
          height={m.width * S}
          fill="rgba(244,170,92,0.2)"
          className="field-svg-redzone"
        />
      )}
      {band && driveTeam && (
        <>
          <defs>
            <linearGradient id={`${id}-drive`} x1={band.from} y1={0} x2={band.to} y2={0} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor={driveTeam} stopOpacity={0.02} />
              <stop offset="0.7" stopColor={driveTeam} stopOpacity={0.12} />
              <stop offset="1" stopColor={driveTeam} stopOpacity={0.22} />
            </linearGradient>
          </defs>
          <rect
            x={Math.min(band.from, band.to)}
            y={Z(-m.halfWidth)}
            width={Math.abs(band.to - band.from)}
            height={m.width * S}
            fill={`url(#${id}-drive)`}
            className="field-svg-drive"
          />
        </>
      )}
      {yardLines}
      {hashes}
      {m.tryMark &&
        [m.tryMark.fromGoal, 100 - m.tryMark.fromGoal].map((y) => (
          <line key={`try${y}`} x1={X(y)} x2={X(y)} y1={Z(-m.tryMark!.length / 2)} y2={Z(m.tryMark!.length / 2)} stroke={line} strokeWidth={1.6} />
        ))}
      {!compact &&
        NUMBERED_LINES.map(({ yard, label }) => (
          <g key={`n${yard}`} className="field-svg-numbers" fill={numbersFill}>
            <text x={X(yard)} y={Z(m.halfWidth - m.numberNear)} textAnchor="middle" dominantBaseline="text-after-edge" fontSize={m.numberHeight * S}>
              {label}
            </text>
            <text
              x={X(yard)}
              y={Z(-(m.halfWidth - m.numberNear))}
              textAnchor="middle"
              dominantBaseline="text-after-edge"
              fontSize={m.numberHeight * S}
              transform={`rotate(180 ${X(yard)} ${Z(-(m.halfWidth - m.numberNear))})`}
            >
              {label}
            </text>
          </g>
        ))}
      {band && driveTeam && (
        <line x1={band.from} x2={band.from} y1={Z(-m.halfWidth)} y2={Z(m.halfWidth)} stroke={driveTeam} strokeWidth={3} strokeDasharray="14 10" opacity={0.6} className="field-svg-drive-start" />
      )}
      {driveTeam &&
        driveTicks.map((play) => (
          <rect key={`dt${play.id}`} x={X(play.to!) - 4} y={Z(m.halfWidth - 8)} width={8} height={4.5 * S} rx={2} fill={toneFill(play.tone, driveTeam)} opacity={0.9} className="field-svg-drive-tick" />
        ))}
      {targetX !== null && target?.kind === 'line' && <rect x={targetX - 2.2} y={Z(-m.halfWidth)} width={4.4} height={m.width * S} fill="#f4aa5c" opacity={0.95} />}
      {target?.kind === 'goal' && offense && <rect x={(dir === 1 ? X(100) : X(0)) - 3} y={Z(-m.halfWidth)} width={6} height={m.width * S} fill="#f4aa5c" opacity={0.85} />}
      {ballX !== null && <rect x={ballX - 2.2} y={Z(-m.halfWidth)} width={4.4} height={m.width * S} fill="#8abef0" opacity={0.95} />}
      {known && fromYard !== null && Math.abs(X(fromYard) - ballX!) > 4 && (
        <line x1={X(fromYard)} x2={ballX!} y1={ballZ} y2={ballZ} stroke="#a7f3d0" strokeWidth={5} strokeLinecap="round" opacity={0.5} strokeDasharray="10 8" />
      )}
      {ballX !== null && (
        <g className="field-svg-ball">
          <circle cx={ballX} cy={ballZ} r={34} fill={`url(#${id}-halo)`} />
          <ellipse cx={ballX} cy={ballZ} rx={17} ry={10} fill="#7a4a2b" stroke="#f0f7f3" strokeWidth={2.4} />
          <line x1={ballX - 7} x2={ballX + 7} y1={ballZ} y2={ballZ} stroke="#f0f7f3" strokeWidth={2} />
          {offense && (
            <path
              d={`M ${ballX + dir * 30} ${ballZ - 11} L ${ballX + dir * 48} ${ballZ} L ${ballX + dir * 30} ${ballZ + 11} Z`}
              fill={held ?? '#a7f3d0'}
              opacity={0.95}
            />
          )}
        </g>
      )}
      {!known && showMessage && (
        <g className="field-svg-unknown">
          <rect x={W / 2 - 150} y={H / 2 - 26} width={300} height={52} rx={26} fill="rgba(10,20,15,0.72)" />
          <text x={W / 2} y={H / 2} textAnchor="middle" dominantBaseline="central" fill="#f0f7f3" fontSize={22}>
            {game.coverage.level === 'score-only' ? 'Score-only coverage' : SPOT_UNAVAILABLE}
          </text>
        </g>
      )}
      {historical && (
        <text x={X(-9)} y={Z(-m.halfWidth) + 26} fill="#f4aa5c" fontSize={20}>
          Historical view
        </text>
      )}
    </svg>
  );
});
