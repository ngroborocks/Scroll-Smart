# Analytics

The site runs **two** cookieless, privacy-first trackers side by side. Neither
sets cookies nor fingerprints visitors, so **no cookie/consent banner is
needed**.

| Tool | What it's for | Dashboard |
|------|---------------|-----------|
| **Cloudflare Web Analytics** | Traffic: pageviews, referrers, countries, devices, Core Web Vitals | [dash.cloudflare.com](https://dash.cloudflare.com) → Analytics & Logs → Web Analytics |
| **GoatCounter** | Behavior: button clicks and section reach, plus its own pageview/referrer counts | [neil.goatcounter.com](https://neil.goatcounter.com) |

Both scripts live at the bottom of `index.html`, just before `</body>`. The
Cloudflare snippet holds its site token; the GoatCounter snippet holds the site
code (`neil`) in its `data-goatcounter` URL. If either ever changes, also
update the matching origins in the Content-Security-Policy `<meta>` tag at the
top of `index.html` — GoatCounter's site code appears there twice (`img-src`
and `connect-src`).

Analytics are on the **public landing page only**. `book/` and `scheduling/`
are logged-in tools (`book/` is also `noindex`) and carry no trackers.

## GoatCounter event reference

Events show up in the GoatCounter dashboard as paths (filter by name).

### Click events (`data-goatcounter-click` attributes in `index.html`)

| Event | Fires when someone clicks… |
|-------|----------------------------|
| `cta-request-nav` | "Book a visit" in the sticky nav (jumps to the booking form) |
| `cta-request-hero` | "Book a visit — it's free" in the hero (jumps to the booking form) |
| `cta-request-form` | **Send request** — submits the booking form and opens the pre-filled email |
| `cta-explore-talk` | "What we cover" (secondary hero button) |
| `cta-one-pager` | "Request the principal's one-pager" in The Talk |
| `cta-get-involved` | "Reach out" in the Get Involved card |
| `contact-parent` | the "I'm a Parent" contact card |
| `contact-teacher` | the "I'm a Teacher" contact card |
| `contact-student` | the "I'm a Student" contact card |
| `email-aiden` / `email-neil` | a founder's email link in About |
| `phone-aiden` / `phone-neil` | a founder's phone number in About |
| `email-book` | the handwritten "or just email us" address in the booking section |
| `link-book-portal` | "Pick a time on our live calendar" → the `book/` scheduling portal |
| `email-footer` | contactus@scroll-smart.com in the footer |

**Reading the conversion step.** `cta-request-nav` and `cta-request-hero` are
now *in-page jumps* to the booking form, not emails — they measure intent, not
conversion. The real conversion is **`cta-request-form`**, which fires when the
form is submitted and the pre-filled email actually opens. The
`cta-request-hero → cta-request-form` gap is the form's abandonment rate.

The `contact-*` cards and `email-*` / `phone-*` links are still direct
`mailto:` / `tel:` links, so a click there means the email or dialer opened.

### Engagement event (fired from `site.js`, section 4)

| Event | Fires when… |
|-------|-------------|
| `engaged` | the first of these happens: the visitor scrolls past **150px**, or the tab has been **visible for 10 cumulative seconds** (background time isn't counted). At most once per page load. |

`engaged` is the bot/bounce filter. A raw pageview count includes bots,
prefetches, and one-second self-bounces; `engaged` only fires for a visitor who
actually stayed or scrolled, so **engaged ÷ pageviews** is the real "did a human
read this?" rate. After it fires, its scroll listener and timer are torn down —
no persistent listeners linger.

### Section-reach events (fired from `site.js`, section 3)

`reached-mission`, `reached-talk`, `reached-why`, `reached-about`,
`reached-book`, `reached-contact` — each fires the **first** time that section
becomes visible in a pageview (at most once per page load). Together they read
as a scroll funnel: comparing `reached-book` against `cta-request-form` shows
how many people who saw the booking form actually sent a request.

Implementation notes: the `engaged` and reach events use scroll/visibility and
IntersectionObserver respectively, and every GoatCounter call is guarded to
no-op if `count.js` didn't load (ad blockers) — analytics can never break the
page.

### Funnel reading order

Read the events top to bottom as one drop-off funnel — each step should be a
subset of the one above it:

```
pageview            all hits (includes bots / prefetch / instant bounces)
  → engaged         a real human stayed or scrolled (the honest denominator)
    → reached-mission
      → reached-talk
        → reached-why
          → reached-about
            → reached-book        saw the booking form
              → cta-request-form  sent a pre-filled presentation email (conversion)
```

The 64-views-but-6-scrolls problem lives in the `pageview → engaged` gap: a
large drop there means most "views" were never real readers. The
`reached-book → cta-request-form` gap is the closing rate — people who reached
the form but didn't send it.

### Excluding founder devices

Founder/self visits are excluded with GoatCounter's built-in ignore switch:
load the live site once with `#toggle-goatcounter` on the end of the URL
(`https://scroll-smart.com/#toggle-goatcounter`) and GoatCounter stops counting
that browser. It's stored **per browser** (not per person), so redo it on every
browser/device you use — and again **after clearing site data**, since that
wipes the flag. This keeps our own testing out of the `engaged` / funnel
numbers above.

## Security note

The Content-Security-Policy in `index.html` allowlists exactly these analytics
origins: `static.cloudflareinsights.com` + `cloudflareinsights.com`
(Cloudflare) and `gc.zgo.at` + `neil.goatcounter.com` (GoatCounter). Any new
or replacement analytics provider must be added there too, or the browser will
silently block it.

`script-src` deliberately has **no `'unsafe-inline'`** — the landing page's
booking-form logic lives in `site.js` rather than an inline `<script>` block so
the policy can stay strict. Keep it that way: adding an inline script to
`index.html` will be blocked by the browser.
