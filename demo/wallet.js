/* Connect wallet: MetaMask (XRPL EVM Testnet, chain 1449000) or a pasted 0x address.
   The connected address is kept per browser and announced with an "axcel:wallet" event. */
(function () {
  var EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
  var CHAIN_ID = "0x161c28";
  var CHAIN = {
    chainId: CHAIN_ID,
    chainName: "XRPL EVM Testnet",
    nativeCurrency: { name: "XRP", symbol: "XRP", decimals: 18 },
    rpcUrls: ["https://rpc.testnet.xrplevm.org"],
    blockExplorerUrls: ["https://explorer.testnet.xrplevm.org"]
  };

  var btn = document.getElementById("wallet-btn");
  if (!btn) return;
  var box = btn.parentNode;

  function load() { try { return JSON.parse(localStorage.getItem("axcel.wallet")); } catch (e) { return null; } }
  function store(v) { try { v ? localStorage.setItem("axcel.wallet", JSON.stringify(v)) : localStorage.removeItem("axcel.wallet"); } catch (e) {} }

  var wallet = load();
  if (wallet && !EVM_ADDRESS.test(wallet.address)) wallet = null;
  window.AXCEL_WALLET = wallet;
  var short = function (a) { return a.slice(0, 6) + "…" + a.slice(-4); };

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
        '<p class="wallet-note">XRPL EVM Testnet</p>' +
        '<button type="button" data-act="copy">Copy address</button>' +
        '<button type="button" data-act="disconnect">Disconnect</button>' +
        '<p class="wallet-note" aria-live="polite"></p>';
    } else {
      menu.innerHTML =
        '<p class="wallet-h">Connect an XRPL EVM wallet</p>' +
        '<button type="button" data-act="metamask">MetaMask</button>' +
        '<form class="wallet-manual"><label for="wallet-addr">Or paste your 0x address</label>' +
        '<div><input id="wallet-addr" placeholder="0x…" autocomplete="off" spellcheck="false"><button type="submit">Use</button></div></form>' +
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
    if (act === "metamask") connectMetaMask();
  });

  menu.addEventListener("submit", function (e) {
    e.preventDefault();
    var a = menu.querySelector("#wallet-addr").value.trim();
    if (!EVM_ADDRESS.test(a)) return note("That doesn't look like an EVM address (0x and 40 hex characters).", true);
    set({ address: a, via: null, chainId: 1449000 });
  });

  function provider() {
    var eth = window.ethereum;
    if (!eth) return null;
    if (eth.providers && eth.providers.length) {
      var mm = eth.providers.filter(function (p) { return p.isMetaMask; })[0];
      return mm || eth.providers[0];
    }
    return eth;
  }

  function connectMetaMask() {
    var eth = provider();
    if (!eth) return note("MetaMask isn't installed in this browser. Paste the 0x address instead.", true);
    note("Opening MetaMask…");
    eth.request({ method: "eth_requestAccounts" }).then(function (accounts) {
      if (!accounts || !accounts[0]) throw new Error("MetaMask didn't share an address.");
      return eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID }] }).catch(function (err) {
        if (err && (err.code === 4902 || err.code === -32603)) {
          return eth.request({ method: "wallet_addEthereumChain", params: [CHAIN] });
        }
        throw err;
      }).then(function () { return accounts[0]; });
    }).then(function (address) {
      set({ address: address, via: "MetaMask", chainId: 1449000 });
    }).catch(function (err) {
      note(err && err.message ? err.message : "Couldn't reach MetaMask.", true);
    });
  }

  render();
})();
