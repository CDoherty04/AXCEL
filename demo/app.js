/* Mock behavior only. All numbers are sample data until the backend replaces it. */
(function () {
  var limit = 250, s1 = 110, s2 = 70, score = 610;
  var $ = function (id) { return document.getElementById(id); };
  var revoked = [false, false];

  function render() {
    $("used").textContent = "$" + (s1 + s2);
    $("limit").textContent = limit;
    $("sp1").textContent = "$" + s1;
    $("sp2").textContent = "$" + s2;
    $("bar1").style.width = (s1 / limit * 100) + "%";
    $("bar2").style.width = (s2 / limit * 100) + "%";
    $("score").textContent = score;
    $("tier").textContent = score >= 700 ? "Tier A" : "Tier B";
  }

  function row(cls, agent, merchant, amount, hash, status, statusCls, mark) {
    var tr = document.createElement("tr");
    tr.className = "new " + cls;
    tr.innerHTML = "<td>now</td><td>" + agent + "</td><td>" + merchant +
      '</td><td class="num">$' + amount + '</td><td class="mono">' + hash +
      '</td><td class="status ' + statusCls + '"><span class="mark ' + mark + '"></span>' + status + "</td>";
    $("purchases").insertBefore(tr, $("purchases").firstChild);
  }

  function refuse(agent, merchant, amount, reason) {
    row("refused", agent, merchant, amount, "none", "Refused: " + reason, "refused", "bad");
  }

  $("settle").addEventListener("click", function () {
    if (revoked[0]) { refuse("Shopper", "Paperly", 20, "revoked"); return; }
    if (s1 + s2 + 20 > limit) { refuse("Shopper", "Paperly", 20, "over limit"); return; }
    s1 += 20; render();
    row("", "Shopper", "Paperly", 20,
      "C3" + Math.floor(Math.random() * 90 + 10) + "…E7" + Math.floor(Math.random() * 90 + 10),
      "Settled", "", "ok");
  });

  $("refuse").addEventListener("click", function () {
    refuse("Shopper", "Gearhouse", 400, "over limit");
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-revoke]"), function (btn, i) {
    btn.addEventListener("click", function () {
      revoked[i] = true;
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
    s1 = 0; s2 = 0; score = 724; limit = 1000;
    render();
    this.disabled = true;
  });

  render();
})();
