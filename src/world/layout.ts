// The map: a compressed tour of Kerala. Metres; +X east, +Z south (so -Z is north).
// Everything here is data, shared by terrain, buildings, audio and networking, and it is
// deterministic so every client builds the identical world.

export type V2 = [number, number];

export const WORLD_HALF = 240;
export const WATER_Y = 0;

/** West coast (Arabian Sea): land is east of this line. */
export const coastX = (z: number) => -158 + 7 * Math.sin(z / 45) + 3 * Math.sin(z / 13 + 1);

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
export const rect = (cx: number, cz: number, w: number, d: number): Rect => ({
  x0: cx - w / 2,
  z0: cz - d / 2,
  x1: cx + w / 2,
  z1: cz + d / 2,
});
export const inRect = (r: Rect, x: number, z: number, pad = 0) =>
  x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad;

// ── Landmarks ─────────────────────────────────────────────────────────────────

/** Kovalam: rocky headland with the red-and-white lighthouse. */
export const HEADLAND = { x: -166, z: 205, r: 22, h: 10 };
export const LIGHTHOUSE = { x: -168, z: 207 };

/** Fort Kochi: Chinese fishing nets along the north-west shore (positions on the shore line). */
export const FISHING_NET_Z = [-178, -160, -142, -124];

/** Alappuzha backwaters: a lake plus canals (polylines with a width). */
export const LAKE = { x: 40, z: 150, rx: 52, rz: 30 };
export interface Canal {
  pts: V2[];
  width: number;
}
export const CANALS: Canal[] = [
  { pts: [[-10, 152], [-50, 160], [-90, 150], [-128, 158], [-150, 162], [-195, 165]], width: 15 },
  { pts: [[88, 146], [125, 128], [165, 135], [200, 122], [250, 125]], width: 13 },
  { pts: [[32, 176], [20, 212], [26, 250]], width: 11 },
];
export const HOUSEBOATS: { x: number; z: number; yaw: number }[] = [
  { x: 13.6, z: 140, yaw: 0 }, // docked at the jetty (walkable)
  { x: 62, z: 160, yaw: -0.5 },
  { x: -70, z: 155, yaw: Math.PI / 2 + 0.2 },
];
export const JETTY = rect(8, 126, 6, 22);

/** Paddy fields: flat, just above the water. */
export const PADDY_Y = 0.7;
export const PADDY: Rect[] = [
  { x0: -115, z0: 174, x1: -28, z1: 232 },
  { x0: 62, z0: 168, x1: 160, z1: 232 },
  { x0: -112, z0: 98, x1: -32, z1: 138 },
];

/** Munnar: tea-covered hills in the north-east, with a viewpoint on the summit. */
export const hillMask = (x: number, z: number) => {
  const a = Math.min(1, Math.max(0, (x - 70) / 80));
  const b = Math.min(1, Math.max(0, (90 - z) / 80));
  const s = (t: number) => t * t * (3 - 2 * t);
  return s(a) * s(b);
};
export const SUMMIT = { x: 192, z: -142, h: 52 };

/** Town centre. */
export const MAIDAN = rect(0, -35, 60, 40);
export const SPAWN: [number, number, number] = [0, 0, -12];

export const TEMPLE = { x: -90, z: -75, size: 46 };
export const TEMPLE_POND = rect(-55, -115, 24, 20);
export const TEMPLE_GATE = { x: TEMPLE.x + TEMPLE.size / 2, z: TEMPLE.z };

/** Building footprints. `door` is the wall the doorway is in. */
export type Side = 'n' | 's' | 'e' | 'w';
export interface BuildingDef {
  id: string;
  kind: 'hall' | 'house' | 'teashop' | 'modern';
  x: number;
  z: number;
  w: number; // along X
  d: number; // along Z
  door: Side;
  wall: number; // wall colour
}
export const BUILDINGS: BuildingDef[] = [
  { id: 'hall', kind: 'hall', x: 58, z: -35, w: 18, d: 13, door: 'w', wall: 0xf1ead8 },
  { id: 'house1', kind: 'house', x: -62, z: 20, w: 11, d: 9, door: 'n', wall: 0xf4efe2 },
  { id: 'house2', kind: 'house', x: 78, z: 22, w: 10, d: 8, door: 'n', wall: 0xe9d9b8 },
  { id: 'house3', kind: 'house', x: -28, z: -98, w: 10, d: 8, door: 'e', wall: 0xf4efe2 },
  { id: 'house4', kind: 'house', x: 40, z: -112, w: 12, d: 9, door: 's', wall: 0xe3ecd9 },
  { id: 'house5', kind: 'house', x: -92, z: 40, w: 10, d: 8, door: 'e', wall: 0xf0e0c8 },
  { id: 'teashop', kind: 'teashop', x: 25, z: 14, w: 7, d: 5, door: 'n', wall: 0xdfe8ef },
  // Modern two-storey concrete houses (flat roof, balcony, rooftop water tank).
  { id: 'modern1', kind: 'modern', x: -22, z: 42, w: 10, d: 9, door: 'e', wall: 0xf3e2c4 },
  { id: 'modern2', kind: 'modern', x: 100, z: 30, w: 11, d: 9, door: 'n', wall: 0xd9ecd8 },
  { id: 'modern3', kind: 'modern', x: -104, z: -126, w: 10, d: 9, door: 'e', wall: 0xf5d2bc },
];

