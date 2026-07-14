// Scroll Smart — scheduling API
// A small Cloudflare Worker. Two KV namespaces:
//   LOGINS   — key "login:<sha256(password)>" -> {role:"admin"|"school", name, schoolId?}
//              key "rl:<ip>" -> attempt counter (short TTL, login rate limiting)
//   SCHEDULE — key "schedule:neil" / "schedule:aiden" -> JSON array of class events
//              key "booking:<uuid>" -> a school's booking request
//              key "seen:<admin>"   -> epoch seconds an admin last cleared their booking badge
//   SCHOOLS  — (optional) key "school:<schoolId>" -> {name, bufferMinutes, ...}  [not required for v1]
// One secret: SESSION_SECRET (set with `wrangler secret put SESSION_SECRET`)
// One var:    ALLOWED_ORIGIN (e.g. "https://scroll-smart.com")

// ---------- base64url + HMAC helpers (Workers implement the same Web Crypto API as browsers) ----------
function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function hmac(secret, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
async function signToken(payload, secret) {
  const payloadPart = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sigPart = bytesToB64url(await hmac(secret, new TextEncoder().encode(payloadPart)));
  return payloadPart + '.' + sigPart;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function verifyToken(token, secret) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [payloadPart, sigPart] = token.split('.');
  if (!payloadPart || !sigPart) return null;
  let expectedSig, givenSig;
  try { expectedSig = await hmac(secret, new TextEncoder().encode(payloadPart)); } catch { return null; }
  try { givenSig = b64urlToBytes(sigPart); } catch { return null; }
  if (!timingSafeEqual(expectedSig, givenSig)) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadPart))); } catch { return null; }
  if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
  return payload;
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- scheduling math (same logic as the page, tested there; ported here so raw
// class data never has to leave the server for school-role requests) ----------
const DAY_START = 8 * 60, DAY_END = 21 * 60;
function toMin(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function mergeIntervals(list) {
  const sorted = list.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}
function freeIntervals(busy, winStart, winEnd) {
  const merged = mergeIntervals(busy).filter(b => b.end > winStart && b.start < winEnd);
  const free = []; let cursor = winStart;
  for (const b of merged) {
    const s = Math.max(b.start, winStart), e = Math.min(b.end, winEnd);
    if (s > cursor) free.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (cursor < winEnd) free.push({ start: cursor, end: winEnd });
  return free;
}
function intersectFree(freeA, freeB) {
  const out = [];
  for (const a of freeA) for (const b of freeB) {
    const s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function computeWeekWindows(neilEvents, aidenEvents, bufferMin) {
  const windows = [];
  for (let d = 0; d < 7; d++) {
    const busyA = neilEvents.filter(e => e.day === d)
      .map(e => ({ start: toMin(e.start), end: toMin(e.end) }))
      .filter(e => e.start !== null && e.end !== null && e.end > e.start);
    const busyB = aidenEvents.filter(e => e.day === d)
      .map(e => ({ start: toMin(e.start), end: toMin(e.end) }))
      .filter(e => e.start !== null && e.end !== null && e.end > e.start);
    const mutual = intersectFree(freeIntervals(busyA, DAY_START, DAY_END), freeIntervals(busyB, DAY_START, DAY_END));
    for (const w of mutual) {
      const usable = (w.end - w.start) - bufferMin;
      if (usable > 0) windows.push({ day: d, dayName: DAY_NAMES[d], start: w.start, end: w.end, usableMinutes: usable });
    }
  }
  return windows;
}

// ---------- HTTP plumbing ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}
function withCors(resp, origin, env) {
  const h = new Headers(resp.headers);
  if (origin && origin === env.ALLOWED_ORIGIN) h.set('Access-Control-Allow-Origin', origin);
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(resp.body, { status: resp.status, headers: h });
}

async function requireAuth(request, env, allowedRoles) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const payload = await verifyToken(token, env.SESSION_SECRET);
  if (!payload) return null;
  if (allowedRoles && !allowedRoles.includes(payload.role)) return null;
  return payload;
}

async function handleLogin(request, env) {
  const body = await safeJson(request);
  if (!body || typeof body.password !== 'string' || !body.password) {
    return json({ ok: false, error: 'missing password' }, 400);
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rlKey = 'rl:' + ip;
  const attempts = parseInt((await env.LOGINS.get(rlKey)) || '0', 10);
  if (attempts >= 8) return json({ ok: false, error: 'too many attempts, try again later' }, 429);
  await env.LOGINS.put(rlKey, String(attempts + 1), { expirationTtl: 600 });

  const hash = await sha256Hex(body.password);
  const raw = await env.LOGINS.get('login:' + hash);
  if (!raw) return json({ ok: false, error: 'invalid passphrase' }, 401);

  const identity = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const ttl = identity.role === 'admin' ? 60 * 60 * 24 * 14 : 60 * 60 * 24 * 30;
  const payload = { role: identity.role, name: identity.name, schoolId: identity.schoolId || null, iat: now, exp: now + ttl };
  const token = await signToken(payload, env.SESSION_SECRET);
  return json({ ok: true, role: identity.role, name: identity.name, token });
}

async function handleMe(request, env) {
  const identity = await requireAuth(request, env, null);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  return json({ ok: true, role: identity.role, name: identity.name, schoolId: identity.schoolId });
}

async function handleAvailability(request, env) {
  const identity = await requireAuth(request, env, null);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);

  const neilRaw = await env.SCHEDULE.get('schedule:neil');
  const aidenRaw = await env.SCHEDULE.get('schedule:aiden');
  const neilEvents = neilRaw ? JSON.parse(neilRaw) : [];
  const aidenEvents = aidenRaw ? JSON.parse(aidenRaw) : [];

  let buffer = 60;
  if (identity.role === 'school' && identity.schoolId && env.SCHOOLS) {
    const schoolRaw = await env.SCHOOLS.get('school:' + identity.schoolId);
    if (schoolRaw) {
      const school = JSON.parse(schoolRaw);
      if (typeof school.bufferMinutes === 'number') buffer = school.bufferMinutes;
    }
  }
  if (identity.role === 'admin') {
    const url = new URL(request.url);
    const bp = parseInt(url.searchParams.get('buffer') || '', 10);
    if (!isNaN(bp) && bp >= 0) buffer = bp;
  }

  const windows = computeWeekWindows(neilEvents, aidenEvents, buffer);
  return json({ ok: true, buffer, windows });
}

async function handleGetSchedule(request, env) {
  const identity = await requireAuth(request, env, ['admin']);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  const who = (url.searchParams.get('who') || '').toLowerCase();
  if (who !== 'neil' && who !== 'aiden') return json({ ok: false, error: 'who must be neil or aiden' }, 400);
  const raw = await env.SCHEDULE.get('schedule:' + who);
  return json({ ok: true, who, events: raw ? JSON.parse(raw) : [] });
}

async function handleSaveSchedule(request, env) {
  const identity = await requireAuth(request, env, ['admin']);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await safeJson(request);
  if (!body || !Array.isArray(body.events)) return json({ ok: false, error: 'events array required' }, 400);

  const who = String(identity.name || '').toLowerCase();
  if (who !== 'neil' && who !== 'aiden') return json({ ok: false, error: 'unrecognized admin identity' }, 400);

  const clean = [];
  for (const e of body.events) {
    if (typeof e.day !== 'number' || e.day < 0 || e.day > 6) continue;
    if (!/^\d{2}:\d{2}$/.test(e.start) || !/^\d{2}:\d{2}$/.test(e.end)) continue;
    clean.push({ day: e.day, start: e.start, end: e.end, label: String(e.label || '').slice(0, 80) });
  }
  if (clean.length > 200) return json({ ok: false, error: 'too many events' }, 400);

  await env.SCHEDULE.put('schedule:' + who, JSON.stringify(clean));
  return json({ ok: true, who, count: clean.length });
}

// ---------- bookings: a school requests a mutually-free window; both admins see it ----------
async function notifyBooking(env, booking) {
  const when = DAY_NAMES[booking.day] + ' ' + booking.start + '–' + booking.end;
  const msg = 'New Scroll Smart booking request\n' +
    booking.schoolName + ' requested ' + when +
    (booking.note ? '\nNote: ' + booking.note : '');
  try {
    // A single incoming-webhook URL works for Slack ("text") and Discord ("content").
    if (env.BOOKING_WEBHOOK_URL) {
      await fetch(env.BOOKING_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: msg, content: msg })
      });
    }
    // Optional email via Resend (set RESEND_API_KEY + NOTIFY_TO as secrets).
    if (env.RESEND_API_KEY && env.NOTIFY_TO) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.NOTIFY_FROM || 'Scroll Smart <onboarding@resend.dev>',
          to: env.NOTIFY_TO.split(',').map(function (s) { return s.trim(); }),
          subject: 'New booking request — ' + booking.schoolName,
          text: msg
        })
      });
    }
  } catch (e) { /* notifications must never break a booking */ }
}

