/* Get your score, Part 1: connect a wallet, read its Mainnet history through QuickNode, and score it with the
   credit-layer engine. Continue then opens Part 2 (XRPL and Mastercard). */
(function () {
  var API = (window.AXCEL_API || "http://127.0.0.1:3000") + "/api/v1";
  var $ = function (id) { return document.getElementById(id); };
  var esc = AxcelTerm.esc;

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var short = function (a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"; };
  var date = function (iso) { return iso ? new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "—"; };
  var amount = function (a) {
    if (!a) return "—";
    var v = Number(a.value);
    var n = v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(+v.toFixed(6));
    return n + " " + (a.kind === "xrp" ? "XRP" : a.currency || "");
  };
  var account = function () { return $("h-account").value.trim(); };

  // ---- wallet panel ----
  function showWallet(w) {
    $("wp-address").textContent = w ? w.address : "Not connected";
    $("wp-connect").textContent = w ? "Change wallet" : "Connect wallet";
    var input = $("h-account");
    if (w && w.address && (!input.value || input.dataset.fromWallet)) {
      input.value = w.address;
      input.dataset.fromWallet = "1";
    }
    historyTerm.render();
    preview.render();
  }
  $("wp-connect").addEventListener("click", function (e) { e.stopPropagation(); $("wallet-btn").click(); });
  $("h-account").addEventListener("input", function () { delete this.dataset.fromWallet; preview.render(); });

  // ---- history ----
  var MAX_ROWS = 5;
  var historyTerm = AxcelTerm.mount({
    form: $("f-history"), base: API,
    spec: function () { return [{ method: "GET", path: "/credit-history/" + (account() || "$ADDRESS"), note: "Full history. The table shows the latest 5." }]; },
    check: function () { return account() ? null : "enter an address or connect your wallet."; },
    done: function (f, snap) {
      var s = snap.summary || {};
      $("hs-count").textContent = (s.transactionCount || 0).toLocaleString();
      $("hs-sent").textContent = (s.paymentsSent || 0).toLocaleString();
      $("hs-peers").textContent = (s.uniqueCounterparties || 0).toLocaleString();
      $("hs-first").textContent = s.firstActivityAt ? new Date(s.firstActivityAt).toLocaleDateString([], { month: "short", year: "numeric" }) : "—";
      var txs = snap.transactions || [];
      $("history-rows").innerHTML = txs.length ? txs.slice(0, MAX_ROWS).map(function (t) {
        var ok = t.result === "tesSUCCESS";
        return "<tr" + (ok ? "" : ' class="refused"') + "><td>" + date(t.timestamp) + "</td><td>" + esc(t.type) + "</td><td>" +
          (t.direction === "out" ? "Sent" : t.direction === "in" ? "Received" : "Other") + '</td><td class="mono" title="' + esc(t.counterparty || "") + '">' + short(t.counterparty) +
          '</td><td class="num">' + esc(amount(t.amount)) + '</td><td class="status' + (ok ? "" : " refused") + '"><span class="mark ' + (ok ? "ok" : "bad") + '"></span>' + (ok ? "Success" : esc(t.result)) + "</td></tr>";
      }).join("") : '<tr><td colspan="6" class="small">No transactions on this account.</td></tr>';
      $("history-more").textContent = txs.length > MAX_ROWS ? "Showing the latest " + MAX_ROWS + " of " + txs.length + ". The score uses all " + txs.length + "." : "";
      $("history-out").hidden = false;
      return (s.transactionCount || 0) + " transactions read. Calculate the score below.";
    },
    after: function () { $("f-preview").requestSubmit(); }
  });

  // ---- score preview ----
  function card(r, note) {
    $("card-score").textContent = r && r.score != null ? Math.round(r.score) : "—";
    $("card-tier").textContent = r && r.tier ? "Tier " + r.tier : "No tier yet";
    $("card-line").textContent = "$" + (r ? r.creditLine || 0 : 0).toLocaleString();
    $("card-basis").textContent = r ? "from " + r.scoredPayments + " payment" + (r.scoredPayments === 1 ? "" : "s") : "";
    $("card-reasons").innerHTML = (r && r.reasons || []).map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("");
    $("card-note").textContent = note || "";
    $("card-note").hidden = !note;
  }

  var preview = AxcelTerm.mount({
    form: $("f-preview"), base: API,
    spec: function () {
      return [{ method: "GET", path: "/credit-history/" + (account() || "$ADDRESS") + "/score", note: "Scored from the full history" }];
    },
    check: function () { return account() ? null : "read your history first."; },
    done: function (f, r) {
      card(r, "Preview from your Mainnet history. Linking your account and verifying your identity in Part 2 issues the tier on-ledger.");
      save("axcel.preview", { account: account(), score: r.score, tier: r.tier });
      return "Score " + Math.round(r.score) + ", Tier " + r.tier + ".";
    }
  });

  // ---- continue to Part 2 ----
  function openPart2(scroll) {
    $("part2").hidden = false;
    save("axcel.continued", true);
    if (scroll) $("part2").scrollIntoView({ behavior: "smooth" });
  }
  $("continue").addEventListener("click", function () { openPart2(true); });
  if (load("axcel.continued") || location.hash && location.hash !== "#top" && $("part2").querySelector(location.hash)) openPart2(false);

  // Connecting a wallet reads its history straight away.
  document.addEventListener("axcel:wallet", function (e) {
    showWallet(e.detail);
    if ($("history-out").hidden) card(null, e.detail ? "Read your history to calculate your score." : "Connect your wallet to see your score.");
    if (e.detail && e.detail.address) $("f-history").requestSubmit();
  });
  var w0 = load("axcel.wallet");
  showWallet(w0);
  card(null, w0 ? "Read your history to calculate your score." : "Connect your wallet to see your score.");
  if (w0 && w0.address) $("f-history").requestSubmit();
})();
