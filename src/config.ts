// Shared tuning constants. World layout (landmarks, PA mics, seats) lives in src/world/.

/** Body voice: full volume inside refDistance, linearly silent at maxDistance. */
export const VOICE = { refDistance: 3, maxDistance: 25 };

/** Voices crossing a wall (different rooms) are muffled to this gain + low-pass cutoff. */
export const OCCLUSION = { gain: 0.28, lowpassHz: 650 };

/**
 * Character model (public/models/avatar.glb). Any rigged glTF works: it's scaled to
 * `height` with its feet on the ground, so the file's own units don't matter. Humanoid
 * rigs (Mixamo / Ready Player Me bone names) are turned to face +Z automatically.
 * - yawOffset: extra radians of rotation if it still faces the wrong way (try Math.PI).
 * - clips: regexes matched against the file's animation names. If the file has no
 *   idle/walk clips, humanoid rigs get procedural animation instead (src/procedural.ts).
 * - tintMaterial: material recoloured per player so people are told apart (null = off).
 * - credit: shown on the join screen (the bundled model is CC-BY-4.0, which requires it).
 */
export const AVATAR = {
  url: `${import.meta.env.BASE_URL}models/avatar.glb`,
  height: 1.7,
  yawOffset: 0,
  clips: { idle: /idle/i, walk: /walk(?!jump)/i, run: /run/i },
  tintMaterial: 'outfit_top' as string | null,
  /** Horizontal speeds (m/s) where clip-based animation switches to walk, then run. */
  walkAbove: 0.6,
  runAbove: 3.5,
  credit:
    'Character: “Mammotty 3d Model” by Peter Charles (sketchfab.com/dk3510329), CC BY 4.0 — compressed for the web',
};

/** Network rates. */
export const POS_HZ = 15;
export const CAR_HZ = 20;
export const INTERP_DELAY_MS = 100;

/** PA liveness: the person on the mic re-sends "on" so late joiners catch up; silence = off. */
export const PA_HEARTBEAT_MS = 1500;
export const PA_TIMEOUT_MS = 4500;
/** A parked car's last driver re-broadcasts its pose this often (late joiners). */
export const CAR_PARKED_HEARTBEAT_MS = 4000;

/** Data-channel topics. */
export const TOPIC_POS = 'pos';
export const TOPIC_PA = 'pa';
export const TOPIC_CAR = 'car';
export const TOPIC_CAR_SEAT = 'carseat';
export const TOPIC_RACE = 'race';

/**
 * Token server for multiplayer. Same origin by default (`npm run dev` / `npm start`); a static
 * build (GitHub Pages) can point at a token server hosted elsewhere with VITE_TOKEN_URL.
 */
export const TOKEN_URL: string = import.meta.env.VITE_TOKEN_URL || `${import.meta.env.BASE_URL}api/token`;
/** A static build with no token server configured: multiplayer isn't available. */
export const MULTIPLAYER_AVAILABLE = !(import.meta.env.VITE_STATIC === '1' && !import.meta.env.VITE_TOKEN_URL);
