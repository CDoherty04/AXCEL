/* Agent dashboard: the connected wallet's agents, purchases and alerts (AXCEL API, npm run api), plus the
   Agent Pay for Machines paywall. Every action is a terminal that shows its axcel command. */
(function () {
  var API = (window.AXCEL_API || "http://127.0.0.1:3000") + "/api/v1";
  var $ = function (id) { return document.getElementById(id); };
  var esc = AxcelTerm.esc;
  var sh = AxcelTerm.sh;
  var flags = AxcelTerm.flags;

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // Same wallet -> profile mapping as Get your score.
  function currentUser() {
    var w = load("axcel.wallet");
    return w ? (load("axcel.users") || {})[w.address] || null : null;
  }
  // The cold-start preview from Get your score, for the connected wallet only.
  function preview() {
    var w = load("axcel.wallet"), pv = load("axcel.preview");
    return w && pv && pv.account && pv.account.toLowerCase() === w.address.toLowerCase() ? pv : null;
  }
  var userId = currentUser();
  var uid = function () { return userId || "$USER_ID"; };
  var needUser = function () { return userId ? null : "no USER_ID. Connect your wallet and link it on Get your score first."; };

  var money = function (n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(); };
  var short = function (h) { return h ? h.slice(0, 6) + "…" + h.slice(-4) : "none"; };
  var time = function (ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  var list = function (v) { return v.split(",").map(function (s) { return s.trim(); }).filter(Boolean); };
  var cents = function (v) { return Math.round(parseFloat(v || 0) * 100); };
  var slug = function (t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-"); };

  // ---- profile -> tiles, fleet, activity ----
  var agents = [];

  function note(text) { $("dash-note").textContent = text; $("dash-note").hidden = !text; }

  function renderProfile(p) {
    agents = p ? p.agents || [] : [];
    var active = agents.filter(function (a) { return a.status === "active"; });
    var spent = active.reduce(function (s, a) { return s + a.spentUsd; }, 0);
    var budget = active.reduce(function (s, a) { return s + a.budgetUsd; }, 0);
    $("st-agents").textContent = p ? active.length : "—";
    $("st-spent").textContent = p ? money(spent) + " / " + money(budget) : "—";
    // Without a profile yet, show the score previewed on Get your score (kept in this browser only).
    var pre = preview();
    $("st-credit").textContent = p && p.credit && (p.credit.creditLine || !pre) ? money(p.credit.available) : pre && pre.creditLine != null ? money(pre.creditLine) : "—";
    // The live score only replaces the previewed one once there is activity to change it.
    var hasActivity = p && ((p.purchases || []).length || (p.loans || []).length);
    var sc = p && p.score && (hasActivity || !pre) ? { value: p.score.value, tier: p.score.tier } : pre ? { value: pre.score, tier: pre.tier } : null;
    $("st-score").textContent = sc ? Math.round(sc.value) + (sc.tier ? " · " + sc.tier : "") : "—";

    $("fleet-rows").innerHTML = agents.length ? agents.map(function (a) {
      var live = a.status === "active";
      return "<tr><td>" + esc(a.label) + "</td><td>" + (a.mode === "autonomous" ? "Autonomous" : "Immediate") + "</td>" +
        '<td class="num">' + money(a.maxPerPurchaseUsd) + '</td><td class="num">' + money(a.spentUsd) + " of " + money(a.budgetUsd) + "</td>" +
        '<td class="num">' + a.purchases + '</td><td class="status"><span class="mark ' + (live ? "ok" : "bad") + '"></span>' + (live ? "Active" : "Revoked") + "</td>" +
        '<td class="num">' + (live ? '<button class="btn small-btn" type="button" data-revoke="' + esc(a.id) + '">Revoke</button>' : "") + "</td></tr>";
    }).join("") : '<tr><td colspan="7" class="small">No agents yet. Add one below.</td></tr>';

    $("b-agent").innerHTML = active.length
      ? active.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.label) + " (" + a.mode + ", up to " + money(a.maxPerPurchaseUsd) + ")</option>"; }).join("")
      : '<option value="">' + (p ? "No active agents. Add one above" : !load("axcel.wallet") ? "Connect your wallet first" : !userId ? "Add your first agent above" : "Couldn't load agents (is npm run api running?)") + "</option>";
    buy.render();
    $("r-agent").innerHTML = $("b-agent").innerHTML;
    renderRun();

    var label = {};
    agents.forEach(function (a) { label[a.id] = a.label; });
    var rows = [];
    (p ? p.pending || [] : []).forEach(function (x) {
      if (x.state === "paid") return;
      var bad = x.state === "declined" || x.state === "stranded";
      rows.push({ ts: x.createdAt, html: "<tr" + (bad ? ' class="refused"' : "") + "><td>" + time(x.createdAt) + "</td><td>" + esc(label[x.agentId] || x.agentId) + "</td><td>" + esc(x.merchantId) + '</td><td class="num">' + money(x.amountCents / 100) + '</td><td class="mono">' + short(x.viHash) + '</td><td class="status' + (bad ? " refused" : "") + '"><span class="mark ' + (bad ? "bad" : "due") + '"></span>' + esc(x.state[0].toUpperCase() + x.state.slice(1)) + (x.error ? ": " + esc(x.error) : "") + "</td></tr>" });
    });
    (p ? p.purchases || [] : []).forEach(function (x) {
      rows.push({ ts: x.ts, html: "<tr><td>" + time(x.ts) + "</td><td>" + esc(label[x.agentId] || x.agentId) + "</td><td>" + esc(x.merchant) + '</td><td class="num">' + money(x.amount) + '</td><td class="mono" title="' + esc(x.viHash) + '">' + short(x.viHash) + '</td><td class="status"><span class="mark ok"></span>Settled</td></tr>' });
    });
    rows.sort(function (a, b) { return b.ts - a.ts; });
    $("activity-rows").innerHTML = rows.length ? rows.map(function (r) { return r.html; }).join("") : '<tr><td colspan="6" class="small">No purchases yet.</td></tr>';

    var alerts = p ? p.alerts || [] : [];
    $("alerts-box").hidden = !alerts.length;
    $("alert-rows").innerHTML = alerts.map(function (a) {
      return '<tr class="refused"><td class="status refused"><span class="mark bad"></span>' + esc(a.reason) + "</td><td>" + esc(label[a.agentId] || a.agentId) + '</td><td class="mono">' + short(a.txHash) + "</td></tr>";
    }).join("");
  }

  function refresh() {
    userId = currentUser();
    [add, buy].forEach(function (t) { t.render(); });
    if (!load("axcel.wallet")) { renderProfile(null); return note("Connect your wallet to load your agents."); }
    if (!userId) { renderProfile(null); return note("This wallet has no AXCEL profile yet. Link it on Get your score first."); }
    note("Loading your agents…");
    fetch(API + "/users/" + userId + "/profile").then(function (res) {
      return res.json().then(function (p) { if (!res.ok) throw new Error(p.error || "HTTP " + res.status); return p; });
    }).then(function (p) { renderProfile(p); note(""); }, function (err) {
      renderProfile(null);
      note(/fetch/i.test(err.message) ? "The AXCEL service isn't running, so your agents can't load yet (npm run api)." : "Couldn't load your agents: " + err.message);
    });
  }

  // Revoke: removes the delegation, freezes the spending account and sweeps it back to you.
  $("fleet-rows").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-revoke]");
    if (!btn) return;
    var a = agents.filter(function (x) { return x.id === btn.dataset.revoke; })[0];
    if (!confirm("Revoke " + (a ? a.label : "this agent") + "? It can't spend again; its history stays in your score.")) return;
    btn.disabled = true;
    btn.textContent = "Revoking…";
    fetch(API + "/agents/" + encodeURIComponent(btn.dataset.revoke), { method: "DELETE" }).then(function (res) {
      return res.json().then(function (r) { if (!res.ok) throw new Error(r.error || "HTTP " + res.status); });
    }).then(refresh, function (err) { btn.disabled = false; btn.textContent = "Revoke"; alert("Couldn't revoke: " + err.message); });
  });
  $("refresh").addEventListener("click", refresh);

  // ---- merchants registered from this browser ----
  function merchants() { return load("axcel.merchants") || []; }
  function renderMerchants() {
    var m = merchants();
    // Registered merchants only feed the buy form's suggestions; registration stays in the API.
    $("merchant-ids").innerHTML = m.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + "</option>"; }).join("");
  }

  // ---- terminals ----
  // A wallet's profile is created with its first agent (same call as Get your score), which also verifies the
  // owner and registers a default merchant. After that, agents carry their own merchants and items.
  var add = AxcelTerm.mount({
    form: $("f-agent"), base: API,
    spec: function (f) {
      var max = cents(f.max.value), budget = cents(f.budget.value), limit = budget || max || 100000;
      var label = f.label.value.trim();
      var dollars = function (c) { var n = c / 100; return Number.isInteger(n) ? String(n) : n.toFixed(2); };
      if (!userId) {
        return [{
          method: "POST", path: "/agents/simple", body: { label: label, limitCents: limit, wallet: (load("axcel.wallet") || {}).address },
          cmd: "axcel agents add" + flags({ label: label, limit: dollars(limit) }),
          note: "First agent: creates your profile"
        }];
      }
      return [{
        method: "POST", path: "/users/" + userId + "/agents", body: {
          label: label, mode: f.mode.value, maxCents: max || limit, budgetCents: budget || limit, merchantIds: [], items: []
        },
        cmd: "axcel agents add" + flags({
          user: userId, label: label, mode: f.mode.value,
          max: dollars(max || limit), budget: dollars(budget || limit)
        })
      }];
    },
    check: function () { return load("axcel.wallet") ? null : "connect your wallet first."; },
    done: function (f, r) {
      if (r && r.userId && !userId) {
        var w = load("axcel.wallet");
        var users = load("axcel.users") || {};
        if (w) { users[w.address] = r.userId; save("axcel.users", users); }
        userId = r.userId;
      }
      var limit = r.maxCents != null ? r.maxCents / 100 : "";
      var budget = r.budgetCents != null ? r.budgetCents / 100 : "";
      return [
        "Agent " + r.label + " added",
        (r.mode ? r.mode[0].toUpperCase() + r.mode.slice(1) : "Agent") +
          (limit !== "" ? " · " + money(limit) + " per buy" : "") +
          (budget !== "" ? " · " + money(budget) + " budget" : ""),
        r.pot && r.pot.account ? "Spending account " + short(r.pot.account) : ""
      ];
    },
    after: refresh
  });

  var buy = AxcelTerm.mount({
    form: $("f-buy"), base: API,
    check: function (f) { return needUser() || (!f.agent.value ? "pick an agent (add one above first)." : null); },
    spec: function (f) {
      var t = f.item.value.trim();
      var agent = f.agent.value || "$AGENT_ID";
      var merchant = f.merchant.value.trim();
      return [{
        method: "POST", path: "/payments/agentic/demo", body: {
          agentId: agent, merchantId: merchant, item: { id: slug(t), title: t }, amountCents: cents(f.amount.value)
        },
        cmd: "axcel buy" + flags({ agent: agent, merchant: merchant, item: t, amount: f.amount.value }),
        note: "The service builds the Verifiable Intent chain, then settles it"
      }];
    },
    done: function (f, r) {
      if (!r || !r.txHash) return ["Submitted · settlement still finishing", "Refresh to see its state"];
      return [
        "Settled" + (r.amount != null ? " " + money(r.amount) : ""),
        "XRPL " + short(r.txHash) + (r.score != null ? " · score " + Math.round(r.score) : "")
      ];
    },
    after: refresh
  });

  // ---- Claude-driven agent runs ----
  var runTimer = null;
  function runCommand() {
    var f = $("f-run");
    return "axcel agents run " + sh(f.agent.value || "$AGENT_ID") + flags({ task: f.task.value.trim() || "…" });
  }
  function renderRun() {
    $("f-run").querySelector(".term-cmd").innerHTML = '<span class="t-prompt">$</span> ' + esc(runCommand());
  }
  $("f-run").addEventListener("input", renderRun);
  $("f-run").addEventListener("change", renderRun);
  function logStep(s) {
    var cls = { error: "t-err", result: "t-ok", final: "t-ok", thought: "t-dim", tool: "t-json" }[s.kind] || "";
    var line = document.createElement("span");
    line.className = cls;
    line.textContent = (s.kind === "tool" ? "$ " : s.kind === "final" ? "# " : "") + s.text + "\n";
    $("run-log").appendChild(line);
  }
  $("f-run").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target, btn = f.querySelector("button[type=submit]"), log = $("run-log");
    log.textContent = "";
    var problem = needUser() || (!f.agent.value ? "pick an agent (add one above first)." : null);
    if (problem) { logStep({ kind: "error", text: "error: " + problem }); return; }
    logStep({ kind: "tool", text: runCommand() });
    btn.disabled = true;
    function fail(msg) { logStep({ kind: "error", text: "error: " + msg }); btn.disabled = false; }
    fetch(API + "/agents/" + encodeURIComponent(f.agent.value) + "/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: f.task.value.trim() })
    }).then(function (res) {
      return res.json().then(function (r) { if (!res.ok) throw new Error(r.error || "HTTP " + res.status); return r; });
    }).then(function (run) {
      var seen = 0;
      (function poll() {
        fetch(API + "/runs/" + run.id).then(function (r) { return r.json(); }).then(function (r) {
          r.steps.slice(seen).forEach(logStep);
          seen = r.steps.length;
          if (r.state === "running") { runTimer = setTimeout(poll, 1000); return; }
          btn.disabled = false;
          refresh();
        }, function () { fail("lost contact with the service"); });
      })();
    }, function (err) { fail(/fetch/i.test(err.message) ? "The AXCEL service isn't running (npm run api)." : err.message); });
  });

  // Network housekeeping
  AxcelTerm.mount({
    form: $("f-reconcile"), base: API,
    spec: function () { return [{ method: "POST", path: "/payments/reconcile", cmd: "axcel reconcile" }]; },
    done: function (f, r) {
      var resumed = (r && r.resumed) || [];
      var stranded = (r && r.stranded) || [];
      return [
        "Resumed " + resumed.length + " · stranded " + stranded.length,
        resumed.length + stranded.length === 0 ? "Nothing was in flight." : ""
      ];
    },
    after: refresh
  });
  AxcelTerm.mount({
    form: $("f-netsettle"), base: API,
    spec: function (f) {
      return [{
        method: "POST", path: "/payments/network/settle", body: f.close.checked ? { close: true } : {},
        cmd: "axcel settle-channel" + flags({ close: f.close.checked })
      }];
    },
    done: function (f, r) {
      if (!r || r.settled === false) return ["Nothing to settle"];
      return [
        "Channel settled",
        r.payoutTx ? "Payout " + short(r.payoutTx) : (r.settlementTx ? "Tx " + short(r.settlementTx) : ""),
        r.closeTx ? "Channel closed" : ""
      ];
    }
  });

  AxcelTerm.mount({
    form: $("f-repay"), base: API,
    check: function () { return needUser(); },
    spec: function (f) {
      var body = { userId: uid() };
      if (f.full.checked) body.full = true;
      else if (f.amount.value) body.amount = parseFloat(f.amount.value);
      return [{
        method: "POST", path: "/lending/repay", body: body,
        cmd: "axcel repay" + flags({ user: uid(), amount: f.full.checked ? "" : f.amount.value, full: f.full.checked })
      }];
    },
    done: function (f, r) {
      var paid = r && r.paid != null ? money(r.paid) : (f.amount.value ? money(f.amount.value) : "");
      return [
        (f.full.checked || (r && r.loanClosed) ? "Paid off" : "Paid") + (paid ? " " + paid : ""),
        r && r.score != null ? "Score " + Math.round(r.score) + (r.tier ? " · Tier " + r.tier : "") : "",
        r && r.txHash ? "XRPL " + short(r.txHash) : ""
      ];
    },
    after: refresh
  });

  document.addEventListener("axcel:wallet", refresh);
  renderMerchants();
  renderRun();
  refresh();
})();
