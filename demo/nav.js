/* Banner menus (About, Get your score): each opens its links to the right on click. Only one is open at
   a time; they close on outside click, Escape or picking a link. */
(function () {
  var groups = Array.prototype.map.call(document.querySelectorAll(".about-btn"), function (btn) {
    return { btn: btn, menu: document.getElementById(btn.getAttribute("aria-controls")) };
  });
  if (!groups.length) return;

  function set(g, open) {
    g.menu.hidden = !open;
    g.btn.setAttribute("aria-expanded", String(open));
  }
  function closeAll(except) { groups.forEach(function (g) { if (g !== except) set(g, false); }); }

  groups.forEach(function (g) {
    g.btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = g.menu.hidden;
      closeAll(g);
      set(g, open);
    });
    g.menu.addEventListener("click", function (e) { if (e.target.closest("a")) set(g, false); });
  });

  document.addEventListener("click", function (e) {
    if (!groups.some(function (g) { return g.btn.parentNode.contains(e.target); })) closeAll();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    groups.forEach(function (g) { if (!g.menu.hidden) { set(g, false); g.btn.focus(); } });
  });
})();
