// Shared touches for every page. When text is selected (outside fields), a small Copy button
// appears above it; it copies the selection and says so. Hidden again when the selection ends.
(function () {
  if (!navigator.clipboard || !window.getSelection) return;
  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'sel-copy'; btn.textContent = 'Copy'; btn.setAttribute('aria-hidden', 'true'); btn.tabIndex = -1;
  document.body.appendChild(btn);
  var timer = 0;
  var hide = function () { btn.classList.remove('on'); };
  var place = function () {
    var sel = getSelection(), text = sel ? String(sel).trim() : '';
    var active = document.activeElement;
    if (!text || sel.rangeCount === 0 || (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) { hide(); return; }
    var r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) { hide(); return; }
    btn.textContent = 'Copy';
    btn.style.left = Math.max(48, Math.min(innerWidth - 48, r.left + r.width / 2)) + 'px';
    btn.style.top = Math.max(52, r.top) + 'px';
    btn.classList.add('on');
  };
  document.addEventListener('selectionchange', function () { clearTimeout(timer); timer = setTimeout(place, 120); });
  addEventListener('scroll', hide, { passive: true });
  btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });   // keep the selection
  btn.addEventListener('click', function () {
    var text = String(getSelection()).trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { getSelection().removeAllRanges(); hide(); }, 700);
    }, hide);
  });
})();
