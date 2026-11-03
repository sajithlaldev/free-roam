import 'dotenv/config';
import express from 'express';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
const ROOM_NAME = process.env.ROOM_NAME || 'voice-world';
const ANNOUNCER_CODE = process.env.ANNOUNCER_CODE || '';
const PORT = Number(process.env.PORT) || 3001;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET (see .env.example)');
  process.exit(1);
}

function codeMatches(given: unknown): boolean {
  if (!ANNOUNCER_CODE || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ANNOUNCER_CODE);
  return a.length === b.length && timingSafeEqual(a, b);
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
  if (!name) return res.status(400).json({ error: 'Name required' });

  // The role lives in the signed token, so clients cannot grant it to themselves:
  // attributes are only writable by the server unless canUpdateOwnMetadata is granted
  // (we never grant it).
  const role = codeMatches(req.body?.code) ? 'announcer' : 'player';
  if (req.body?.code && role !== 'announcer') {
    return res.status(403).json({ error: 'Wrong announcer code' });
  }

  const identity = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16)}-${randomBytes(3).toString('hex')}`;
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    attributes: { role },
    ttl: '4h',
  });
  at.addGrant({
    roomJoin: true,
    room: ROOM_NAME,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE],
  });
  res.json({ token: await at.toJwt(), url: LIVEKIT_URL, identity, role });
});

// In production, serve the built client from the same origin.
const dist = path.resolve('dist');
if (existsSync(dist)) app.use(express.static(dist));

app.listen(PORT, () => console.log(`token server on :${PORT} (room "${ROOM_NAME}")`));
