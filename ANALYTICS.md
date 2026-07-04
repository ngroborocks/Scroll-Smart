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

## GoatCounter event reference

Events show up in the GoatCounter dashboard as paths (filter by name).

### Click events (`data-goatcounter-click` attributes in `index.html`)

| Event | Fires when someone clicks… |
|-------|----------------------------|
| `cta-request-nav` | "Book Us" in the floating nav |
| `cta-request-hero` | "Request a Presentation" in the hero |
| `cta-request-mid` | "Request a Presentation" in the banner after the Presentation section |
| `cta-request-contact` | "Request a Presentation" in the final banner at the bottom of Contact |
| `cta-explore-mission` | "Explore our mission" (secondary hero button) |
| `cta-get-involved` | "Reach out" in the Get Involved card |
| `contact-parent` | the "I'm a Parent" contact card |
| `contact-teacher` | the "I'm a Teacher" contact card |
| `contact-student` | the "I'm a Student" contact card |
| `email-aiden` / `email-neil` | a founder's email link in Contact |
| `phone-aiden` / `phone-neil` | a founder's phone number in Contact |
| `email-footer` | contactus@scroll-smart.com in the footer |

All CTAs are `mailto:` links, so a `cta-request-*` click means "opened a
pre-filled presentation-request email" — the closest measurable step to the
site's real conversion, which is that email actually arriving.

### Section-reach events (fired from `script.js`, section 7)

`reached-mission`, `reached-presentation`, `reached-why-us`, `reached-about`,
`reached-contact` — each fires the **first** time that section becomes visible
in a pageview (at most once per page load). Together they read as a scroll
funnel: comparing `reached-contact` against `cta-request-*` clicks shows how
many people who saw the contact section actually started an email.

Implementation notes: reach events use an IntersectionObserver (no scroll
listeners), and every GoatCounter call is guarded to no-op if `count.js`
didn't load (ad blockers) — analytics can never break the page.

## Security note

The Content-Security-Policy in `index.html` allowlists exactly these analytics
origins: `static.cloudflareinsights.com` + `cloudflareinsights.com`
(Cloudflare) and `gc.zgo.at` + `neil.goatcounter.com` (GoatCounter). Any new
or replacement analytics provider must be added there too, or the browser will
silently block it.
