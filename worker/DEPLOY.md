# Deploying the scheduling API

You'll need a (free) Cloudflare account. This does **not** touch your existing
GitHub Pages site or IONOS DNS at all — it's a separate, additive piece that
the scheduling page calls over the network.

## 1. Install wrangler and log in
```
npm install -g wrangler
wrangler login
```

## 2. Create the two KV namespaces
```
wrangler kv namespace create LOGINS
wrangler kv namespace create SCHEDULE
```
Each command prints an `id`. Open `wrangler.toml` and paste the two ids in,
replacing `REPLACE_WITH_LOGINS_NAMESPACE_ID` and `REPLACE_WITH_SCHEDULE_NAMESPACE_ID`.

## 3. Set the session secret
```
openssl rand -hex 32
wrangler secret put SESSION_SECRET
```
Paste the random string from the first command when prompted. This is what
signs login sessions — it should never be committed to the repo, and isn't.

## 4. Seed your two admin logins
`seed-logins.json` already has Neil and Aiden's accounts in it:
```
wrangler kv bulk put seed-logins.json --binding=LOGINS
```
Temporary passwords (change these once it's live — see step 7):
- **Neil:** `(shared privately)`
- **Aiden:** `(shared privately)`

## 5. Deploy
```
wrangler deploy
```
This prints a URL that looks like `https://scroll-smart-api.<your-subdomain>.workers.dev`.
Copy it exactly.

## 6. Point the frontend at it
In `scheduling/index.html`, find this line near the top of the `<script>` block:
```js
var API_BASE = "https://scroll-smart-api.YOUR-SUBDOMAIN.workers.dev";
```
Replace it with the real URL from step 5. Then commit `scheduling/index.html`
into the `Scroll-Smart` repo (same location as before) and push.

## 7. Test it
Visit `scroll-smart.com/scheduling/`, log in with Neil's temp password, add
your real classes on the left, hit **Save changes**. Log out, log in with
Aiden's temp password, confirm his side works and Neil's shows up read-only
on the right. Once you're both happy, pick real passwords:
- generate a new one the same way as before (or just make one up),
- tell Claude the new password, and it'll compute the hash and give you a
  one-line `wrangler kv key put` command to swap it in — the plaintext
  password never needs to touch the repo or this chat again after that.

## 8. Once you send me the school spreadsheet
```
node seed-schools.js path/to/schools.csv
wrangler kv bulk put seed-schools-logins.json --binding=LOGINS
```
This also writes `seed-schools-roster.csv` — the one file that has every
school's actual password next to their name. **Keep that one off GitHub** —
it's for you and Aiden to know what to send each school, nothing more.

## Booking notifications (optional)
Schools can request an open window from the page; every request already shows
up in both founders' portals with an unread badge. To also get *pushed* a
message on each request, set **one** webhook URL — the same value works for
both Slack and Discord:

1. **Slack:** create an *Incoming Webhook* (api.slack.com/apps → your app →
   Incoming Webhooks → Add New Webhook to Workspace) and copy the URL.
   **Discord:** Channel Settings → Integrations → *Webhooks* → New Webhook →
   Copy Webhook URL.
2. Store it as a secret and redeploy:
   ```
   wrangler secret put BOOKING_WEBHOOK_URL
   ```
   Paste the URL when prompted. Each new booking then posts to that channel.

To try it locally first, add `BOOKING_WEBHOOK_URL=<your url>` to
`worker/.dev.vars` (gitignored) and make a test booking.

Email is also supported instead of / alongside a webhook: set `RESEND_API_KEY`
and `NOTIFY_TO` (comma-separated recipients) as secrets to send mail via Resend
on each booking.

## What's intentionally NOT built yet
- A UI for managing/adding individual schools after the initial import —
  right now that's a script you re-run, not a dashboard.
- Per-school travel buffer (e.g. shorter buffer for closer schools). The
  worker already checks for it if a `SCHOOLS` KV namespace exists with
  `bufferMinutes` on a school's record — just not wired up to real distance
  data yet.
- Confirming/declining a booking from the portal (right now a founder can see
  a request and remove it, but there's no "confirm & email the school back"
  step yet).
