/* ==========================================================================
   SCROLL SMART — script.js
   Vanilla JS only. Everything degrades gracefully:
   - no IntersectionObserver → content just shows (no reveal animation)
   - prefers-reduced-motion  → counters snap to final values, no animation
   ========================================================================== */
(function () {
  "use strict";

  // Signal that JS is running (the .no-js CSS fallback keeps content visible otherwise)
  document.documentElement.classList.remove("no-js");

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 1. Footer year ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- 2. Mobile nav toggle ---------- */
  var toggle = document.getElementById("nav-toggle");
  var navLinks = document.getElementById("nav-links");

  if (toggle && navLinks) {
    toggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });

    // Close the dropdown after choosing a section
    navLinks.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        navLinks.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });

    // Close when tapping anywhere outside the nav
    document.addEventListener("click", function (e) {
      if (navLinks.classList.contains("open") && !e.target.closest(".nav")) {
        navLinks.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- 3. Scroll progress bar (rAF-throttled) ---------- */
  var progressBar = document.getElementById("progress-bar");
  var ticking = false;

  function updateProgress() {
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var ratio = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
    progressBar.style.transform = "scaleX(" + ratio + ")";
    ticking = false;
  }

  if (progressBar) {
    window.addEventListener("scroll", function () {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(updateProgress);
      }
    }, { passive: true });
    updateProgress();
  }

  /* ---------- 4. Scroll-triggered reveal animations ---------- */
  var revealEls = document.querySelectorAll("[data-reveal]");

  if ("IntersectionObserver" in window && revealEls.length) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target); // animate once, then stop watching
        }
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -8% 0px" });

    revealEls.forEach(function (el) { revealObserver.observe(el); });
  } else {
    // Old browser: show everything immediately
    revealEls.forEach(function (el) { el.classList.add("in-view"); });
  }

  /* ---------- 5. Active section highlighting in the nav ---------- */
  var navAnchors = document.querySelectorAll("[data-nav]");
  var sections = [];

  navAnchors.forEach(function (a) {
    var target = document.querySelector(a.getAttribute("href"));
    if (target) sections.push({ el: target, link: a });
  });

  function setActive(id) {
    navAnchors.forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("href") === "#" + id);
    });
  }

  if ("IntersectionObserver" in window && sections.length) {
    // A section is "active" when it crosses the middle band of the viewport
    var navObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) setActive(entry.target.id);
      });
    }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });

    sections.forEach(function (s) { navObserver.observe(s.el); });
  }

  /* ---------- 6. Animated stat counters ----------
     <span data-count="45" data-prefix="$">45</span>
     The final value lives in the HTML (works without JS); when the stat
     scrolls into view we count up from 0. Skipped under reduced motion. */
  var counters = document.querySelectorAll("[data-count]");

  function animateCount(el) {
    var target = parseInt(el.getAttribute("data-count"), 10) || 0;
    var prefix = el.getAttribute("data-prefix") || "";
    var duration = 1100;
    var start = null;

    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = prefix + Math.round(eased * target);
      if (p < 1) window.requestAnimationFrame(step);
    }
    window.requestAnimationFrame(step);
  }

  if ("IntersectionObserver" in window && counters.length && !reducedMotion) {
    var countObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animateCount(entry.target);
          countObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.6 });

    counters.forEach(function (el) { countObserver.observe(el); });
  }
  // With reduced motion or no IO support, the HTML already shows final values.
})();
