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

// ---------- calendar dates (America/Chicago — the site's home timezone) ----------
function chicagoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()); // YYYY-MM-DD
}
function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z'));
}
function dateToDayIdx(s) { return (new Date(s + 'T12:00:00Z').getUTCDay() + 6) % 7; } // 0=Mon .. 6=Sun
function addDays(s, n) {
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Date-range overrides stored under SCHEDULE key "overrides":
//   [{from:"YYYY-MM-DD", to:"YYYY-MM-DD", type:"free"|"blocked", label:"Summer break"}]
// "free"   -> the whole DAY_START..DAY_END window is mutually open that day
// "blocked"-> no availability that day, regardless of class schedules
// No override -> fall back to the recurring weekly class schedules.
function findOverride(overrides, date) {
  for (const o of overrides) if (o.from <= date && date <= o.to) return o;
  return null;
}

// Availability across real calendar dates. Windows keep their raw span; a window
// is included when it has any positive length. usableMinutes = length - buffer
// (the IN-PERSON number; virtual sessions need no travel, so clients use
// lengthMinutes for those and may hide windows whose usableMinutes <= 0).
function computeDateWindows(neilEvents, aidenEvents, overrides, bufferMin, fromDate, numDays) {
  const windows = [];
  for (let i = 0; i < numDays; i++) {
    const date = addDays(fromDate, i);
    const d = dateToDayIdx(date);
    const o = findOverride(overrides, date);
    let mutual;
    if (o && o.type === 'blocked') {
      mutual = [];
    } else if (o && o.type === 'free') {
      mutual = [{ start: DAY_START, end: DAY_END }];
    } else {
      const busyA = neilEvents.filter(e => e.day === d)
        .map(e => ({ start: toMin(e.start), end: toMin(e.end) }))
        .filter(e => e.start !== null && e.end !== null && e.end > e.start);
      const busyB = aidenEvents.filter(e => e.day === d)
        .map(e => ({ start: toMin(e.start), end: toMin(e.end) }))
        .filter(e => e.start !== null && e.end !== null && e.end > e.start);
      mutual = intersectFree(freeIntervals(busyA, DAY_START, DAY_END), freeIntervals(busyB, DAY_START, DAY_END));
    }
    for (const w of mutual) {
      const len = w.end - w.start;
      if (len <= 0) continue;
      windows.push({
        date, day: d, dayName: DAY_NAMES[d], start: w.start, end: w.end,
        lengthMinutes: len, usableMinutes: len - bufferMin,
        override: o ? o.type : null
      });
    }
  }
  return windows;
}

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
  if (attempts >= 100) return json({ ok: false, error: 'too many attempts, try again later' }, 429);
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

// Schools in this set may only book virtual presentations. Stored as ONE
// SCHEDULE key ("virtual-only" -> JSON array of schoolIds) so updating the
// whole list costs a single KV write instead of one per school login record.
async function getVirtualOnlySet(env) {
  const raw = await env.SCHEDULE.get('virtual-only');
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw)); } catch (e) { return new Set(); }
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
  const url = new URL(request.url);
  if (identity.role === 'admin') {
    const bp = parseInt(url.searchParams.get('buffer') || '', 10);
    if (!isNaN(bp) && bp >= 0) buffer = bp;
  }

  // Real calendar horizon: from (default today, America/Chicago), weeks (default 10, max 26)
  let from = url.searchParams.get('from');
  if (!isDateStr(from)) from = chicagoToday();
  let weeks = parseInt(url.searchParams.get('weeks') || '10', 10);
  if (isNaN(weeks) || weeks < 1) weeks = 10;
  if (weeks > 26) weeks = 26;

  const ovRaw = await env.SCHEDULE.get('overrides');
  let overrides = [];
  if (ovRaw) { try { overrides = JSON.parse(ovRaw); } catch (e) { /* treat as none */ } }

  const windows = computeDateWindows(neilEvents, aidenEvents, overrides, buffer, from, weeks * 7);
  const virtualOnly = identity.role === 'school' && identity.schoolId
    ? (await getVirtualOnlySet(env)).has(identity.schoolId) : false;
  return json({ ok: true, buffer, from, weeks, windows, virtualOnly });
}

// ---------- date overrides (admin): free/blocked calendar ranges ----------
async function handleGetOverrides(request, env) {
  const identity = await requireAuth(request, env, ['admin']);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const raw = await env.SCHEDULE.get('overrides');
  let overrides = [];
  if (raw) { try { overrides = JSON.parse(raw); } catch (e) { /* corrupt -> empty */ } }
  return json({ ok: true, overrides });
}

