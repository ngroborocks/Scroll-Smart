# Analytics

The site uses **Cloudflare Web Analytics** — a free, cookieless, privacy-first
pageview tracker. It sets no cookies and does no fingerprinting or cross-site
tracking, so **no cookie/consent banner is needed**.

## Where to view stats

1. Log in at <https://dash.cloudflare.com>
2. Go to **Analytics & Logs → Web Analytics**
3. Select the Scroll Smart site

## Setup

The beacon script lives at the bottom of `index.html`, just before `</body>`:

```html
<script defer src='https://static.cloudflareinsights.com/beacon.min.js'
        data-cf-beacon='{"token": "..."}'></script>
```

The site token is already configured. If it ever needs to change (e.g. the
site is re-added in the dashboard), copy the new token from the Web Analytics
JS snippet and swap it into the `data-cf-beacon` attribute — keep the quotes
around it.

## What's tracked

- Page views and visits (this is a single-page site, so mostly one path)
- Referrers — which sites/searches send visitors
- Country, device type, browser, and OS
- Core Web Vitals (page-load performance)

**Not tracked:** individual visitors, click events, or scroll depth. All CTAs
are `mailto:` links, so the real conversion signal is presentation-request
emails arriving in the inbox — analytics here answers "how many people saw the
page and where did they come from," not "who clicked Book Us."

## Security note

`index.html` has a Content-Security-Policy `<meta>` tag that allowlists the
analytics origins (`static.cloudflareinsights.com` for the script,
`cloudflareinsights.com` for reporting). If you ever switch analytics
providers, update both the beacon snippet **and** those CSP directives, or the
browser will silently block the new script.
