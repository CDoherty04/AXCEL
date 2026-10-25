/* Terminal forms: show the axcel command a form will run, call the API, and print the reply like a shell.
   Used by agents.html and get-score.html. Each form declares spec(form) -> [{ method, path, body, cmd, note }]. */
(function () {
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function sh(s) {
    s = String(s);
    if (s === "") return "''";
    if (/^[A-Za-z0-9_./:@%+=-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  function flags(obj) {
    var out = "";
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v == null || v === "" || v === false) return;
      out += v === true ? " --" + k : " --" + k + " " + sh(v);
    });
    return out;
  }
  function command(req) {
    return req.cmd || ("axcel " + String(req.method || "get").toLowerCase() + " " + req.path);
  }
  function line(req) {
    return (req.note ? '<span class="t-dim"># ' + esc(req.note) + "</span>\n" : "") +
      '<span class="t-prompt">$</span> ' + esc(command(req));
  }

  function print(form, text, cls) {
    var el = document.createElement("span");
    el.className = cls || "";
    el.textContent = text + "\n";
    form.querySelector(".result").appendChild(el);
  }

  function lines(form, msg, cls) {
    if (msg == null || msg === "") return;
    (Array.isArray(msg) ? msg : String(msg).split("\n")).forEach(function (l) {
      if (String(l).trim()) print(form, l, cls || "t-ok");
    });
  }

  function clearWait(form) {
    form.querySelectorAll(".result .t-wait").forEach(function (el) { el.remove(); });
  }

  function call(base, form, req) {
    return fetch(base + req.path, {
      method: req.method,
      cache: "no-store",
      headers: req.body ? { "Content-Type": "application/json" } : {},
      body: req.body ? JSON.stringify(req.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        clearWait(form);
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) {}
        if (!txt && (res.status === 304 || res.status === 200)) {
          throw new Error("empty response (cached). Try again.");
        }
        // A 402 from the paywall is an answer (the price), not a failure.
        if (!res.ok && res.status !== 402) throw new Error(data.error || "request failed");
        return data;
      });
    }, function () {
      clearWait(form);
      var host = base.replace(/^https?:\/\//, "").split("/")[0].split(":");
      print(form, "axcel: failed to connect to " + host[0] + " port " + (host[1] || 80) + ": Connection refused", "t-err");
      throw new Error("That service isn't running yet.");
    });
  }

  /* opts: { form, base, spec, check?(form) -> error string, done?(form, reply) -> line, after?() } */
  function mount(opts) {
    var form = opts.form;
    function render() {
      form.querySelector(".term-cmd").innerHTML = opts.spec(form).map(line).join("\n\n");
    }
    form.addEventListener("input", render);
    form.addEventListener("change", render);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      form.querySelector(".result").textContent = "";
      var problem = opts.check && opts.check(form);
      if (problem) { print(form, "error: " + problem, "t-err"); return; }
      var btn = form.querySelector("button[type=submit]");
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Waiting…";
      form.setAttribute("aria-busy", "true");
      if (opts.busy) opts.busy(form, true);
      var reqs = opts.spec(form), last;
      reqs.reduce(function (p, req) {
        return p.then(function () {
          print(form, "$ " + command(req), "t-dim");
          if (req.method !== "GET" && /agents|merchants|repay|run/.test(req.path)) print(form, "# waiting on XRPL validation; this can take up to a minute", "t-dim");
          print(form, "waiting…", "t-wait");
          return call(opts.base, form, req).then(function (r) { last = r; });
        });
      }, Promise.resolve())
        .then(function () {
          return Promise.resolve(opts.done && opts.done(form, last)).then(function (msg) {
            lines(form, msg);
            if (opts.after) opts.after();
          });
        })
        .catch(function (err) {
          var starting = /service is starting/i.test(err.message);
          print(form, (starting ? "" : "error: ") + err.message, starting ? "t-dim" : "t-err");
        })
        .then(function () {
          clearWait(form);
          btn.disabled = false;
          btn.textContent = label;
          form.removeAttribute("aria-busy");
          if (opts.busy) opts.busy(form, false);
          render();
        });
    });
    render();
    return { render: render };
  }

  window.AxcelTerm = { mount: mount, esc: esc, sh: sh, flags: flags, command: command, print: print, lines: lines };
})();
