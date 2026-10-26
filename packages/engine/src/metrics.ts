import type { ArcadeEvent } from '@arcade/event-schema';

/**
 * Detection-quality evidence for the H1 hardware review (ROADMAP H1, ARCHITECTURE §9.7),
 * derived from event logs alone.
 */
export interface HealthMetrics {
  sessions: number;
  /** Darts in play: thrown or added, not voided. Manual-mode entries are left out (no board was used). */
  darts: number;
  /** Darts the board reported (`DartThrown`), including ones later voided. */
  detectedDarts: number;
  /**
   * Darts the board missed although they were on the board: automatic misses a person corrected
   * to a scoring segment, plus darts a person added by hand. Bounce-outs are excluded.
   */
  missedOnBoardDarts: number;
  /** missedOnBoardDarts ÷ darts; null with no darts. H1 threshold: > 5 % across ≥ 10 sessions. */
  missedOnBoardRate: number | null;
  /** Detected darts a person corrected (`DartCorrected{reason:'user'}`). */
  misreadDarts: number;
  /** misreadDarts ÷ detectedDarts; null with no detected darts. H1 threshold: > 5 %. */
  misreadRate: number | null;
  /** Kept apart: no hardware detects them. */
  bounceOuts: number;
  /** Detected darts a person voided as not being a dart. */
  falseDetections: number;
  needsReviewTurns: number;
  /** Times the board came back online after going offline. */
  reconnects: number;
  disconnects: number;
  /** Times the board entered the stuck-takeout state. */
  stuckTakeouts: number;
}

interface DartFacts {
  detected: boolean;
  reason: 'undetected' | 'bounce-out' | 'manual-mode' | null;
  byHand: boolean;
  padded: boolean;
  scoring: boolean;
  voided: string | null;
  userCorrected: boolean;
}

/** Works on one session's log or on several logs concatenated (each in seq order). */
export function healthMetrics(events: readonly ArcadeEvent[]): HealthMetrics {
  const darts = new Map<string, DartFacts>();
  const sessions = new Set<string>();
  const offline = new Map<string, boolean>();
  const stuck = new Map<string, boolean>();
  let needsReviewTurns = 0;
  let reconnects = 0;
  let disconnects = 0;
  let stuckTakeouts = 0;

  for (const e of events) {
    sessions.add(e.sessionId);
    switch (e.type) {
      case 'DartThrown':
        darts.set(`${e.sessionId}:${e.payload.throwId}`, {
          detected: true,
          reason: null,
          byHand: false,
          padded: false,
          scoring: e.payload.segment.bed !== 'miss',
          voided: null,
          userCorrected: false,
        });
        break;
      case 'DartAdded':
        darts.set(`${e.sessionId}:${e.payload.throwId}`, {
          detected: false,
          reason: e.payload.reason,
          byHand: e.source.kind === 'manual',
          padded: e.source.kind === 'engine' && e.payload.reason === 'undetected',
          scoring: e.payload.segment.bed !== 'miss',
          voided: null,
          userCorrected: false,
        });
        break;
      case 'DartCorrected': {
        const d = darts.get(`${e.sessionId}:${e.payload.throwId}`);
        if (!d) break;
        d.scoring = e.payload.segment.bed !== 'miss';
        if (e.payload.reason === 'user') d.userCorrected = true;
        break;
      }
      case 'DartVoided': {
        const d = darts.get(`${e.sessionId}:${e.payload.throwId}`);
        if (d) d.voided = e.payload.reason;
        break;
      }
      case 'TurnEnded':
        if (e.payload.needsReview) needsReviewTurns++;
        break;
      case 'SourceConnectionChanged':
        if (e.payload.state === 'offline' && !offline.get(e.sessionId)) {
          disconnects++;
          offline.set(e.sessionId, true);
        } else if (e.payload.state === 'online' && offline.get(e.sessionId)) {
          reconnects++;
          offline.set(e.sessionId, false);
        }
        break;
      case 'BoardStatusChanged': {
        const isStuck = e.payload.status === 'stuck-takeout';
        if (isStuck && !stuck.get(e.sessionId)) stuckTakeouts++;
        stuck.set(e.sessionId, isStuck);
        break;
      }
      default:
        break;
    }
  }

  let inPlay = 0;
  let detectedDarts = 0;
  let missed = 0;
  let misread = 0;
  let bounceOuts = 0;
  let falseDetections = 0;
  for (const d of darts.values()) {
    if (d.detected) {
      detectedDarts++;
      if (d.userCorrected) misread++;
      if (d.voided !== null && d.voided !== 'source-withdrawn') falseDetections++;
    }
    if (d.voided !== null || d.reason === 'manual-mode') continue;
    inPlay++;
    if (d.reason === 'bounce-out') bounceOuts++;
    else if ((d.padded && d.scoring) || (d.byHand && d.reason === 'undetected')) missed++;
  }

  return {
    sessions: sessions.size,
    darts: inPlay,
    detectedDarts,
    missedOnBoardDarts: missed,
    missedOnBoardRate: inPlay === 0 ? null : missed / inPlay,
    misreadDarts: misread,
    misreadRate: detectedDarts === 0 ? null : misread / detectedDarts,
    bounceOuts,
    falseDetections,
    needsReviewTurns,
    reconnects,
    disconnects,
    stuckTakeouts,
  };
}
