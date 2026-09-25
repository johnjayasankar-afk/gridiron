/**
 * What the field is doing, for the verification suite, alongside the renderer's
 * own `__gridironGraphics`.
 *
 * Most of the 3D field can be checked by looking at a still. The parts that
 * cannot are how the ball turns, how much of a play's path has been drawn, what
 * the camera is doing, which drive is on the field, and what the stands are
 * answering. Each layer writes its own part of this as it draws, and the whole
 * is read through a getter, so reading it costs a frame nothing and nothing is
 * allocated per frame to make it available.
 *
 * It is installed only by the game page's field. A card never installs it, so
 * there is never a question of which field is being reported.
 */
export interface FieldProbe {
  x: number;
  y: number;
  /** Turn about the ball's long axis: a spiral. */
  spin: number;
  /** Nose angle, or the turn of a ball going end over end. */
  pitch: number;
  yaw: number;
  inFlight: boolean;
  tumbling: boolean;
  path: string | null;
  kind: string | null;
  /** How much of the play's path has been drawn, 0 to 1. */
  trail: number;
  spotVisible: boolean;
  /** The gate between the uprights, lit only for a kick the provider called good. */
  gateVisible: boolean;
  /** Where the ball is across the view, -1 at the left edge to 1 at the right. */
  ndcX: number;
  /** And up the view, -1 at the bottom to 1 at the top. */
  ndcY: number;
  /** Which side the provider says has the ball, or null when it did not say. */
  possession: 'home' | 'away' | null;
  /** The colour every mark on the field is currently carrying. */
  mark: string;
  /** The team whose mark the ball is wearing, or null for plain leather. */
  skin: string | null;
  /** Where the camera is along the field, which is what the broadcast pan moves. */
  camX: number;
  /**
   * The drive the field is drawing, as the field understands it. `rows` is every
   * play in the drive and `playCount` is the provider's count of offensive ones,
   * which is smaller: a kickoff is drawn and is not an offensive play.
   */
  drive: { start: number | null; ball: number | null; ticks: number; rows: number; playCount: number; unspotted: number } | null;
  /**
   * The sky the field is drawn under, from the weather the provider reports at
   * the venue. `drops` is how many are falling, which is zero for every game the
   * provider did not report rain or snow for, and that is most of them.
   */
  sky: { kind: string; night: boolean; indoor: boolean; drops: number } | null;
  /** How much of the far end of the field the air has taken, 0 when the sky is clear or unreported. */
  haze: number;
  /** The team whose mark is painted at the fifty, which is the home team's. */
  midfield: string | null;
  /** How loudly the stands are answering, 0 when they are not, and what they are answering. */
  cheer: number;
  cheerFor: 'score' | 'turnover' | null;
}

export const fieldProbe: FieldProbe = {
  x: 0,
  y: 0,
  spin: 0,
  pitch: 0,
  yaw: 0,
  inFlight: false,
  tumbling: false,
  path: null,
  kind: null,
  trail: 1,
  spotVisible: false,
  gateVisible: false,
  ndcX: 0,
  ndcY: 0,
  possession: null,
  mark: '',
  skin: null,
  camX: 0,
  midfield: null,
  drive: null,
  sky: null,
  haze: 0,
  cheer: 0,
  cheerFor: null,
};

declare global {
  interface Window {
    __gridironField?: () => FieldProbe;
  }
}

/** Installs the getter while a game page's field is mounted. */
export function installFieldProbe(): () => void {
  window.__gridironField = () => fieldProbe;
  return () => {
    delete window.__gridironField;
  };
}
