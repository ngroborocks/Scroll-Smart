/* ==========================================================================
   SCROLL SMART — site.js  (Organic theme)
   Vanilla JS only. Lives in an external file rather than an inline <script>
   so the Content-Security-Policy in index.html can stay strict (no
   'unsafe-inline' in script-src).
   ========================================================================== */
(function () {
  "use strict";

  /* ---------- 1. Footer year ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- 2. Booking form ----------
     The "Format" control is a segmented button pair, not a native input, so
     its value is tracked here and appended to the pre-filled mailto.

     NOTE: fields are read via form.elements[...], NOT form.name / form.role.
     An HTMLFormElement already owns a `name` property (its own name attribute)
     and inherits a `role` property (ARIA reflection), so those two names are
     shadowed and never resolve to the inputs — form.name would yield "" and
     form.role would yield null, throwing on .value. */
  var seg = document.getElementById("fmtSeg");
  var bookForm = document.getElementById("bookForm");
  var fmt = "in-person";

  if (seg) {
    seg.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      fmt = b.dataset.v;
      seg.querySelectorAll("button").forEach(function (x) {
        x.classList.toggle("on", x === b);
      });
    });
  }

  if (bookForm) {
    bookForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target.elements;
      var val = function (n) { return f[n] ? f[n].value : ""; };

      var body =
        "Hi Aiden and Neil,%0A%0AWe would love to bring Scroll Smart to our school.%0A%0A" +
        "Name: " + encodeURIComponent(val("name")) + "%0A" +
        "Role: " + encodeURIComponent(val("role")) + "%0A" +
        "School: " + encodeURIComponent(val("school")) + "%0A" +
        "Rough timing: " + encodeURIComponent(val("when")) + "%0A" +
        "Format: " + encodeURIComponent(fmt) + "%0A%0AThanks!";

      location.href =
        "mailto:contactus@scroll-smart.com?subject=" +
        encodeURIComponent("Presentation request — " + val("school")) +
        "&body=" + body;
    });
  }

  /* ---------- 3. GoatCounter section-reach events ----------
     Fires "reached-<section>" the first time each major section becomes
     visible, at most once per page load (unobserve after firing). No-ops if
     GoatCounter hasn't loaded (ad blocker, network failure): analytics must
     never break the page. */
  function gcEvent(name) {
    if (window.goatcounter && typeof window.goatcounter.count === "function") {
      window.goatcounter.count({ path: name, event: true });
    }
  }

  var reachIds = ["mission", "talk", "why", "about", "book", "contact"];

  if ("IntersectionObserver" in window) {
    // rootMargin band instead of a % threshold: a % of a very tall section can
    // exceed the viewport on mobile and never fire. This fires once the
    // section reaches the top 60% of the screen, regardless of its height.
    var reachObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          gcEvent("reached-" + entry.target.id);
          reachObserver.unobserve(entry.target); // once per page load
        }
      });
    }, { rootMargin: "0px 0px -40% 0px", threshold: 0 });

    reachIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) reachObserver.observe(el);
    });
  }

  /* ---------- 4. GoatCounter "engaged" event ----------
     Separates real readers from bounces/bots. Fires "engaged" exactly once
     per page load, on whichever comes first:
       (a) the first scroll past 150px, or
       (b) 10 cumulative seconds with the tab visible.
     The 1-second tick only counts while the tab is visible, so background
     time doesn't inflate the count. After it fires we tear down the scroll
     listener and the timer — no persistent listeners linger. */
  var engagedFired = false;
  var visibleSeconds = 0;
  var engageTimer = null;

  function onEngageScroll() {
    if (window.scrollY > 150) fireEngaged();
  }

  function engageTick() {
    if (document.visibilityState !== "hidden") {
      visibleSeconds += 1;
      if (visibleSeconds >= 10) fireEngaged();
    }
  }

  function fireEngaged() {
    if (engagedFired) return;
    engagedFired = true;
    gcEvent("engaged");
    window.removeEventListener("scroll", onEngageScroll);
    if (engageTimer !== null) {
      clearInterval(engageTimer);
      engageTimer = null;
    }
  }

  // Guard for a reload that restores a scrolled position past the threshold.
  if (window.scrollY > 150) {
    fireEngaged();
  } else {
    window.addEventListener("scroll", onEngageScroll, { passive: true });
    engageTimer = setInterval(engageTick, 1000);
  }
})();