async function handleSaveOverrides(request, env) {
  const identity = await requireAuth(request, env, ['admin']);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await safeJson(request);
  if (!body || !Array.isArray(body.overrides)) return json({ ok: false, error: 'overrides array required' }, 400);
  if (body.overrides.length > 50) return json({ ok: false, error: 'too many overrides' }, 400);
  const clean = [];
  for (const o of body.overrides) {
    if (!o || !isDateStr(o.from) || !isDateStr(o.to)) return json({ ok: false, error: 'each override needs valid from/to dates' }, 400);
    if (o.from > o.to) return json({ ok: false, error: 'from must be on or before to' }, 400);
    if (o.type !== 'free' && o.type !== 'blocked') return json({ ok: false, error: 'type must be free or blocked' }, 400);
    clean.push({ from: o.from, to: o.to, type: o.type, label: String(o.label || '').slice(0, 60) });
  }
  clean.sort(function (a, b) { return a.from < b.from ? -1 : 1; });
  await env.SCHEDULE.put('overrides', JSON.stringify(clean));
  return json({ ok: true, count: clean.length });
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
// SECURITY: a booking's note/school name is attacker-controlled free text and must
// never inject a live mention into the outgoing webhook.
//   Slack broadcasts via <!channel>/<!here>/<!everyone> and parses <...> link/mention
//     syntax — so we HTML-escape &, <, > in the Slack "text" field, which neutralises
//     ALL of those sequences (they can no longer start with a literal '<').
//   Discord pings on @everyone/@here/@role/@user — so we send allowed_mentions:{parse:[]},
//     which forbids EVERY mention type regardless of what the message text contains.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function bookingSummaryLine(booking) {
  const when = (booking.date ? booking.date + ' (' + DAY_NAMES[booking.day] + ')' : DAY_NAMES[booking.day]) +
    ' ' + booking.start + '–' + booking.end;
  const extras = [];
  if (booking.format) extras.push(booking.format);
  if (booking.audienceSize) extras.push('~' + booking.audienceSize + ' students');
  return booking.schoolName + ' requested ' + when + (extras.length ? ' · ' + extras.join(' · ') : '');
}
function buildWebhookPayload(booking) {
  const rawMsg = 'New Scroll Smart booking request\n' +
    bookingSummaryLine(booking) +
    (booking.note ? '\nNote: ' + booking.note : '');
  return {
    text: slackEscape(rawMsg),        // Slack uses "text": escaped, so no live <!channel>/<@…>/<url>
    content: rawMsg,                  // Discord uses "content"...
    allowed_mentions: { parse: [] }   // ...but this makes @everyone/@here/roles/users non-pinging
  };
}
async function notifyBooking(env, booking) {
  // Plain-text copy for email — email can't "ping", so mentions are harmless there.
  const emailText = 'New Scroll Smart booking request\n' +
    bookingSummaryLine(booking) +
    (booking.note ? '\nNote: ' + booking.note : '');
  try {
    // A single incoming-webhook URL works for Slack ("text") and Discord ("content").
    if (env.BOOKING_WEBHOOK_URL) {
      await fetch(env.BOOKING_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildWebhookPayload(booking))
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
          text: emailText
        })
      });
    }
  } catch (e) { /* notifications must never break a booking */ }
}

async function handleBook(request, env, ctx) {
  const identity = await requireAuth(request, env, null);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await safeJson(request);
  if (!body || !isDateStr(body.date)) return json({ ok: false, error: 'a valid date (YYYY-MM-DD) is required' }, 400);
  if (body.date < chicagoToday()) return json({ ok: false, error: 'that date has already passed' }, 400);
  if (!/^\d{2}:\d{2}$/.test(body.start || '') || !/^\d{2}:\d{2}$/.test(body.end || '')) return json({ ok: false, error: 'invalid time' }, 400);
  const s = toMin(body.start), e = toMin(body.end);
  if (s === null || e === null || e <= s) return json({ ok: false, error: 'end must be after start' }, 400);
  const format = body.format === 'virtual' ? 'virtual' : (body.format === 'in-person' ? 'in-person' : null);
  if (!format) return json({ ok: false, error: 'format must be in-person or virtual' }, 400);
  // Virtual-only schools can't request in-person visits — enforced here, not just
  // hidden in the UI, so a hand-crafted request can't get around it.
  if (format === 'in-person' && identity.role === 'school' && identity.schoolId &&
      (await getVirtualOnlySet(env)).has(identity.schoolId)) {
    return json({ ok: false, error: 'your school is set up for virtual presentations only' }, 403);
  }
  const audience = parseInt(body.audienceSize, 10);
  if (isNaN(audience) || audience < 1 || audience > 5000) return json({ ok: false, error: 'audience size must be a number between 1 and 5000' }, 400);

  const booking = {
    id: crypto.randomUUID(),
    schoolId: identity.schoolId || null,
    schoolName: identity.name || 'Unknown',
    bookedByRole: identity.role,
    date: body.date, day: dateToDayIdx(body.date),
    start: body.start, end: body.end,
    format: format, audienceSize: audience,
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

// A school sees ONLY its own requests. The filter key is the schoolId from the
// signed session token — never a schoolId/param supplied by the client — and the
// projection omits every other school's data by construction.
async function handleMyBookings(request, env) {
  const identity = await requireAuth(request, env, ['school']);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!identity.schoolId) return json({ ok: true, bookings: [] });
  const list = await env.SCHEDULE.list({ prefix: 'booking:' });
  const bookings = [];
  for (const k of list.keys) {
    const raw = await env.SCHEDULE.get(k.name);
    if (!raw) continue;
    let b;
    try { b = JSON.parse(raw); } catch (e) { continue; }
    if (b.schoolId && b.schoolId === identity.schoolId) {
      // project only this school's own fields — no other school ever appears here
      bookings.push({
        id: b.id, date: b.date || null, day: b.day, start: b.start, end: b.end,
        format: b.format || null, audienceSize: b.audienceSize || null,
        note: b.note, createdAt: b.createdAt, status: b.status
      });
    }
  }
  bookings.sort(function (a, b) { return b.createdAt - a.createdAt; });
  return json({ ok: true, bookings: bookings });
}

async function handleCancelBooking(request, env) {
  const identity = await requireAuth(request, env, null); // any authenticated; ownership enforced below
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await safeJson(request);
  if (!body || !body.id) return json({ ok: false, error: 'id required' }, 400);

  const key = 'booking:' + String(body.id);
  const raw = await env.SCHEDULE.get(key);
  if (!raw) return json({ ok: false, error: 'not found' }, 404);
  let booking;
  try { booking = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'not found' }, 404); }

  // Admins manage every request. A school may cancel ONLY a booking it owns, and
  // ownership is decided by comparing the booking's stored schoolId to the schoolId
  // in the caller's signed session — the request body never says whose booking it is.
  const ownsIt = identity.role === 'school' && identity.schoolId && booking.schoolId === identity.schoolId;
  if (identity.role !== 'admin' && !ownsIt) return json({ ok: false, error: 'forbidden' }, 403);

  await env.SCHEDULE.delete(key);
  return json({ ok: true });
}

