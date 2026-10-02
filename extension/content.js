// TxWhy explorer companion. Reads the signature from the page URL, asks TxWhy why the transaction
// failed, and shows the answer in a small panel. Nothing is injected into the explorer's own DOM
// beyond this panel; no page data is read; the only network call is to txwhy.vercel.app.
(() => {
  const API = "https://txwhy.vercel.app";
  const SIG = /\/tx\/([1-9A-HJ-NP-Za-km-z]{80,90})/;

  let lastSignature = null;
  let panel = null;

  function signatureFromUrl() {
    const m = location.pathname.match(SIG);
    return m ? m[1] : null;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function mount() {
    if (panel && document.body.contains(panel)) return panel;
    panel = el("aside", "txwhy-panel");
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "TxWhy");
    const head = el("div", "txwhy-head");
    const brand = el("a", "txwhy-brand");
    brand.href = API;
    brand.target = "_blank";
    brand.rel = "noopener";
    brand.append(el("span", "txwhy-tx", "Tx"), el("span", "txwhy-why", "Why"));
    const close = el("button", "txwhy-close", "×");
    close.title = "Hide";
    close.addEventListener("click", () => panel.remove());
    head.append(brand, close);
    panel.append(head, el("div", "txwhy-body"));
    document.body.append(panel);
    return panel;
  }

  function render(children) {
    const body = mount().querySelector(".txwhy-body");
    body.replaceChildren(...children);
  }

  function statusChip(status) {
    const map = {
      repaired: ["Rebuilt and verified", "ok"],
      valid: ["Already valid", "ok"],
      needs_requote: ["Needs a fresh quote", "warn"],
      not_repairable: ["Not repairable by rebuilding", "bad"],
    };
    const [label, tone] = map[status] || [status, "warn"];
    return el("span", `txwhy-chip txwhy-${tone}`, label);
  }

  async function explain(signature) {
    render([el("p", "txwhy-muted", "Asking TxWhy why this transaction failed…")]);
    let r;
    try {
      const res = await fetch(`${API}/api/v1/repair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-txwhy-client": "extension" },
        body: JSON.stringify({ signature }),
      });
      r = await res.json();
      if (!res.ok) throw new Error(r.error || `TxWhy answered ${res.status}`);
    } catch (e) {
      render([el("p", "txwhy-muted", e.message || "TxWhy did not answer."), link(signature, "Open on TxWhy")]);
      return;
    }
    const out = [];
    if (r.status === "valid" && !r.cause) {
      out.push(el("p", "txwhy-title", "This transaction succeeded."));
      out.push(el("p", "txwhy-muted", "Nothing to repair. TxWhy only has something to say when a transaction fails."));
      render(out);
      return;
    }
    if (r.cause) {
      out.push(el("p", "txwhy-title", r.cause.title));
      if (r.cause.code) out.push(el("p", "txwhy-code", r.cause.code));
      const why = el("p", "txwhy-text");
      why.append(el("b", null, "Why: "), r.cause.cause);
      out.push(why);
      if (r.cause.fix) {
        const fix = el("p", "txwhy-text");
        fix.append(el("b", null, "What to do: "), r.cause.fix);
        out.push(fix);
      }
    } else {
      out.push(el("p", "txwhy-text", r.summary || "No cause could be determined."));
    }
    const row = el("div", "txwhy-row");
    row.append(statusChip(r.status));
    if (r.status === "repaired") row.append(el("span", "txwhy-muted", "A rebuilt version passes simulation right now."));
    out.push(row);
    out.push(link(signature, r.status === "repaired" ? "See the rebuilt transaction on TxWhy" : "Full breakdown on TxWhy"));
    render(out);
  }

  function link(signature, text) {
    const a = el("a", "txwhy-link", text + " →");
    a.href = `${API}/tx/${signature}`;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  function tick() {
    const sig = signatureFromUrl();
    if (!sig) {
      if (panel) panel.remove();
      lastSignature = null;
      return;
    }
    if (sig === lastSignature) return;
    lastSignature = sig;
    explain(sig);
  }

  // Explorers are single-page apps: watch the URL, not just the first load.
  tick();
  setInterval(tick, 1000);
})();
