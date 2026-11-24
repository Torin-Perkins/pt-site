/* Toro Fitness: progressive-enhancement animations.
   Everything is visible without JS; motion is skipped for users who prefer reduced motion. */
(function () {
  window.__toroReady = true;
  var root = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Page-load entrance animations (hero text, etc.)
  requestAnimationFrame(function () { root.classList.add('loaded'); });

  // Reveal-on-scroll
  var revealEls = document.querySelectorAll('[data-reveal]');
  if (reduce || !('IntersectionObserver' in window)) {
    revealEls.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  // Scroll progress bar, sticky-nav shadow and hero parallax (one rAF-throttled handler)
  var bar = document.querySelector('.scroll-progress');
  var nav = document.querySelector('.navbar');
  var parallax = reduce ? [] : document.querySelectorAll('[data-parallax]');
  var ticking = false;
  function onScroll() {
    var y = window.scrollY;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar) bar.style.transform = 'scaleX(' + (max > 0 ? y / max : 0) + ')';
    if (nav) nav.classList.toggle('scrolled', y > 10);
    parallax.forEach(function (el) {
      el.style.setProperty('--py', (y * parseFloat(el.dataset.parallax)).toFixed(1) + 'px');
    });
    ticking = false;
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { requestAnimationFrame(onScroll); ticking = true; }
  }, { passive: true });
  onScroll();

  // Cursor-following spotlight on cards (pointer devices only)
  if (!reduce && window.matchMedia('(hover: hover)').matches) {
    document.querySelectorAll('.spotlight').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        card.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });
  }

  // Close the mobile menu after choosing a link
  var toggle = document.getElementById('nav-toggle');
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    a.addEventListener('click', function () { if (toggle) toggle.checked = false; });
  });

  // Auto-dismiss flash messages
  document.querySelectorAll('.flash').forEach(function (f) {
    setTimeout(function () { f.classList.add('flash-out'); }, 6000);
  });
})();
