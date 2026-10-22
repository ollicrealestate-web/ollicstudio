// Reveals sections as they scroll into view. Only runs when motion is allowed; the
// page is fully readable without it (the class is added in <head> only in that case).
(function () {
  if (!document.documentElement.classList.contains('js-motion')) return;
  var items = document.querySelectorAll('.reveal');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var el = e.target, i = Array.prototype.indexOf.call(el.parentNode.children, el);
      el.style.transitionDelay = Math.min(i, 6) * 60 + 'ms';
      el.classList.add('in'); io.unobserve(el);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  items.forEach(function (el) { io.observe(el); });
  // never leave content hidden if an observer callback is missed
  setTimeout(function () { items.forEach(function (el) { el.classList.add('in'); }); }, 4000);
})();