async function handleBook(request, env, ctx) {
  const identity = await requireAuth(request, env, null);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await safeJson(request);
  if (!body || typeof body.day !== 'number' || body.day < 0 || body.day > 6) return json({ ok: false, error: 'invalid day' }, 400);
  if (!/^\d{2}:\d{2}$/.test(body.start || '') || !/^\d{2}:\d{2}$/.test(body.end || '')) return json({ ok: false, error: 'invalid time' }, 400);
  const s = toMin(body.start), e = toMin(body.end);
  if (s === null || e === null || e <= s) return json({ ok: false, error: 'end must be after start' }, 400);

  const booking = {
    id: crypto.randomUUID(),
    schoolId: identity.schoolId || null,
    schoolName: identity.name || 'Unknown',
    bookedByRole: identity.role,
    day: body.day, start: body.start, end: body.end,
    note: String(body.note || '').slice(0, 280),
    createdAt: Math.floor(Date.now() / 1000),
    status: 'new'
  };
  await env.SCHEDULE.put('booking:' + booking.id, JSON.stringify(booking));
  if (ctx && ctx.waitUntil) ctx.waitUntil(notifyBooking(env, booking));
  else await notifyBooking(env, booking);
  return json({ ok: true, booking });
}

async function handleGetBookings(request, env) {
  const identity = await requireAuth(request, env, ['admin']);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const list = await env.SCHEDULE.list({ prefix: 'booking:' });
  const bookings = [];
  for (const k of list.keys) {
    const raw = await env.SCHEDULE.get(k.name);
    if (raw) { try { bookings.push(JSON.parse(raw)); } catch (e) { /* skip corrupt */ } }
  }
  bookings.sort(function (a, b) { return b.createdAt - a.createdAt; });
  const seenRaw = await env.SCHEDULE.get('seen:' + String(identity.name || '').toLowerCase());
  const seen = seenRaw ? parseInt(seenRaw, 10) : 0;
  const unread = bookings.filter(function (b) { return b.createdAt > seen; }).length;
  return json({ ok: true, bookings: bookings, unread: unread, seen: seen });
}

