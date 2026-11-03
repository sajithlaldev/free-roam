// Shared tuning constants. Positions are in metres; world is centred on the origin.

/** Body voice: full volume inside refDistance, linearly silent at maxDistance. */
export const VOICE = { refDistance: 3, maxDistance: 25 };

/** PA speaker props reach much further so the whole plaza hears the announcer. */
export const SPEAKER_VOICE = { refDistance: 10, maxDistance: 70 };

export const WORLD_HALF_SIZE = 50;

export const MIC_POS: [number, number, number] = [0, 0, -6];
export const MIC_USE_RADIUS = 2.5;

export const SPEAKER_POSITIONS: [number, number, number][] = [
  [-12, 2.5, -12],
  [12, 2.5, -12],
  [-12, 2.5, 12],
  [12, 2.5, 12],
];

/** Position sync. */
export const POS_HZ = 15;
export const INTERP_DELAY_MS = 100;

/** PA liveness: announcer re-sends "on" so late joiners catch up; silence = off. */
export const PA_HEARTBEAT_MS = 1500;
export const PA_TIMEOUT_MS = 4500;

/** Data-channel topics. */
export const TOPIC_POS = 'pos';
export const TOPIC_PA = 'pa';
