// Shared tuning constants. Positions are in metres; world is centred on the origin.

/** Body voice: full volume inside refDistance, linearly silent at maxDistance. */
export const VOICE = { refDistance: 3, maxDistance: 25 };

/** PA speakers: each one is audible out to maxDistance, so wherever you are a few are in range. */
export const SPEAKER_VOICE = { refDistance: 6, maxDistance: 45 };

export const WORLD_HALF_SIZE = 50;
export const SPAWN: [number, number, number] = [0, 0, 8];

export const MIC_POS: [number, number, number] = [0, 0, -6];
export const MIC_USE_RADIUS = 2.5;

// [x, z, width, height, depth, colour] — deterministic so every client sees the same world.
export const OBSTACLES: [number, number, number, number, number, number][] = [
  [-30, -20, 4, 3, 4, 0x6c7a89],
  [28, -25, 6, 2, 3, 0x8e6c5a],
  [-25, 25, 3, 4, 3, 0x5a8e7a],
  [30, 30, 5, 3, 5, 0x7a5a8e],
  [0, 36, 10, 2, 2, 0x8e8a5a],
  [-38, 0, 2, 5, 8, 0x5a6c8e],
  // little staircase to exercise step-climbing
  [16, -4, 2, 0.25, 3, 0x9a9a9a],
  [18, -4, 2, 0.5, 3, 0x9a9a9a],
  [20, -4, 2, 0.75, 3, 0x9a9a9a],
];

/**
 * PA speakers are scattered "randomly" across the world, but from a fixed seed so every
 * client computes the identical layout (otherwise people would hear the PA from different
 * places). Change SPEAKER_SEED for a new layout, SPEAKER_COUNT for more/fewer speakers.
 */
export const SPEAKER_COUNT = 8;
export const SPEAKER_SEED = 1337;
export const SPEAKER_HEIGHT = 2.5;
export interface SpeakerSpot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Best-candidate sampling: for each speaker try a handful of random spots and keep the
// one furthest from the speakers placed so far. Looks random, but avoids clumps and gaps.
function placeSpeakers(): SpeakerSpot[] {
  const rnd = mulberry32(SPEAKER_SEED);
  const range = WORLD_HALF_SIZE - 3; // keep clear of the boundary walls
  const out: SpeakerSpot[] = [];
  const free = (x: number, z: number) =>
    Math.hypot(x - MIC_POS[0], z - MIC_POS[2]) > 6 &&
    Math.hypot(x - SPAWN[0], z - SPAWN[2]) > 3 &&
    OBSTACLES.every(([ox, oz, w, , d]) => Math.abs(x - ox) > w / 2 + 1.5 || Math.abs(z - oz) > d / 2 + 1.5);
  const gap = (x: number, z: number) => Math.min(Infinity, ...out.map((s) => Math.hypot(s.x - x, s.z - z)));
  while (out.length < SPEAKER_COUNT) {
    let best: [number, number] | null = null;
    let bestGap = -1;
    for (let k = 0; k < 30; k++) {
      const x = (rnd() * 2 - 1) * range;
      const z = (rnd() * 2 - 1) * range;
      const g = gap(x, z);
      if (free(x, z) && g > bestGap) [best, bestGap] = [[x, z], g];
    }
    if (best) out.push({ x: best[0], y: SPEAKER_HEIGHT, z: best[1], yaw: rnd() * Math.PI * 2 });
  }
  return out;
}

export const SPEAKERS: SpeakerSpot[] = placeSpeakers();

/** Position sync. */
export const POS_HZ = 15;
export const INTERP_DELAY_MS = 100;

/** PA liveness: the person on the mic re-sends "on" so late joiners catch up; silence = off. */
export const PA_HEARTBEAT_MS = 1500;
export const PA_TIMEOUT_MS = 4500;

/** Data-channel topics. */
export const TOPIC_POS = 'pos';
export const TOPIC_PA = 'pa';
