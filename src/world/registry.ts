import type { PADef, Room, Seat } from './layout';

/** A speaker prop belonging to a PA system. */
export interface Speaker {
  pa: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Filled in deterministically while the world is built; audio, interaction and
 * networking read from it (seat ids and PA ids go over the wire).
 */
export const registry = {
  rooms: [] as Room[],
  pas: [] as PADef[],
  speakers: [] as Speaker[],
  seats: [] as Seat[],
  /** Seats taken by NPCs. */
  reservedSeats: new Set<number>(),
  /** Per-frame animation callbacks for world props (fans, nets, boats, lighthouse). */
  animators: [] as ((t: number, dt: number) => void)[],
};

export function addRoom(r: Omit<Room, 'id'>): number {
  const id = registry.rooms.length;
  registry.rooms.push({ ...r, id });
  return id;
}

export function addPA(p: Omit<PADef, 'id'>): number {
  const id = registry.pas.length;
  registry.pas.push({ ...p, id });
  return id;
}

export function addSeat(x: number, y: number, z: number, yaw: number): number {
  const id = registry.seats.length;
  registry.seats.push({ id, x, y, z, yaw });
  return id;
}

/** Which room (id) a point is in, or -1 for outdoors. */
export function roomAt(x: number, y: number, z: number): number {
  for (const r of registry.rooms) {
    if (x >= r.r.x0 && x <= r.r.x1 && z >= r.r.z0 && z <= r.r.z1 && y >= r.y0 - 0.5 && y <= r.y1) return r.id;
  }
  return -1;
}
