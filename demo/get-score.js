/* Get your score: each terminal shows the exact API call its form will make (curl), runs it against
   the AXCEL API (npm run api) and prints the response. */
(function () {
  var BASE = (window.AXCEL_API || "http://127.0.0.1:3000") + "/api/v1";
  var $ = function (id) { return document.getElementById(id); };

  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

  // One profile per wallet address: axcel.users maps address -> USER_ID.
  function users() { try { return JSON.parse(load("axcel.users")) || {}; } catch (e) { return {}; } }
  function wallet() { try { return JSON.parse(load("axcel.wallet")); } catch (e) { return null; } }
  function remember(address, id) {
    var m = users();
    if (id) m[address] = id; else delete m[address];
    save("axcel.users", JSON.stringify(m));
  }
  var w0 = wallet();
  var userId = w0 ? users()[w0.address] || null : load("axcel.userId");
  var uid = function () { return userId || "$USER_ID"; };

  function showProfile() {
    $("profile-line").hidden = !userId;
    $("profile-id").textContent = userId || "";
  }

  // ---- curl rendering ----
  function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  function curl(req) {
    var lines = ["curl -s -X " + req.method + " " + BASE + req.path];
    if (req.body) {
      lines.push("  -H 'Content-Type: application/json'");
      lines.push("  -d " + q(JSON.stringify(req.body)));
    }
    return lines.join(" \\\n");
  }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function renderCmd(form) {
    var reqs = specs[form.id](form);
    form.querySelector(".term-cmd").innerHTML = reqs.map(function (r) {
      return (r.note ? '<span class="t-dim"># ' + esc(r.note) + "</span>\n" : "") + '<span class="t-prompt">$</span> ' + esc(curl(r));
    }).join("\n\n");
  }
  function renderAll() { Object.keys(specs).forEach(function (id) { renderCmd($(id)); }); }

  // ---- terminal output ----
  function out(form) { return form.querySelector(".result"); }
  function print(form, text, cls) {
    var line = document.createElement("span");
    line.className = cls || "";
    line.textContent = text + "\n";
    out(form).appendChild(line);
  }

  function call(form, req) {
    return fetch(BASE + req.path, {
      method: req.method,
      headers: req.body ? { "Content-Type": "application/json" } : {},
      body: req.body ? JSON.stringify(req.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) {}
        print(form, "HTTP " + res.status, res.ok ? "t-ok" : "t-err");
        if (txt) print(form, JSON.stringify(data, null, 2), "t-json");
        if (!res.ok) throw new Error(data.error || "request failed");
        return data;
      });
    }, function () {
      var host = BASE.replace(/^https?:\/\//, "").split("/")[0].split(":");
      print(form, "curl: (7) Failed to connect to " + host[0] + " port " + (host[1] || 80) + ": Connection refused", "t-err");
      throw new Error("The AXCEL service isn't running yet. Start it with: npm run api");
    });
  }

  // ---- what each form sends ----
  var list = function (v) { return v.split(",").map(function (s) { return s.trim(); }).filter(Boolean); };
  var cents = function (v) { return Math.round(parseFloat(v || 0) * 100); };
  var specs = {
    "f-link": function (f) {
      var reqs = [];
      if (!userId) reqs.push({ method: "POST", path: "/users", body: {}, note: "Create your profile; the reply's id is your USER_ID" });
      reqs.push({ method: "POST", path: "/users/" + uid() + "/link/challenge", body: { mainnetAccount: f.mainnet.value.trim() }, note: "Get a challenge to sign" });
      return reqs;
    },
    "f-confirm": function (f) {
      return [{ method: "POST", path: "/users/" + uid() + "/link/confirm", body: {
        mainnet: { signature: f.mSig.value.trim(), publicKey: f.mPub.value.trim() },
        devnet: { signature: f.dSig.value.trim(), publicKey: f.dPub.value.trim() }
      } }];
    },
    "f-kya": function (f) {
      return [{ method: "POST", path: "/users/" + uid() + "/kya", body: {
        legalName: f.legalName.value.trim(), country: f.country.value.trim(), documentId: f.documentId.value.trim()
      } }];
    },
    "f-score": function () {
      return [{ method: "POST", path: "/users/" + uid() + "/cold-start" }];
    },
    "f-borrow": function (f) {
      var body = { userId: uid() };
      if (f.amount.value) body.amount = parseFloat(f.amount.value);
      return [{ method: "POST", path: "/lending/borrow", body: body }];
    },
    "f-agent": function (f) {
      return [{ method: "POST", path: "/users/" + uid() + "/agents", body: {
        label: f.label.value.trim(),
        mode: f.mode.value,
        maxCents: cents(f.max.value),
        budgetCents: cents(f.budget.value),
        merchantIds: list(f.merchants.value),
        items: list(f.items.value).map(function (t) { return { id: t.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: t }; })
      } }];
    },
    "f-repay": function (f) {
      var body = { userId: uid() };
      if (f.full.checked) body.full = true;
      else if (f.amount.value) body.amount = parseFloat(f.amount.value);
      return [{ method: "POST", path: "/lending/repay", body: body }];
    }
  };

  // What to do with a successful reply, and the line to print after it.
  var done = {
    "f-link": function (f, r) {
      $("challenge").textContent = r.message;
      $("f-confirm-term").hidden = false;
      return "Challenge ready. Sign it with both keys below.";
    },
    "f-confirm": function () { return "Account linked."; },
    "f-kya": function () { return "Identity verified."; },
    "f-score": function (f, r) {
      $("score-num").textContent = Math.round(r.score);
      $("score-tier").textContent = "Tier " + r.tier;
      $("score-out").hidden = false;
      return "Score ready.";
    },
    "f-borrow": function (f, r) { return "Borrowed $" + r.principal + "."; },
    "f-agent": function () { return "Agent added."; },
    "f-repay": function (f) { return f.full.checked ? "Paid off. Nice work." : "Payment made."; }
  };

  Object.keys(specs).forEach(function (id) {
    var form = $(id);
    form.addEventListener("input", function () { renderCmd(form); });
    form.addEventListener("change", function () { renderCmd(form); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("button[type=submit]");
      out(form).textContent = "";
      if (id !== "f-link" && !userId) { print(form, "error: no USER_ID yet. Link your account first (step 1).", "t-err"); return; }
      btn.disabled = true;
      var reqs = specs[id](form), i = 0, last;
      // Run the calls in order. Creating the profile sets USER_ID, so rebuild the rest with it filled in.
      function next() {
        if (i >= reqs.length) return Promise.resolve();
        var req = reqs[i++];
        print(form, "$ curl -X " + req.method + " " + BASE + req.path, "t-dim");
        return call(form, req).then(function (r) {
          last = r;
          if (req.path === "/users") {
            userId = r.id; save("axcel.userId", userId); showProfile();
            if (form.mainnet.value.trim()) remember(form.mainnet.value.trim(), userId);
            reqs = specs[id](form); i = 0;
          }
          return next();
        });
      }
      next()
        .then(function () { print(form, "# " + done[id](form, last), "t-ok"); refreshCard(); })
        .catch(function (err) { print(form, "error: " + err.message, "t-err"); })
        .then(function () { btn.disabled = false; renderAll(); });
    });
  });

  $("reset").addEventListener("click", function () {
    var w = wallet();
    if (w) remember(w.address, null);
    userId = null; save("axcel.userId", null); showProfile();
    $("f-confirm-term").hidden = true; $("score-out").hidden = true;
    renderAll(); refreshCard();
  });

  // ---- score card: the connected wallet's live profile ----
  function money(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(); }
  function card(state) {
    $("card-score").textContent = state.score == null ? "—" : Math.round(state.score);
    $("card-tier").textContent = state.tier ? "Tier " + state.tier : "No tier yet";
    $("card-used").textContent = money(state.used || 0);
    $("card-limit").textContent = (state.limit || 0).toLocaleString();
    $("card-note").textContent = state.note || "";
    $("card-note").hidden = !state.note;
    $("card-connect").hidden = !!wallet();
    $("card-refresh").hidden = !wallet() || !userId;
    var agents = state.agents || [], limit = state.limit || 0;
    $("card-bar").innerHTML = agents.map(function (a, i) {
      var pct = limit ? Math.min(100, a.spentUsd / limit * 100) : 0;
      return '<span class="seg c' + (i % 4) + '" style="width:' + pct + '%"></span>';
    }).join("");
    $("card-legend").innerHTML = agents.map(function (a, i) {
      return '<span class="c' + (i % 4) + '"><i></i>' + esc(a.label) + "</span>";
    }).join("");
  }

  function refreshCard() {
    var w = wallet();
    if (!w) return card({ note: "Connect your wallet to see your score." });
    if (!userId) return card({ note: "Wallet " + w.address.slice(0, 5) + "…" + w.address.slice(-4) + " has no AXCEL profile yet. Link it in step 1 below." });
    card({ note: "Loading your profile…" });
    fetch(BASE + "/users/" + userId + "/profile").then(function (res) {
      return res.json().then(function (p) { if (!res.ok) throw new Error(p.error || "HTTP " + res.status); return p; });
    }).then(function (p) {
      var c = p.credit || {};
      card({
        score: p.score && p.score.value, tier: (p.score && p.score.tier) || c.tier,
        used: c.spendOutstanding, limit: c.creditLine,
        agents: (p.agents || []).filter(function (a) { return a.status !== "revoked"; })
      });
    }, function (err) {
      card({ note: /fetch/i.test(err.message) ? "The AXCEL service isn't running, so your score can't load yet (npm run api)." : "Couldn't load your profile: " + err.message });
    });
  }

  $("card-connect").addEventListener("click", function (e) {
    e.stopPropagation();
    $("wallet-btn").click();
  });
  $("card-refresh").addEventListener("click", refreshCard);

  // Service status
  fetch(BASE + "/health").then(function (r) { if (!r.ok) throw 0; }).then(function () {
    $("conn").querySelector(".mark").className = "mark ok";
    $("conn-text").textContent = "Connected to the AXCEL service.";
  }, function () {
    $("conn").querySelector(".mark").className = "mark due";
    $("conn-text").textContent = "Not connected yet. The commands will run once the service is up (npm run api).";
  });

  // A connected wallet fills in the Mainnet address (step 1) unless you've typed one.
  function useWallet(w) {
    var input = $("mainnet");
    if (w && w.address && (!input.value || input.dataset.fromWallet)) {
      input.value = w.address;
      input.dataset.fromWallet = "1";
      renderCmd($("f-link"));
    }
  }
  $("mainnet").addEventListener("input", function () { delete this.dataset.fromWallet; });
  document.addEventListener("axcel:wallet", function (e) {
    // Switching wallets switches profiles.
    userId = e.detail ? users()[e.detail.address] || null : load("axcel.userId");
    $("f-confirm-term").hidden = true; $("score-out").hidden = true;
    useWallet(e.detail); showProfile(); renderAll(); refreshCard();
  });
  useWallet(w0);

  showProfile();
  renderAll();
  refreshCard();
})();
