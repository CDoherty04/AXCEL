/* Mock behavior for the home page sample tables. The live score card is on get-score.html. */
(function () {
  var s1 = 110, s2 = 70;
  var $ = function (id) { return document.getElementById(id); };

  function render() {
    $("sp1").textContent = "$" + s1;
    $("sp2").textContent = "$" + s2;
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-revoke]"), function (btn) {
    btn.addEventListener("click", function () {
      var st = btn.closest("tr").querySelector("[data-status]");
      st.innerHTML = '<span class="mark bad"></span><span>Revoked</span>';
      btn.disabled = true;
    });
  });

  function markPaid(tr) {
    tr.querySelector(".status").innerHTML = '<span class="mark ok"></span>Paid';
    tr.lastElementChild.innerHTML = "";
    tr.removeAttribute("data-next");
  }

  $("schedule").addEventListener("click", function (e) {
    if (!e.target.closest("[data-pay]")) return;
    var tr = $("schedule").querySelector("[data-next]");
    markPaid(tr);
    var next = tr.nextElementSibling;
    if (next) {
      next.setAttribute("data-next", "");
      next.querySelector(".status").innerHTML = '<span class="mark due"></span>Due soon';
      next.lastElementChild.innerHTML = '<button class="btn small-btn primary" type="button" data-pay>Pay installment</button>';
    }
  });

  $("payoff").addEventListener("click", function () {
    Array.prototype.forEach.call($("schedule").children, function (tr) {
      if (!tr.querySelector(".mark.ok")) markPaid(tr);
    });
    s1 = 0; s2 = 0;
    render();
    this.disabled = true;
  });

  render();
})();
