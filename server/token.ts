import 'dotenv/config';
import express from 'express';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
/** Prefix for LiveKit room names; each invite code gets its own room ("lobby" is public). */
const ROOM_NAME = process.env.ROOM_NAME || 'voice-world';
const PORT = Number(process.env.PORT) || 3001;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET (see .env.example)');
  process.exit(1);
}

// Tiny in-memory per-IP limiter: 30 token requests / minute.
const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) {
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++h.n > 30;
}

const app = express();
app.set('trust proxy', 1);

app.post('/api/token', express.json({ limit: '1kb' }), async (req, res) => {
  if (limited(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many requests' });

  const name = String(req.body?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const room = String(req.body?.room ?? '').toLowerCase().trim() || 'lobby';
  if (!/^[a-z0-9-]{3,32}$/.test(room)) return res.status(400).json({ error: 'Invalid room code' });
  if (!name) return res.status(400).json({ error: 'Name required' });

  const identity = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16)}-${randomBytes(3).toString('hex')}`;
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: '4h',
  });
  at.addGrant({
    roomJoin: true,
    room: `${ROOM_NAME}-${room}`,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE],
  });
  res.json({ token: await at.toJwt(), url: LIVEKIT_URL, identity, room });
});

// In production, serve the built client from the same origin.
const dist = path.resolve('dist');
if (existsSync(dist)) app.use(express.static(dist));

app.listen(PORT, () => console.log(`token server on :${PORT} (rooms "${ROOM_NAME}-*")`));