/** Roads (polylines, 7 m wide). Terrain is levelled across them; canal crossings get bridges. */
export const ROAD_WIDTH = 7;
export const ROADS: V2[][] = [
  // Main road: beach → town → up into the hills to the viewpoint.
  [[-136, -30], [-110, -22], [-75, -8], [-40, 2], [0, 4], [40, 4], [80, -2], [110, -18], [135, -40], [150, -70], [142, -100], [160, -124], [182, -130], [190, -138]],
  // Coastal road: Fort Kochi → beach → bridge over the canal → Kovalam lighthouse.
  [[-128, -205], [-130, -120], [-133, -60], [-136, -30], [-130, 30], [-126, 90], [-130, 158], [-138, 190], [-150, 200]],
  // Town → backwaters jetty.
  [[5, 4], [10, 45], [4, 85], [8, 116]],
  // Town → temple gate.
  [[-40, 2], [-50, -30], [-58, -62], [TEMPLE_GATE.x + 4, TEMPLE_GATE.z]],
];

/**
 * Off-road park north of the temple: rough ground, mounds to climb, mud pits, a creek to
 * ford and a rutted dirt track that loops through it from the coastal road.
 */
export const OFFROAD = rect(-75, -193, 84, 86);
export const OFFROAD_TRACK: V2[] = [
  [-129, -186], [-114, -183], [-96, -171], [-72, -164], [-50, -176], [-42, -200], [-58, -222], [-86, -226], [-108, -214], [-112, -196], [-114, -183],
];
export const OFFROAD_CREEK: V2[] = [[-122, -160], [-92, -186], [-64, -196], [-30, -214]];
export const OFFROAD_MOUNDS: { x: number; z: number; r: number; h: number }[] = [
  { x: -96, z: -200, r: 11, h: 5.5 },
  { x: -60, z: -176, r: 9, h: 4.0 },
  { x: -74, z: -213, r: 7, h: 3.2 },
  { x: -48, z: -210, r: 8, h: 6.5 },
];
export const OFFROAD_PITS: { x: number; z: number; r: number }[] = [
  { x: -84, z: -168, r: 6 },
  { x: -104, z: -222, r: 5 },
  { x: -52, z: -192, r: 4.5 },
];

/** KSRTC bus stop on the main road (shelter faces the road, -Z). */
export const BUS_STOP = { x: -24, z: 10.5 };

// ── Interactables ─────────────────────────────────────────────────────────────

export interface CarSpawn {
  x: number;
  z: number;
  yaw: number;
  color: number;
  model?: 'jimny' | 'fortuner';
}
export const CAR_SPAWNS: CarSpawn[] = [
  { x: 18, z: -7, yaw: Math.PI / 2, color: 0xc5d313 }, // kinetic yellow (lime)
  { x: 18, z: -1, yaw: Math.PI / 2, color: 0x2f4a30 }, // jungle green
  { x: -124, z: -40, yaw: 0, color: 0xf2f2ee }, // white, at the beach
  { x: 16, z: 108, yaw: Math.PI, color: 0x1c2330 }, // bluish black, at the jetty
  { x: 176, z: -138, yaw: -Math.PI / 2, color: 0xe9e2c8 }, // ivory, at the viewpoint
  // Lifted Fortuners.
  { x: 14, z: -15, yaw: Math.PI / 2, color: 0x17181a, model: 'fortuner' }, // attitude black, town
  { x: -123, z: -175, yaw: 0, color: 0xf1f1ee, model: 'fortuner' }, // pearl white, off-road park gate
  { x: -124, z: -52, yaw: 0, color: 0x6b7177, model: 'fortuner' }, // grey, beach parking
];

/** Rooms for acoustics: voices crossing a room boundary are muffled (or cut, if soundproof). */
export interface Room {
  id: number;
  name: string;
  r: Rect;
  y0: number;
  y1: number;
  soundproof: boolean;
}

/** PA systems: a mic you hold E at, and the speakers it plays through. */
export interface PADef {
  id: number;
  name: string;
  mic: [number, number, number];
  micRadius: number;
  /** Only listeners in this room hear it (null = everywhere). */
  room: number | null;
  ref: number;
  max: number;
}

/** Seats you can sit on (E). Positions are the seat surface; yaw is the way you face. */
export interface Seat {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}