// Change the caller's OWN password. Requires a valid session AND the current
// password (which must resolve to the same identity as the session). Passwords
// are stored only as sha256 keys, so we write the new key and delete the old one.
async function handleChangePassword(request, env) {
  const identity = await requireAuth(request, env, null);
  if (!identity) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await safeJson(request);
  if (!body || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
    return json({ ok: false, error: 'currentPassword and newPassword are required' }, 400);
  }
  if (body.newPassword.length < 8) {
    return json({ ok: false, error: 'new password must be at least 8 characters' }, 400);
  }

  // brute-force guard on the current-password check
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rlKey = 'rlpw:' + ip;
  const attempts = parseInt((await env.LOGINS.get(rlKey)) || '0', 10);
  if (attempts >= 8) return json({ ok: false, error: 'too many attempts, try again later' }, 429);

  const oldHash = await sha256Hex(body.currentPassword);
  const raw = await env.LOGINS.get('login:' + oldHash);
  let record = null;
  if (raw) { try { record = JSON.parse(raw); } catch (e) { /* corrupt */ } }
  // The current password must belong to THIS session's account, not just be some valid login.
  const sameAccount = record
    && record.role === identity.role
    && (record.name || '') === (identity.name || '')
    && (record.schoolId || null) === (identity.schoolId || null);
  if (!sameAccount) {
    await env.LOGINS.put(rlKey, String(attempts + 1), { expirationTtl: 600 });
    return json({ ok: false, error: 'current password is incorrect' }, 401);
  }

  const newHash = await sha256Hex(body.newPassword);
  if (newHash === oldHash) return json({ ok: false, error: 'new password must differ from the current one' }, 400);
  const clash = await env.LOGINS.get('login:' + newHash);
  if (clash) return json({ ok: false, error: 'please choose a different password' }, 409);

  await env.LOGINS.put('login:' + newHash, JSON.stringify(record)); // same identity, new key
  await env.LOGINS.delete('login:' + oldHash);
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
      else if (url.pathname === '/api/my-bookings' && request.method === 'GET') resp = await handleMyBookings(request, env);
      else if (url.pathname === '/api/overrides' && request.method === 'GET') resp = await handleGetOverrides(request, env);
      else if (url.pathname === '/api/overrides' && request.method === 'POST') resp = await handleSaveOverrides(request, env);
      else if (url.pathname === '/api/bookings/seen' && request.method === 'POST') resp = await handleSeenBookings(request, env);
      else if (url.pathname === '/api/bookings/cancel' && request.method === 'POST') resp = await handleCancelBooking(request, env);
      else if (url.pathname === '/api/change-password' && request.method === 'POST') resp = await handleChangePassword(request, env);
      else resp = json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      resp = json({ ok: false, error: 'server error' }, 500);
    }
    return withCors(resp, origin, env);
  }
};

// exported for local testing only — harmless in the real Workers runtime (unused there)
export const __test = {
  signToken, verifyToken, sha256Hex, computeWeekWindows, toMin,
  slackEscape, buildWebhookPayload,
  computeDateWindows, findOverride, dateToDayIdx, addDays, isDateStr
};
