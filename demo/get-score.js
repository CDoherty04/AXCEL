/* Get your score: each terminal shows the axcel command its form will run, calls the AXCEL API
   (npm run api) and prints the response. */
(function () {
  var BASE = (window.AXCEL_API || "http://127.0.0.1:3000") + "/api/v1";
  var $ = function (id) { return document.getElementById(id); };
  var esc = AxcelTerm.esc;
  var flags = AxcelTerm.flags;

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
    if (!$("profile-line")) return;
    $("profile-line").hidden = !userId;
    $("profile-id").textContent = userId || "";
  }

  function renderCmd(form) {
    var reqs = specs[form.id](form);
    form.querySelector(".term-cmd").innerHTML = reqs.map(function (r) {
      return (r.note ? '<span class="t-dim"># ' + esc(r.note) + "</span>\n" : "") +
        '<span class="t-prompt">$</span> ' + esc(AxcelTerm.command(r));
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
      cache: "no-store",
      headers: req.body ? { "Content-Type": "application/json" } : {},
      body: req.body ? JSON.stringify(req.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) {}
        if (!res.ok) throw new Error(data.error || "request failed");
        return data;
      });
    }, function () {
      var host = BASE.replace(/^https?:\/\//, "").split("/")[0].split(":");
      print(form, "axcel: failed to connect to " + host[0] + " port " + (host[1] || 80) + ": Connection refused", "t-err");
      throw new Error("The AXCEL service isn't running yet. Start it with: npm run api");
    });
  }

  // ---- what each form sends ----
  var cents = function (v) { return Math.round(parseFloat(v || 0) * 100); };
  var money = function (n) { return "$" + (Math.round(Number(n) * 100) / 100).toLocaleString(); };
  var short = function (h) { return h ? String(h).slice(0, 6) + "…" + String(h).slice(-4) : "none"; };
  var specs = {
    "f-repay": function (f) {
      var body = { userId: uid() };
      if (f.full.checked) body.full = true;
      else if (f.amount.value) body.amount = parseFloat(f.amount.value);
      return [{
        method: "POST",
        path: "/lending/repay",
        body: body,
        cmd: "axcel repay" + flags({ user: uid(), amount: f.full.checked ? "" : f.amount.value, full: f.full.checked })
      }];
    }
  };

  var done = {
    "f-repay": function (f, r) {
      var paid = r && r.paid != null ? money(r.paid) : (f.amount.value ? money(f.amount.value) : "");
      return [
        (f.full.checked || (r && r.loanClosed) ? "Paid off" : "Paid") + (paid ? " " + paid : ""),
        r && r.score != null ? "Score " + Math.round(r.score) + (r.tier ? " · Tier " + r.tier : "") : "",
        r && r.txHash ? "XRPL " + short(r.txHash) : ""
      ];
    }
  };

  Object.keys(specs).forEach(function (id) {
    var form = $(id);
    form.addEventListener("input", function () { renderCmd(form); });
    form.addEventListener("change", function () { renderCmd(form); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("button[type=submit]");
      out(form).textContent = "";
      if (id === "f-repay" && !userId) { print(form, "error: add an agent on the agents dashboard first.", "t-err"); return; }
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Waiting…";
      form.setAttribute("aria-busy", "true");
      print(form, "waiting…", "t-wait");
      var reqs = specs[id](form), i = 0, last;
      // Run the calls in order. Creating the profile sets USER_ID, so rebuild the rest with it filled in.
      function next() {
        if (i >= reqs.length) return Promise.resolve();
        var req = reqs[i++];
        print(form, "$ " + AxcelTerm.command(req), "t-dim");
        return call(form, req).then(function (r) {
          last = r;
          if (req.path === "/agents/simple" && r.userId) {
            userId = r.userId; save("axcel.userId", userId); showProfile();
            var w = wallet();
            if (w) remember(w.address, userId);
          }
          return next();
        });
      }
      next()
        .then(function () { AxcelTerm.lines(form, done[id](form, last)); })
        .catch(function (err) { print(form, "error: " + err.message, "t-err"); })
        .then(function () {
          form.querySelectorAll(".result .t-wait").forEach(function (el) { el.remove(); });
          btn.disabled = false;
          btn.textContent = label;
          form.removeAttribute("aria-busy");
          renderAll();
        });
    });
  });

  if ($("reset")) $("reset").addEventListener("click", function () {
    var w = wallet();
    if (w) remember(w.address, null);
    userId = null; save("axcel.userId", null); showProfile();
    renderAll();
  });


  document.addEventListener("axcel:wallet", function (e) {
    // Switching wallets switches profiles. The EVM address is the Mastercard wallet; Mainnet history stays an r-address.
    userId = e.detail ? users()[e.detail.address] || null : load("axcel.userId");
    showProfile(); renderAll();
  });

  showProfile();
  renderAll();
 
})();
