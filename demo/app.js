/* Home page tables, filled from GET /api/v1/users/:id/profile for the connected wallet. */
(function () {
  var API = (window.AXCEL_API || "http://127.0.0.1:3000") + "/api/v1";
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); };
  var money = function (n) { return "$" + (Math.round(Number(n) * 100) / 100).toLocaleString(); };
  var short = function (h) { return h ? String(h).slice(0, 6) + "…" + String(h).slice(-4) : "none"; };
  var time = function (ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  var effect = function (n) { var v = Math.round(n * 100) / 100; return (v > 0 ? "+" : "") + v.toFixed(2); };

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function userId() {
    var w = load("axcel.wallet");
    return w ? (load("axcel.users") || {})[w.address] || null : null;
  }

  function note(text) { $("dash-note").textContent = text; }

  function scoreRows(terms) {
    var volume = Math.log(1 + terms.P_A + 0.25 * terms.P_C);
    var volEffect = 0.9 * volume;
    var base = terms.P_A + 0.25 * terms.P_C;
    var agentEffect = base > 0 ? volEffect * terms.P_A / base : 0;
    var chainEffect = volEffect - agentEffect;
    var rows = [
      ["Agent purchases", terms.P_A.toFixed(2), agentEffect],
      ["Chain payments", terms.P_C.toFixed(2), chainEffect],
      ["On-time repayments", Math.round(terms.R * 100) + "%", 1.5 * terms.R],
      ["Merchants", terms.D.toFixed(2), 0.8 * terms.D],
      ["Account age", Math.round(terms.A * 104) + " weeks", 0.5 * terms.A],
      ["Disputes", terms.C.toFixed(2), -1.2 * terms.C],
      ["Late payments", terms.L.toFixed(2), -1.5 * terms.L],
      ["Utilization", Math.round(terms.U * 100) + "%", -0.8 * terms.U]
    ];
    return rows.map(function (r) {
      return "<tr><td>" + r[0] + '</td><td class="num">' + r[1] + '</td><td class="num">' + effect(r[2]) + "</td></tr>";
    }).join("");
  }

  function render(p) {
    var score = p.score || {};
    var tier = score.tier ? " · tier " + score.tier : "";
    var nets = p.networks ? " · " + p.networks.history + " history, " + p.networks.credit + " credit" : "";
    note("Score " + (score.value == null ? "—" : Math.round(score.value)) + tier + nets);

    $("score-rows").innerHTML = score.terms ? scoreRows(score.terms) : '<tr><td colspan="3" class="small">No score yet.</td></tr>';

    var agents = p.agents || [];
    var labels = {};
    $("agent-rows").innerHTML = agents.length ? agents.map(function (a) {
      labels[a.id] = a.label;
      var live = a.status === "active";
      return "<tr><td>" + esc(a.label) + "</td><td>" + (a.mode === "autonomous" ? "Autonomous" : "Immediate") + "</td>" +
        '<td class="num">' + money(a.budgetUsd) + '</td><td class="num">' + money(a.spentUsd) + "</td>" +
        '<td class="status"><span class="mark ' + (live ? "ok" : "bad") + '"></span>' + (live ? "Active" : "Revoked") + "</td>" +
        '<td class="num">' + (live ? '<button class="btn small-btn" type="button" data-revoke="' + esc(a.id) + '">Revoke</button>' : "") + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="small">No agents yet.</td></tr>';

    var rows = [];
    (p.pending || []).forEach(function (x) {
      if (x.state === "paid") return;
      var bad = x.state === "declined" || x.state === "stranded";
      rows.push({ ts: x.createdAt, html: "<tr" + (bad ? ' class="refused"' : "") + "><td>" + time(x.createdAt) + "</td><td>" + esc(labels[x.agentId] || x.agentId) + "</td><td>" + esc(x.merchantId) + '</td><td class="num">' + money(x.amountCents / 100) + '</td><td class="mono">' + short(x.viHash) + '</td><td class="status' + (bad ? " refused" : "") + '"><span class="mark ' + (bad ? "bad" : "due") + '"></span>' + esc(x.state) + "</td></tr>" });
    });
    (p.purchases || []).forEach(function (x) {
      rows.push({ ts: x.ts, html: "<tr><td>" + time(x.ts) + "</td><td>" + esc(labels[x.agentId] || x.agentId) + "</td><td>" + esc(x.merchant) + '</td><td class="num">' + money(x.amount) + '</td><td class="mono">' + short(x.txHash) + '</td><td class="status"><span class="mark ok"></span>Settled</td></tr>' });
    });
    rows.sort(function (a, b) { return b.ts - a.ts; });
    $("purchases").innerHTML = rows.length ? rows.map(function (r) { return r.html; }).join("") : '<tr><td colspan="6" class="small">No purchases yet.</td></tr>';

    var paid = (p.breakdown || []).filter(function (c) { return c.type === "repayment"; });
    var open = (p.loans || []).filter(function (l) { return l.state && !l.closedAt; })[0];
    var schedule = paid.map(function (c) {
      return "<tr><td>" + time(c.ts) + '</td><td class="num">—</td><td class="status"><span class="mark ok"></span>' + esc(c.note || "Paid") + "</td><td></td></tr>";
    });
    if (open) {
      var due = open.state.nextPaymentDueDate ? new Date((open.state.nextPaymentDueDate + 946684800) * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : "Next";
      var each = open.state.paymentsRemaining ? open.state.principalOutstanding / open.state.paymentsRemaining : open.state.principalOutstanding;
      schedule.push('<tr data-next><td>' + due + '</td><td class="num">' + money(each) + '</td><td class="status"><span class="mark due"></span>Due</td><td class="num"><button class="btn small-btn primary" type="button" data-pay>Pay installment</button></td></tr>');
    }
    $("schedule").innerHTML = schedule.length ? schedule.join("") : '<tr><td colspan="4" class="small">No loan yet.</td></tr>';
    $("payoff").disabled = !open;
  }

  function refresh() {
    var id = userId();
    if (!load("axcel.wallet")) { note("Connect your wallet to load your score."); return; }
    if (!id) { note("This wallet has no profile yet. Get your score first."); return; }
    note("Loading your score…");
    fetch(API + "/users/" + id + "/profile").then(function (res) {
      return res.json().then(function (p) { if (!res.ok) throw new Error(p.error || "HTTP " + res.status); return p; });
    }).then(render, function (err) {
      note(/fetch/i.test(err.message) ? "The AXCEL service isn't running (npm run api)." : "Couldn't load your score: " + err.message);
    });
  }

  function repay(full) {
    var id = userId();
    if (!id) { note("Get your score before repaying."); return; }
    $("payoff").disabled = true;
    fetch(API + "/lending/repay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(full ? { userId: id, full: true } : { userId: id })
    }).then(function (res) {
      return res.json().then(function (body) { if (!res.ok) throw new Error(body.error || "HTTP " + res.status); return body; });
    }).then(function (body) {
      note("Repaid " + money(body.paid) + ". Score " + (body.score == null ? "—" : Math.round(body.score)) + ".");
      refresh();
    }, function (err) {
      note("Repayment failed: " + err.message);
      $("payoff").disabled = false;
    });
  }

  $("agent-rows").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-revoke]");
    if (!btn) return;
    if (!confirm("Revoke this agent? It can't spend again. Its history stays on your score.")) return;
    btn.disabled = true;
    fetch(API + "/agents/" + encodeURIComponent(btn.dataset.revoke), { method: "DELETE" }).then(function (res) {
      return res.json().then(function (body) { if (!res.ok) throw new Error(body.error || "HTTP " + res.status); });
    }).then(refresh, function (err) { btn.disabled = false; note("Couldn't revoke: " + err.message); });
  });

  $("schedule").addEventListener("click", function (e) {
    if (e.target.closest("[data-pay]")) repay(false);
  });
  $("payoff").addEventListener("click", function () { repay(true); });

  document.addEventListener("axcel:wallet", refresh);
  refresh();
})();
