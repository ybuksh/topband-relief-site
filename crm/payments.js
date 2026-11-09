"use strict";
/* Fee payments: a client payment page with card (Stripe) and pay-by-bank (GoCardless Instant Bank Pay),
   plus bank transfer, cheque and phone details. Payments are recorded against the invoice; when the
   balance reaches zero the case moves to Fee paid. Webhooks confirm online payments. */
const crypto = require("crypto");

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "", STRIPE_WH = process.env.STRIPE_WEBHOOK_SECRET || "";
const GC_TOKEN = process.env.GOCARDLESS_ACCESS_TOKEN || "", GC_WH = process.env.GOCARDLESS_WEBHOOK_SECRET || "";
const GC_BASE = (process.env.GOCARDLESS_ENV || "live") === "sandbox" ? "https://api-sandbox.gocardless.com" : "https://api.gocardless.com";

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY, lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT now(), amount NUMERIC(12,2) NOT NULL, method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed', provider_ref TEXT UNIQUE, ext_id TEXT, payer TEXT, note TEXT
  );
  CREATE INDEX IF NOT EXISTS payments_lead_idx ON payments(lead_id);
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS pay_token TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS plan_amount NUMERIC(12,2);
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS third_party_payer BOOLEAN NOT NULL DEFAULT false;
`;
const METHODS = { transfer: "Bank transfer", cheque: "Cheque", card_phone: "Card by phone", stripe: "Card online", gocardless: "Pay by bank online", other: "Other" };

module.exports = function payments(ctx) {
  const { pool, log, page, esc, fmtDate, iso, today, BRAND, PHONE, clip, gbp, settings } = ctx;
  const total = L => Math.round((Number(L.fee || 0) + Number(L.vat || 0)) * 100) / 100;
  async function paid(leadId) { return Number((await pool.query("SELECT coalesce(sum(amount),0) AS s FROM payments WHERE lead_id=$1 AND status='confirmed'", [leadId])).rows[0].s); }
  async function balance(L) { return Math.max(0, Math.round((total(L) - await paid(L.id)) * 100) / 100); }
  async function ensureToken(id) {
    const t = crypto.randomBytes(18).toString("base64url");
    await pool.query("UPDATE leads SET pay_token=coalesce(pay_token,$2) WHERE id=$1", [id, t]);
  }
  /* record a confirmed payment; close the fee when fully paid */
  async function record(leadId, amount, method, ref, note, payer) {
    if (ref) { const ex = (await pool.query("SELECT id, status FROM payments WHERE provider_ref=$1", [ref])).rows[0]; if (ex && ex.status === "confirmed") return; if (ex) { await pool.query("UPDATE payments SET status='confirmed', amount=$2, at=now() WHERE id=$1", [ex.id, amount]); } else await pool.query("INSERT INTO payments(lead_id,amount,method,provider_ref,note,payer) VALUES($1,$2,$3,$4,$5,$6)", [leadId, amount, method, ref, note || null, payer || null]); }
    else await pool.query("INSERT INTO payments(lead_id,amount,method,note,payer) VALUES($1,$2,$3,$4,$5)", [leadId, amount, method, note || null, payer || null]);
    const L = (await pool.query("SELECT * FROM leads WHERE id=$1", [leadId])).rows[0];
    const bal = await balance(L);
    await log(leadId, "fee", `Payment received: ${gbp(amount)} by ${METHODS[method] || method}${payer ? ` (paid by ${payer})` : ""}. Balance ${gbp(bal)}.`);
    if (payer && L && payer.trim().toLowerCase() !== `${L.first_name} ${L.last_name}`.toLowerCase()) {
      await pool.query("UPDATE leads SET third_party_payer=true WHERE id=$1", [leadId]);
      await log(leadId, "check", `Fee paid by someone other than the client (${payer}). Check this under the AML policy.`);
    }
    if (bal <= 0.005 && L && ["invoiced", "payment_plan", "fee_review"].includes(L.stage)) {
      await pool.query("UPDATE leads SET stage='paid', paid_at=current_date, next_action='Ask for a review and referral', next_action_date=current_date + 1, updated_at=now() WHERE id=$1", [leadId]);
      await log(leadId, "stage", "Fee paid in full: moved to Fee paid");
    }
  }

  const shell = (title, inner) => page(title, `<div style="max-width:620px;margin:24px auto;display:grid;gap:16px;font-size:18px"><div><strong style="font-size:1.1rem">${esc(BRAND)}</strong><h1 style="margin-top:6px">${esc(title)}</h1></div>${inner}
    <p class="muted">Questions or need more time? Call us on ${esc(PHONE)}, weekdays 9am to 5pm. We can agree a payment plan.</p></div>`, { bare: true });
  const byToken = async t => /^[A-Za-z0-9_-]{20,40}$/.test(t || "") ? (await pool.query("SELECT * FROM leads WHERE pay_token=$1", [t])).rows[0] : null;
  const origin = req => process.env.PUBLIC_URL || `https://${req.headers.host}`;

  return {
    INIT_SQL, ensureToken, balance, record, METHODS,
    stripeReady: () => !!STRIPE_KEY, gcReady: () => !!GC_TOKEN,
    /* raw-body parsers for webhooks must be registered before the normal body parsers */
    rawRoutes(app, express) {
      app.post("/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
        const raw = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body || "");
        if (STRIPE_WH) {
          const h = Object.fromEntries(String(req.headers["stripe-signature"] || "").split(",").map(x => x.split("=")));
          const exp = crypto.createHmac("sha256", STRIPE_WH).update(`${h.t}.${raw}`).digest("hex");
          if (!h.v1 || exp.length !== h.v1.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(h.v1)) || Math.abs(Date.now() / 1000 - Number(h.t)) > 600) return res.status(400).send("Bad signature");
        } else return res.status(400).send("Webhook secret not set");
        let ev; try { ev = JSON.parse(raw); } catch { return res.status(400).send("Bad JSON"); }
        if (ev.type === "checkout.session.completed" && ev.data && ev.data.object && ev.data.object.payment_status === "paid") {
          const s = ev.data.object, id = Number((s.metadata || {}).lead_id);
          if (id) await record(id, (s.amount_total || 0) / 100, "stripe", "stripe:" + s.id, "Stripe checkout", (s.customer_details || {}).name);
        }
        res.json({ received: true });
      });
      app.post("/gocardless/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
        const raw = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body || "");
        if (!GC_WH) return res.status(498).send("Webhook secret not set");
        const exp = crypto.createHmac("sha256", GC_WH).update(raw).digest("hex"), got = String(req.headers["webhook-signature"] || "");
        if (exp.length !== got.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(got))) return res.status(498).send("Invalid token");
        let body; try { body = JSON.parse(raw); } catch { return res.status(400).send("Bad JSON"); }
        for (const e of body.events || []) {
          const l = e.links || {};
          if (e.resource_type === "billing_requests" && e.action === "fulfilled" && l.billing_request) {
            const p = (await pool.query("UPDATE payments SET ext_id=$2 WHERE provider_ref=$1 RETURNING lead_id, amount", ["gc:" + l.billing_request, l.payment_request_payment || null])).rows[0];
            if (p) await log(p.lead_id, "fee", `Bank payment of ${gbp(p.amount)} started by the client; waiting for GoCardless to confirm it`);
          }
          if (e.resource_type === "payments" && ["confirmed", "paid_out"].includes(e.action) && l.payment) {
            const p = (await pool.query("SELECT * FROM payments WHERE ext_id=$1", [l.payment])).rows[0];
            if (p && p.status !== "confirmed") await record(p.lead_id, Number(p.amount), "gocardless", p.provider_ref, "GoCardless Instant Bank Pay");
          }
          if (e.resource_type === "payments" && ["failed", "cancelled"].includes(e.action) && l.payment) {
            const p = (await pool.query("UPDATE payments SET status='failed' WHERE ext_id=$1 AND status <> 'confirmed' RETURNING lead_id", [l.payment])).rows[0];
            if (p) await log(p.lead_id, "fee", "Online bank payment failed or was cancelled");
          }
        }
        res.sendStatus(204);
      });
    },
    publicRoutes(app) {
      app.get("/pay/:token", async (req, res) => {
        const L = await byToken(req.params.token); if (!L || !L.invoice_no) return res.status(404).send(shell("Payment link", `<div class="panel"><p>This payment link isn't working. Please call us and we'll help.</p></div>`));
        const F = await settings(), bal = await balance(L);
        if (req.query.done) await log(L.id, "fee", "Client returned from the online payment page");
        if (bal <= 0) return res.send(shell("Thank you", `<div class="panel"><p>Invoice ${esc(L.invoice_no)} is paid in full. Thank you.</p></div>`));
        const inst = L.plan_amount && Number(L.plan_amount) < bal ? Number(L.plan_amount) : null;
        const opts = amt => `${STRIPE_KEY ? `<form method="post" action="/pay/${L.pay_token}/stripe"><input type="hidden" name="amount" value="${amt}"><button style="width:100%;font-size:1.1rem;padding:14px">Pay ${gbp(amt)} by card</button></form>` : ""}
          ${GC_TOKEN ? `<form method="post" action="/pay/${L.pay_token}/gocardless"><input type="hidden" name="amount" value="${amt}"><button class="btn ghost" style="width:100%;font-size:1.1rem;padding:14px">Pay ${gbp(amt)} from your bank app</button></form>` : ""}`;
        res.send(shell(`Pay invoice ${L.invoice_no}`, `${req.query.plan ? `<div class="panel" style="border-color:var(--good)"><p><b>Thank you, your plan is set up.</b> You can make your first payment below. We'll remind you before each one.</p></div>` : ""}${req.query.cancel ? `<div class="panel"><p>Your payment wasn't completed. You can try again below or call us.</p></div>` : ""}${req.query.done ? `<div class="panel" style="border-color:var(--good)"><p><b>Thank you.</b> We'll confirm once your payment has come through.</p></div>` : ""}
          <div class="panel"><dl><dt>Invoice</dt><dd>${esc(L.invoice_no)}</dd><dt>For</dt><dd>${esc(L.title || "")} ${esc(L.last_name)}</dd><dt>Amount due</dt><dd><b>${gbp(bal)}</b></dd><dt>Due by</dt><dd>${fmtDate(iso(L.invoice_due))}</dd></dl></div>
          ${STRIPE_KEY || GC_TOKEN ? `<div class="panel" style="display:grid;gap:10px"><h2>Pay online</h2>${inst ? `<p>Your payment plan instalment:</p>${opts(inst)}<p class="muted">Or pay the full balance:</p>` : ""}${opts(bal)}<small class="muted">Secure payment pages run by ${[STRIPE_KEY && "Stripe", GC_TOKEN && "GoCardless"].filter(Boolean).join(" and ")}. We never see your card or bank login details.</small></div>` : ""}
          ${!L.plan_amount && bal > 60 ? `<form class="panel" method="post" action="/pay/${L.pay_token}/plan" style="display:grid;gap:10px"><h2>Spread the cost</h2><p>Choose a monthly plan. There's no interest and no extra charge.</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">${[3, 6, 10].map(n => `<button class="btn ghost" name="months" value="${n}" style="flex:1 1 140px">${n} months<br><b>${gbp(Math.ceil(bal / n))}</b> a month</button>`).join("")}</div>
            <small class="muted">We'll confirm the plan with you and send a reminder before each payment.</small></form>` : ""}
          <div class="panel"><h2>Other ways to pay</h2><ul>
          ${F.account_no ? `<li>Bank transfer to ${esc(F.account_name || F.company_name)}, sort code ${esc(F.sort_code)}, account ${esc(F.account_no)}, reference <b>${esc(L.invoice_no)}</b></li>` : ""}
          <li>Cheque payable to ${esc(F.company_name || BRAND)}${F.address ? `, posted to ${esc(F.address)}` : ""}, with ${esc(L.invoice_no)} on the back</li>
          <li>Card over the phone: call ${esc(F.phone || PHONE)}</li></ul></div>`));
      });
      app.post("/pay/:token/plan", async (req, res) => {
        const L = await byToken(req.params.token); if (!L) return res.redirect("/pay/" + req.params.token);
        const months = [3, 6, 10].includes(Number(req.body.months)) ? Number(req.body.months) : 3, bal = await balance(L);
        if (bal <= 0 || L.plan_amount) return res.redirect("/pay/" + L.pay_token);
        const amt = Math.ceil(bal / months);
        await pool.query("UPDATE leads SET plan_amount=$2, stage=CASE WHEN stage IN ('invoiced','fee_review') THEN 'payment_plan' ELSE stage END, next_action=$3, next_action_date=current_date, updated_at=now() WHERE id=$1",
          [L.id, amt, `Client chose a ${months}-month plan online (${gbp(amt)} a month): confirm it with them`]);
        await log(L.id, "fee", `Client chose a ${months}-month payment plan online: ${gbp(amt)} a month`);
        res.redirect("/pay/" + L.pay_token + "?plan=1");
      });
      app.post("/pay/:token/stripe", async (req, res) => {
        const L = await byToken(req.params.token); if (!L || !STRIPE_KEY) return res.redirect("/pay/" + req.params.token);
        const bal = await balance(L), amt = Math.min(bal, Math.max(1, Number(req.body.amount) || bal));
        const p = new URLSearchParams({ mode: "payment", "line_items[0][price_data][currency]": "gbp", "line_items[0][price_data][unit_amount]": String(Math.round(amt * 100)),
          "line_items[0][price_data][product_data][name]": `${BRAND} invoice ${L.invoice_no}`, "line_items[0][quantity]": "1", "metadata[lead_id]": String(L.id), "metadata[invoice_no]": L.invoice_no,
          "payment_intent_data[metadata][lead_id]": String(L.id), client_reference_id: String(L.id),
          success_url: `${origin(req)}/pay/${L.pay_token}?done=1`, cancel_url: `${origin(req)}/pay/${L.pay_token}?cancel=1` });
        if (L.email) p.set("customer_email", L.email);
        const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" }, body: p });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) { console.error("Stripe:", j.error && j.error.message); return res.send(shell("Payment", `<div class="panel"><p>Online card payment isn't available right now. Please call us on ${esc(PHONE)} or use the other options.</p><a class="btn" href="/pay/${L.pay_token}">Back</a></div>`)); }
        await log(L.id, "fee", `Client opened card payment for ${gbp(amt)}`);
        res.redirect(303, j.url);
      });
      app.post("/pay/:token/gocardless", async (req, res) => {
        const L = await byToken(req.params.token); if (!L || !GC_TOKEN) return res.redirect("/pay/" + req.params.token);
        const bal = await balance(L), amt = Math.min(bal, Math.max(1, Number(req.body.amount) || bal));
        const H = { Authorization: "Bearer " + GC_TOKEN, "GoCardless-Version": "2015-07-06", "Content-Type": "application/json" };
        try {
          const br = await (await fetch(GC_BASE + "/billing_requests", { method: "POST", headers: { ...H, "Idempotency-Key": `br-${L.id}-${Date.now()}` }, body: JSON.stringify({ billing_requests: { payment_request: { description: `${BRAND} invoice ${L.invoice_no}`, amount: Math.round(amt * 100), currency: "GBP" }, metadata: { lead_id: String(L.id), invoice_no: L.invoice_no } } }) })).json();
          const brId = br.billing_requests && br.billing_requests.id; if (!brId) throw new Error(JSON.stringify(br.error || br).slice(0, 200));
          const fl = await (await fetch(GC_BASE + "/billing_request_flows", { method: "POST", headers: H, body: JSON.stringify({ billing_request_flows: { redirect_uri: `${origin(req)}/pay/${L.pay_token}?done=1`, exit_uri: `${origin(req)}/pay/${L.pay_token}?cancel=1`, links: { billing_request: brId } } }) })).json();
          const url = fl.billing_request_flows && fl.billing_request_flows.authorisation_url; if (!url) throw new Error(JSON.stringify(fl.error || fl).slice(0, 200));
          await pool.query("INSERT INTO payments(lead_id,amount,method,status,provider_ref) VALUES($1,$2,'gocardless','pending',$3) ON CONFLICT DO NOTHING", [L.id, amt, "gc:" + brId]);
          await log(L.id, "fee", `Client opened bank payment for ${gbp(amt)}`);
          res.redirect(303, url);
        } catch (e) { console.error("GoCardless:", e.message); res.send(shell("Payment", `<div class="panel"><p>Paying from your bank app isn't available right now. Please call us on ${esc(PHONE)} or use the other options.</p><a class="btn" href="/pay/${L.pay_token}">Back</a></div>`)); }
      });
    },
    staffRoutes(app) {
      app.post("/lead/:id/payment", async (req, res) => {
        const amt = Math.round(parseFloat(String(req.body.amount || "").replace(/[£,\s]/g, "")) * 100) / 100;
        if (!(amt > 0)) return res.redirect("/lead/" + req.params.id + "?err=" + encodeURIComponent("Enter the amount received."));
        await record(Number(req.params.id), amt, METHODS[req.body.method] ? req.body.method : "other", null, clip(req.body.note, 200), clip(req.body.payer, 120) || null);
        res.redirect("/lead/" + req.params.id + "?ok=1");
      });
      app.post("/lead/:id/plan", async (req, res) => {
        const amt = Math.round(parseFloat(String(req.body.plan_amount || "").replace(/[£,\s]/g, "")) * 100) / 100;
        await pool.query("UPDATE leads SET plan_amount=$2, stage=CASE WHEN $2 IS NOT NULL AND stage IN ('invoiced','fee_review') THEN 'payment_plan' ELSE stage END, updated_at=now() WHERE id=$1", [req.params.id, amt > 0 ? amt : null]);
        await log(req.params.id, "fee", amt > 0 ? `Payment plan agreed: ${gbp(amt)} a month` : "Payment plan amount cleared");
        res.redirect("/lead/" + req.params.id + "?ok=1");
      });
    },
    async leadPanel(L) {
      if (!L.invoice_no) return "";
      const ps = (await pool.query("SELECT * FROM payments WHERE lead_id=$1 ORDER BY at DESC", [L.id])).rows, bal = await balance(L);
      const linkUrl = L.pay_token ? `${process.env.PUBLIC_URL || ""}/pay/${L.pay_token}` : "";
      return `<div class="panel"><h2>Payments <span class="pill ${bal <= 0 ? "good" : ""}">${bal <= 0 ? "Paid" : "Balance " + gbp(bal)}</span></h2>
        ${L.pay_token ? `<label>Payment link for the client <input readonly value="${esc(linkUrl)}" onclick="this.select()" style="width:100%"></label><small class="muted">Opens a page with card${STRIPE_KEY ? "" : " (not connected)"}, pay-by-bank${GC_TOKEN ? "" : " (not connected)"}, transfer, cheque and phone options.</small>` : ""}
        ${ps.length ? `<table><tbody>${ps.map(p => `<tr><td>${fmtDate(iso(p.at))}</td><td>${gbp(p.amount)}</td><td>${esc(METHODS[p.method] || p.method)}${p.payer ? `<br><small class="muted">paid by ${esc(p.payer)}</small>` : ""}</td><td><span class="pill ${p.status === "confirmed" ? "good" : p.status === "failed" ? "bad" : ""}">${esc(p.status)}</span></td></tr>`).join("")}</tbody></table>` : ""}
        <form method="post" action="/lead/${L.id}/payment" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:0">
          <label>Amount (£) <input name="amount" inputmode="decimal" size="8"></label>
          <label>How <select name="method">${["transfer", "cheque", "card_phone", "other"].map(k => `<option value="${k}">${esc(METHODS[k])}</option>`).join("")}</select></label>
          <label>Paid by (if not the client) <input name="payer" size="14"></label>
          <button class="btn ghost">Record payment</button></form>
        <form method="post" action="/lead/${L.id}/plan" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:0">
          <label>Payment plan (£ a month) <input name="plan_amount" inputmode="decimal" size="8" value="${L.plan_amount ?? ""}"></label><button class="btn ghost">Save plan</button></form>
        ${L.third_party_payer ? `<p class="pill bad" style="justify-self:start">Paid by a third party: check under the AML policy</p>` : ""}</div>`;
    }
  };
};
module.exports.INIT_SQL = INIT_SQL;