async function handleSeenBookings(request, env) {
  const identity = await requireAuth(request, env, ['admin']);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  await env.SCHEDULE.put('seen:' + String(identity.name || '').toLowerCase(), String(Math.floor(Date.now() / 1000)));
  return json({ ok: true });
}

async function handleCancelBooking(request, env) {
  const identity = await requireAuth(request, env, ['admin']);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await safeJson(request);
  if (!body || !body.id) return json({ ok: false, error: 'id required' }, 400);
  await env.SCHEDULE.delete('booking:' + String(body.id));
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), origin, env);
    }

    let resp;
    try {
      if (url.pathname === '/api/login' && request.method === 'POST') resp = await handleLogin(request, env);
      else if (url.pathname === '/api/me' && request.method === 'GET') resp = await handleMe(request, env);
      else if (url.pathname === '/api/availability' && request.method === 'GET') resp = await handleAvailability(request, env);
      else if (url.pathname === '/api/schedule' && request.method === 'GET') resp = await handleGetSchedule(request, env);
      else if (url.pathname === '/api/schedule' && request.method === 'POST') resp = await handleSaveSchedule(request, env);
      else if (url.pathname === '/api/book' && request.method === 'POST') resp = await handleBook(request, env, ctx);
      else if (url.pathname === '/api/bookings' && request.method === 'GET') resp = await handleGetBookings(request, env);
      else if (url.pathname === '/api/bookings/seen' && request.method === 'POST') resp = await handleSeenBookings(request, env);
      else if (url.pathname === '/api/bookings/cancel' && request.method === 'POST') resp = await handleCancelBooking(request, env);
      else resp = json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      resp = json({ ok: false, error: 'server error' }, 500);
    }
    return withCors(resp, origin, env);
  }
};

// exported for local testing only — harmless in the real Workers runtime (unused there)
export const __test = {
  signToken, verifyToken, sha256Hex, computeWeekWindows, toMin
};
