/* Terminal forms: show the exact curl a form will send, run it, and print the reply like a shell.
   Used by agents.html. Each form declares spec(form) -> [{ method, path, body, note }]. */
(function () {
  var MAX_LINES = 24;
  function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function curl(base, req) {
    var lines = ["curl -s -X " + req.method + " " + base + req.path];
    if (req.body) {
      lines.push("  -H 'Content-Type: application/json'");
      lines.push("  -d " + q(JSON.stringify(req.body)));
    }
    return lines.join(" \\\n");
  }

  function print(form, text, cls) {
    var line = document.createElement("span");
    line.className = cls || "";
    line.textContent = text + "\n";
    form.querySelector(".result").appendChild(line);
  }

  function call(base, form, req) {
    return fetch(base + req.path, {
      method: req.method,
      headers: req.body ? { "Content-Type": "application/json" } : {},
      body: req.body ? JSON.stringify(req.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) {}
        print(form, "HTTP " + res.status, res.ok ? "t-ok" : "t-err");
        if (txt) {
          // Long replies (a 500-transaction history) are cut down; the page renders the full data elsewhere.
          var lines = JSON.stringify(data, null, 2).split("\n");
          print(form, lines.slice(0, MAX_LINES).join("\n"), "t-json");
          if (lines.length > MAX_LINES) print(form, "… " + (lines.length - MAX_LINES) + " more lines", "t-dim");
        }
        // A 402 from the paywall is an answer (the price), not a failure.
        if (!res.ok && res.status !== 402) throw new Error(data.error || "request failed");
        return data;
      });
    }, function () {
      var host = base.replace(/^https?:\/\//, "").split("/")[0].split(":");
      print(form, "curl: (7) Failed to connect to " + host[0] + " port " + (host[1] || 80) + ": Connection refused", "t-err");
      throw new Error("That service isn't running yet.");
    });
  }

  /* opts: { form, base, spec, check?(form) -> error string, done?(form, reply) -> line, after?() } */
  function mount(opts) {
    var form = opts.form;
    function render() {
      form.querySelector(".term-cmd").innerHTML = opts.spec(form).map(function (r) {
        return (r.note ? '<span class="t-dim"># ' + esc(r.note) + "</span>\n" : "") + '<span class="t-prompt">$</span> ' + esc(curl(opts.base, r));
      }).join("\n\n");
    }
    form.addEventListener("input", render);
    form.addEventListener("change", render);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      form.querySelector(".result").textContent = "";
      var problem = opts.check && opts.check(form);
      if (problem) { print(form, "error: " + problem, "t-err"); return; }
      var btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      var reqs = opts.spec(form), last;
      reqs.reduce(function (p, req) {
        return p.then(function () {
          print(form, "$ curl -X " + req.method + " " + opts.base + req.path, "t-dim");
          return call(opts.base, form, req).then(function (r) { last = r; });
        });
      }, Promise.resolve())
        .then(function () {
          return Promise.resolve(opts.done && opts.done(form, last)).then(function (line) {
            if (line) print(form, "# " + line, "t-ok");
            if (opts.after) opts.after();
          });
        })
        .catch(function (err) { print(form, "error: " + err.message, "t-err"); })
        .then(function () { btn.disabled = false; render(); });
    });
    render();
    return { render: render };
  }

  window.AxcelTerm = { mount: mount, esc: esc };
})();
