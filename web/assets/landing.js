// Home page motion. Everything answers the visitor (pointer, keys, scroll); with reduced motion
// asked for, the page is static and fully readable (js-motion is only set when motion is allowed).
(function () {
  var motion = document.documentElement.classList.contains('js-motion');

  // the render reveal: a line of light follows the pointer, a finger or the arrow keys
  var stage = document.getElementById('stage');
  if (stage) {
    var range = stage.querySelector('input[type=range]');
    var set = function (pct) {
      pct = Math.max(0, Math.min(100, pct));
      stage.style.setProperty('--x', pct + '%');
      range.value = String(Math.round(pct));
      stage.querySelector('.tag.l').style.opacity = pct < 12 ? 0 : 1;
      stage.querySelector('.tag.r').style.opacity = pct > 88 ? 0 : 1;
    };
    var at = function (e) { var r = stage.getBoundingClientRect(); return (e.clientX - r.left) / r.width * 100; };
    var intro = null, user = false;
    var stop = function () { user = true; if (intro) cancelAnimationFrame(intro); };
    stage.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse' || stage.classList.contains('drag')) { stop(); set(at(e)); } });
    stage.addEventListener('pointerdown', function (e) { stop(); stage.classList.add('drag'); set(at(e)); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { stage.addEventListener(t, function () { stage.classList.remove('drag'); }); });
    range.addEventListener('input', function () { stop(); set(Number(range.value)); });
    // the opening: the light sweeps once from the line drawing to the render, then rests
    if (motion) {
      set(100);
      var t0 = null, D = 2600;
      var ease = function (k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
      var step = function (now) {
        if (user) return;
        if (t0 === null) t0 = now;
        var k = Math.min(1, (now - t0) / D);
        set(k < 0.62 ? 100 - 92 * ease(k / 0.62) : 8 + 42 * ease((k - 0.62) / 0.38));
        if (k < 1) intro = requestAnimationFrame(step);
      };
      setTimeout(function () { if (!user) intro = requestAnimationFrame(step); }, 650);
    } else set(50);
  }

  // scroll: the header's red hairline, the gentle zoom of the hero picture, the process line
  var head = document.querySelector('.site-head'), steps = document.getElementById('steps');
  var lit = steps ? steps.querySelectorAll('.step') : [];
  var ticking = false;
  var onScroll = function () {
    ticking = false;
    var doc = document.documentElement, max = doc.scrollHeight - innerHeight;
    if (head) head.style.setProperty('--scroll', max > 0 ? (scrollY / max).toFixed(4) : 0);
    if (!motion) return;
    if (stage) stage.style.setProperty('--zoom', (1 + Math.min(scrollY, 600) / 600 * 0.06).toFixed(4));
    if (steps) {
      var r = steps.getBoundingClientRect();
      var f = Math.max(0, Math.min(1, (innerHeight * 0.8 - r.top) / (r.height + innerHeight * 0.35)));
      steps.style.setProperty('--fill', f.toFixed(4));
      lit.forEach(function (el, i) { el.classList.toggle('lit', f >= i / Math.max(1, lit.length - 1) - 0.02); });
    }
  };
  addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  addEventListener('resize', onScroll);
  onScroll();
  if (!motion) lit.forEach(function (el) { el.classList.add('lit'); });

  // the final call: a red light follows the pointer
  var cta = document.getElementById('ctaFinal');
  if (cta && motion) cta.addEventListener('pointermove', function (e) {
    var r = cta.getBoundingClientRect();
    cta.style.setProperty('--mx', (e.clientX - r.left) + 'px'); cta.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });

  // sections are uncovered as they scroll into view
  if (!motion) return;
  var items = document.querySelectorAll('.reveal');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
  items.forEach(function (el) { io.observe(el); });
  // never leave content hidden if an observer callback is missed
  setTimeout(function () { items.forEach(function (el) { el.classList.add('in'); }); }, 5000);
})();
