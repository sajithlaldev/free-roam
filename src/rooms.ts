/**
 * Rooms: the public lobby, or a private room with an unguessable code that you share as a
 * link (…/?room=k7mq-x2pd). Each room is its own LiveKit room on the server.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)

export const LOBBY = 'lobby';

export function roomFromUrl(): string {
  const r = new URLSearchParams(location.search).get('room')?.toLowerCase().trim() ?? '';
  return /^[a-z0-9-]{3,32}$/.test(r) ? r : LOBBY;
}

export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function inviteLink(room: string): string {
  const u = new URL(location.href);
  u.search = '';
  if (room !== LOBBY) u.searchParams.set('room', room);
  return u.toString();
}

/** Put the room in the address bar (so a reload, or copying the URL, keeps it). */
export function setUrlRoom(room: string) {
  history.replaceState(null, '', inviteLink(room));
}

/** Copy, or open the share sheet on phones. Resolves to a short status message. */
export async function shareInvite(room: string): Promise<string> {
  const url = inviteLink(room);
  const text = room === LOBBY ? 'Join me in Free Roam Kerala' : `Join my Free Roam Kerala room (${room})`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Free Roam — Kerala', text, url });
      return 'Shared';
    } catch {
      /* cancelled → fall back to copying */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'Invite link copied';
  } catch {
    prompt('Copy this invite link:', url);
    return 'Invite link ready';
  }
}
