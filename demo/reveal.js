/* Scroll-linked reveal: each section's heading rule draws across and its details rise into place
   in step with the scroll position, so scrolling back up reverses it. */
(function () {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.documentElement.classList.add("js");

  var RISE = 40;     // px an item travels as it settles
  var START = 0.98;  // item starts moving when its top reaches this share of the viewport height
  var SPAN = 0.32;   // ...and is fully in place after this share more

  var items = [], rules = [];
  Array.prototype.forEach.call(document.querySelectorAll(".split"), function (sec) {
    var h = sec.querySelector("h2.sec");
    if (h) rules.push(h);
    Array.prototype.forEach.call(sec.querySelectorAll(".split-copy > p, thead tr, tbody tr, .after"), function (el) {
      el.classList.add("reveal");
      el._dy = 0;
      items.push(el);
    });
  });

  function ease(t) { return 1 - Math.pow(1 - t, 3); }
  function progress(top, vh) {
    var t = (vh * START - top) / (vh * SPAN);
    return t <= 0 ? 0 : t >= 1 ? 1 : t;
  }

  var queued = false;
  function update() {
    queued = false;
    var vh = window.innerHeight;
    items.forEach(function (el) {
      // Measure where the item sits without the offset we applied last frame.
      var t = ease(progress(el.getBoundingClientRect().top - el._dy, vh));
      el._dy = RISE * (1 - t);
      el.style.opacity = t;
      el.style.transform = t === 1 ? "" : "translateY(" + el._dy.toFixed(1) + "px) scale(" + (0.97 + 0.03 * t).toFixed(3) + ")";
    });
    rules.forEach(function (h) {
      h.style.setProperty("--p", ease(progress(h.getBoundingClientRect().top, vh)).toFixed(3));
    });
  }
  function queue() { if (!queued) { queued = true; requestAnimationFrame(update); } }

  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  update();
})();
