/* Connect wallet: GemWallet or Crossmark (browser extensions), or a pasted address.
   The connected address is kept per browser and announced with an "axcel:wallet" event. */
(function () {
  var GEM = "https://cdn.jsdelivr.net/npm/@gemwallet/api@3.8.0/+esm";
  var CROSSMARK = "https://cdn.jsdelivr.net/npm/@crossmarkio/sdk@0.4.0/+esm";
  var R_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

  var btn = document.getElementById("wallet-btn");
  if (!btn) return;
  var box = btn.parentNode;

  function load() { try { return JSON.parse(localStorage.getItem("axcel.wallet")); } catch (e) { return null; } }
  function store(v) { try { v ? localStorage.setItem("axcel.wallet", JSON.stringify(v)) : localStorage.removeItem("axcel.wallet"); } catch (e) {} }

  var wallet = load();
  window.AXCEL_WALLET = wallet;
  var short = function (a) { return a.slice(0, 5) + "…" + a.slice(-4); };

  function render() {
    btn.innerHTML = wallet
      ? '<span class="mark ok"></span><span class="mono">' + short(wallet.address) + "</span>"
      : "Connect wallet";
    btn.setAttribute("aria-label", wallet ? "Wallet " + wallet.address : "Connect wallet");
  }

  function set(v) {
    wallet = v; window.AXCEL_WALLET = v; store(v); render(); close();
    document.dispatchEvent(new CustomEvent("axcel:wallet", { detail: v }));
  }

  // ---- menu ----
  var menu = document.createElement("div");
  menu.className = "wallet-menu";
  menu.hidden = true;
  box.appendChild(menu);

  function open() { draw(); menu.hidden = false; btn.setAttribute("aria-expanded", "true"); }
  function close() { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); }
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", function (e) { e.stopPropagation(); menu.hidden ? open() : close(); });
  document.addEventListener("click", function (e) { if (!box.contains(e.target)) close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  function note(text, err) {
    var p = menu.querySelector(".wallet-note");
    p.textContent = text;
    p.className = "wallet-note" + (err ? " err" : "");
  }

  function draw() {
    if (wallet) {
      menu.innerHTML =
        '<p class="wallet-h">Connected' + (wallet.via ? " with " + wallet.via : "") + '</p>' +
        '<p class="mono wallet-addr">' + wallet.address + "</p>" +
        '<button type="button" data-act="copy">Copy address</button>' +
        '<button type="button" data-act="disconnect">Disconnect</button>' +
        '<p class="wallet-note" aria-live="polite"></p>';
    } else {
      menu.innerHTML =
        '<p class="wallet-h">Connect an XRPL wallet</p>' +
        '<button type="button" data-act="gem">GemWallet</button>' +
        '<button type="button" data-act="crossmark">Crossmark</button>' +
        '<form class="wallet-manual"><label for="wallet-addr">Or paste your address</label>' +
        '<div><input id="wallet-addr" placeholder="r…" autocomplete="off" spellcheck="false"><button type="submit">Use</button></div></form>' +
        '<p class="wallet-note" aria-live="polite"></p>';
    }
  }

  menu.addEventListener("click", function (e) {
    var act = e.target.getAttribute && e.target.getAttribute("data-act");
    if (!act) return;
    e.stopPropagation();
    if (act === "copy") {
      (navigator.clipboard ? navigator.clipboard.writeText(wallet.address) : Promise.reject())
        .then(function () { note("Copied."); }, function () { note("Couldn't copy. Select the address above.", true); });
    }
    if (act === "disconnect") set(null);
    if (act === "gem") connectGem();
    if (act === "crossmark") connectCrossmark();
  });

  menu.addEventListener("submit", function (e) {
    e.preventDefault();
    var a = menu.querySelector("#wallet-addr").value.trim();
    if (!R_ADDRESS.test(a)) return note("That doesn't look like an XRPL address (starts with r).", true);
    set({ address: a, via: null });
  });

  function connectGem() {
    note("Opening GemWallet…");
    import(GEM).then(function (gem) {
      return gem.isInstalled().then(function (r) {
        if (!r.result || !r.result.isInstalled) throw new Error("GemWallet isn't installed in this browser.");
        return gem.getAddress();
      }).then(function (r) {
        if (!r.result || !r.result.address) throw new Error("GemWallet didn't share an address.");
        set({ address: r.result.address, via: "GemWallet" });
      });
    }).catch(function (err) { note(err.message || "Couldn't reach GemWallet.", true); });
  }

  function connectCrossmark() {
    note("Opening Crossmark…");
    import(CROSSMARK).then(function (m) {
      var sdk = m.default;
      if (!sdk.sync.isInstalled()) throw new Error("Crossmark isn't installed in this browser.");
      return sdk.async.signInAndWait().then(function (r) {
        var a = r && r.response && r.response.data && r.response.data.address;
        if (!a) throw new Error("Crossmark didn't share an address.");
        set({ address: a, via: "Crossmark" });
      });
    }).catch(function (err) { note(err.message || "Couldn't reach Crossmark.", true); });
  }

  render();
})();
