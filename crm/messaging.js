"use strict";
/* Automatic client messages by WhatsApp, text and email.
   Sent weekdays 9am to 7pm UK time. Twilio sends SMS and WhatsApp; Resend sends email.
   Without a provider configured, messages wait on the Messages page to be sent by hand.
   WhatsApp needs Meta-approved templates for messages we start; set their Twilio Content SIDs in Settings. */
const crypto = require("crypto");

const TW_SID = process.env.TWILIO_ACCOUNT_SID || "", TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TW_SMS_FROM = process.env.TWILIO_SMS_FROM || "", TW_WA_FROM = process.env.TWILIO_WHATSAPP_FROM || "";
const HOURS = [9, 19];

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY, lead_id INT REFERENCES leads(id) ON DELETE CASCADE,
    direction TEXT NOT NULL DEFAULT 'out', channel TEXT NOT NULL, to_addr TEXT, from_addr TEXT,
    key TEXT, subject TEXT, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', error TEXT, provider_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS messages_key_uniq ON messages(lead_id, key, channel) WHERE key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_status_idx ON messages(status);
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_pref TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS no_auto BOOLEAN NOT NULL DEFAULT false;
`;

/* UK numbers to +44; landlines can't take texts or WhatsApp */
function e164(p) {
  let d = String(p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.startsWith("44")) return "+" + d;
  if (d.startsWith("0")) return "+44" + d.slice(1);
  return d ? "+" + d : "";
}
const isMobile = p => /^\+447\d{9}$/.test(e164(p));
function londonNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "numeric", hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { day: parts.weekday, hour: Number(parts.hour) };
}
const inWindow = () => { const n = londonNow(); return !["Sat", "Sun"].includes(n.day) && n.hour >= HOURS[0] && n.hour < HOURS[1]; };

module.exports = function messaging(ctx) {
  const { pool, log, page, esc, fmtDate, iso, today, addDays, sendEmail, BRAND, PHONE, clip, gbp } = ctx;
  let base = process.env.PUBLIC_URL || "";
  const link = p => (base || "") + p;
  const SITE = (process.env.SITE_URL || (process.env.SITE_ORIGIN || "").split(",")[0] || "https://topband-relief-test.onrender.com").trim().replace(/\/$/, "");
  const greet = L => L.contact_name || `${L.title || ""} ${L.last_name || ""}`.trim() || L.first_name || "there";
  const phoneOf = L => (L.mobile && isMobile(L.mobile)) ? L.mobile : L.phone;

  /* the client-facing wording for each automatic message */
  const T = {
    welcome: L => `Hello ${greet(L)}, thank you for your State Pension check with ${BRAND}. Your reference is ${L.id}. We'll call ${L.best_time ? "in the " + String(L.best_time).split(",")[0].toLowerCase() : "soon"} from ${PHONE}. Save this number so you know it's us. Reply here any time.`,
    finish1: L => `Hello ${L.contact_name || L.first_name || "there"}, you started a State Pension check with ${BRAND} but didn't finish. It takes about a minute to complete: ${SITE}/?resume=${L.partial_token}#check. Or call us on ${PHONE}.`,
    finish2: L => `${BRAND}: your State Pension check is saved and ready to finish whenever suits you: ${SITE}/?resume=${L.partial_token}#check. Prefer to talk it through? Call ${PHONE}, weekdays 9am to 5pm.`,
    missed_call: L => `Hello ${greet(L)}, ${BRAND} tried to call you about your State Pension check (ref ${L.id}). Pick a time that suits you: ${link("/book/" + L.book_token)} or call us on ${PHONE}.`,
    booked: L => `Thank you ${greet(L)}. We'll call you on ${L.booked_at ? new Date(L.booked_at).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }) : "the time you chose"} from ${PHONE}.`,
    id_docs: L => `Hello ${greet(L)}, to finish our identity check we need a photo of your passport or driving licence, and a recent bill or bank letter with your address. Send them here: ${link("/status")} or call ${PHONE} if you'd rather post copies.`,
    sign_chase1: L => `Hello ${greet(L)}, a reminder from ${BRAND}: your documents are ready to read and sign. Use the link we sent, or call ${PHONE} if you'd like paper copies or any help.`,
    sign_chase2: L => `Hello ${greet(L)}, your ${BRAND} documents are still waiting to be signed. There's no rush and no obligation. Call us on ${PHONE} if you have questions or would prefer paper copies.`,
    cooling: L => `Thank you for signing with ${BRAND}, ${greet(L)}. You can cancel free until ${fmtDate(addDays(iso(L.signed_at), 14))}, even if we've started work. Just reply to this message or call ${PHONE}.`,
    ni_share: L => `Hello ${greet(L)}. If you use GOV.UK online, you can speed things up by sending us a screenshot of your National Insurance record. It's optional; we never need your password. How to: ${link("/ni-record")}`,
    waiting: L => `Update from ${BRAND}: we've asked HMRC and DWP for your records. Replies usually take several months. If they write to you directly, please send us a photo of the letter: ${link("/status")}`,
    cf411_chase: L => `Hello ${greet(L)}, your claim form from ${BRAND} is ready to check and sign. Please don't sign if anything looks wrong; call us on ${PHONE} instead.`,
    submitted: L => `Good news from ${BRAND}: we've sent your Home Responsibilities Protection claim to HMRC. HMRC currently takes several months to reply. We'll keep you updated, and you can check progress at ${link("/status")}`,
    periodic: L => `Update from ${BRAND}: your claim is still with HMRC/DWP and this wait is normal. If you receive any letter about your National Insurance or State Pension, please send us a photo: ${link("/status")}`,
    arrears_req: L => `Hello ${greet(L)}. HMRC has made a decision on your claim. When DWP writes to you about your pension arrears, please send us a photo of that letter: ${link("/status")} or call ${PHONE}.`,
    arrears_chase: L => `Hello ${greet(L)}, has DWP written to you about your State Pension arrears yet? Please send us a photo of the letter when it arrives: ${link("/status")}`,
    invoice: L => `Hello ${greet(L)}. DWP has confirmed your arrears. Our invoice ${L.invoice_no} is for ${gbp(Number(L.fee) + Number(L.vat))}, due ${fmtDate(iso(L.invoice_due))}. Pay securely: ${link("/pay/" + L.pay_token)} or call ${PHONE} to arrange a plan.`,
    due_soon: L => `A friendly reminder from ${BRAND}: invoice ${L.invoice_no} is due on ${fmtDate(iso(L.invoice_due))}. Pay securely: ${link("/pay/" + L.pay_token)}. If you need more time, call ${PHONE} and we'll agree a payment plan.`,
    rem1: L => `Hello ${greet(L)}, invoice ${L.invoice_no} from ${BRAND} is now overdue. Pay here: ${link("/pay/" + L.pay_token)}, or call ${PHONE} if you'd like to spread the cost.`,
    rem2: L => `Second reminder from ${BRAND}: invoice ${L.invoice_no} is still unpaid. Please pay at ${link("/pay/" + L.pay_token)} or call ${PHONE}. We can agree a payment plan.`,
    rem3: L => `Final reminder from ${BRAND}: invoice ${L.invoice_no} remains unpaid. Please pay at ${link("/pay/" + L.pay_token)} or call ${PHONE} this week so we can help.`,
    closed: L => `Hello ${greet(L)}. We've finished checking your records and there's nothing to claim this time, so there's nothing to pay. Thank you for choosing ${BRAND}. Questions? Call ${PHONE}.`
  };
  const SUBJECT = { welcome: "We've received your State Pension check", finish1: "Finish your State Pension check", id_docs: "We need a photo of your ID", booked: "Your call is booked", missed_call: "We tried to call you", cooling: "Your 14 days to change your mind", waiting: "We've asked HMRC and DWP for your records", submitted: "Your claim has been sent to HMRC", periodic: "An update on your claim", arrears_req: "HMRC has made a decision", arrears_chase: "Has DWP written to you?", due_soon: "Your invoice is due soon", rem1: "Your invoice is overdue", rem2: "Second reminder", rem3: "Final reminder", closed: "We've finished checking your records", sign_chase1: "Your documents are ready to sign", sign_chase2: "Your documents are waiting", ni_share: "Optional: share your National Insurance record", cf411_chase: "Your claim form is ready to sign", arrears_chaseX: "" };
  /* these are sent as email too when there's a working email address (invoice email is sent separately) */
  const EMAIL_TOO = new Set(["welcome", "finish1", "id_docs", "booked", "cooling", "waiting", "submitted", "periodic", "arrears_req", "arrears_chase", "due_soon", "rem1", "rem2", "rem3", "closed", "ni_share"]);

  async function waTemplates() {
    const r = await pool.query("SELECT value FROM settings WHERE key='wa_templates'");
    try { return JSON.parse((r.rows[0] || {}).value || "{}"); } catch { return {}; }
  }
  const twilioReady = () => !!(TW_SID && TW_TOKEN && (TW_SMS_FROM || TW_WA_FROM));

  /* put a message in the queue, once per lead + key + channel */
  async function queue(L, key, opts = {}) {
    if (L.is_test === undefined) L = (await pool.query("SELECT * FROM leads WHERE id=$1", [L.id])).rows[0];
    const body = opts.body || (T[key] ? T[key](L) : ""); if (!body) return;
    const chans = [];
    const pref = L.contact_pref || "sms";
    if (pref === "post") return;
    const ph = phoneOf(L);
    if ((pref === "whatsapp" || pref === "sms") && ph && !L.phone_bad && isMobile(ph)) chans.push(pref);
    if (L.email && !L.email_bad && (EMAIL_TOO.has(key) || pref === "email" || opts.email)) chans.push("email");
    for (const ch of chans) {
      await pool.query(`INSERT INTO messages(lead_id,channel,to_addr,key,subject,body,status) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [L.id, ch, ch === "email" ? L.email : e164(ph), key, ch === "email" ? `${BRAND}: ${SUBJECT[key] || "an update"}` : null, body, L.is_test ? "test" : "queued"]);
    }
  }

  async function twilioSend(m, L) {
    const isWa = m.channel === "whatsapp";
    const from = isWa ? TW_WA_FROM : TW_SMS_FROM;
    if (!TW_SID || !TW_TOKEN || !from) return { ok: false, error: "not configured" };
    const p = new URLSearchParams({ To: isWa ? "whatsapp:" + m.to_addr : m.to_addr, From: isWa ? "whatsapp:" + from.replace(/^whatsapp:/, "") : from });
    if (isWa) {
      const tpl = (await waTemplates())[m.key];
      if (!tpl) return { ok: false, error: "No approved WhatsApp template for this message" };
      p.set("ContentSid", tpl); p.set("ContentVariables", JSON.stringify({ 1: `${greet(L)}`.trim(), 2: m.body }));
    } else p.set("Body", m.body);
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(TW_SID + ":" + TW_TOKEN).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: p });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, id: j.sid } : { ok: false, error: j.message || "Twilio error " + r.status };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function sendOne(m) {
    const L = (await pool.query("SELECT * FROM leads WHERE id=$1", [m.lead_id])).rows[0]; if (!L) return;
    let res;
    if (m.channel === "email") res = (await sendEmail(m.to_addr, m.subject, m.body + `\n\n${BRAND}\nCall us on ${PHONE}, weekdays 9am to 5pm.`)) ? { ok: true } : { ok: false, error: "Email not configured or failed" };
    else res = await twilioSend(m, L);
    if (res.ok) {
      await pool.query("UPDATE messages SET status='sent', sent_at=now(), provider_id=$2, error=NULL WHERE id=$1", [m.id, res.id || null]);
      await log(L.id, m.channel === "email" ? "email" : m.channel, `Sent automatically (${m.key}): ${m.body.slice(0, 160)}`);
    } else if (m.channel === "whatsapp" && /template|not configured|63016|63024/i.test(res.error) && TW_SMS_FROM) {
      /* WhatsApp couldn't be used: fall back to a text */
      await pool.query("UPDATE messages SET status='failed', error=$2 WHERE id=$1", [m.id, res.error + " (sent by text instead)"]);
      await pool.query(`INSERT INTO messages(lead_id,channel,to_addr,key,body,status) VALUES($1,'sms',$2,$3,$4,'queued') ON CONFLICT DO NOTHING`, [L.id, m.to_addr, m.key, m.body]);
    } else if (/not configured/.test(res.error)) {
      /* leave it queued for staff to send by hand */
    } else await pool.query("UPDATE messages SET status='failed', error=$2 WHERE id=$1", [m.id, clip(res.error, 300)]);
  }

  /* work out which automatic messages are due, then send what's queued */
  const OPEN = `stage <> ALL(ARRAY['paid','closed_none','closed_withdrawn','closed_lost','closed_ineligible','closed_fulltime','closed_duplicate','closed_nocontact','closed_deceased','hold_complaint','hold_sar','fraud_freeze','estate_review'])`;
  async function scan() {
    const t = today();
    const leads = async (where, params = []) => (await pool.query(`SELECT * FROM leads WHERE consent AND NOT no_auto AND ${where}`, params)).rows;
    const vulnerableTask = async L => {
      const r = await pool.query("INSERT INTO messages(lead_id,channel,key,body,status) VALUES($1,'task',$2,$3,'skipped') ON CONFLICT DO NOTHING RETURNING id", [L.id, "vul_" + (L.stage || ""), "Automatic messages are paused for this vulnerable client"]);
      if (r.rows.length) await pool.query("UPDATE leads SET next_action=$2, next_action_date=current_date WHERE id=$1", [L.id, "Vulnerable client: contact them personally (automatic messages are paused)"]);
    };
    const q = async (L, key) => { if (L.vulnerable) return vulnerableTask(L); await queue(L, key); };
    for (const L of await leads(`partial AND partial_token IS NOT NULL AND updated_at < now() - interval '1 hour' AND created_at > now() - interval '14 days'`)) await q(L, "finish1");
    for (const L of await leads(`partial AND partial_token IS NOT NULL AND updated_at < now() - interval '24 hours' AND created_at > now() - interval '14 days'`)) await q(L, "finish2");
    for (const L of await leads(`${OPEN} AND EXISTS (SELECT 1 FROM sign_requests r WHERE r.lead_id=leads.id AND r.kind='pack' AND r.status IN ('sent','opened') AND r.created_at < now() - interval '3 days')`)) await q(L, "sign_chase1");
    for (const L of await leads(`${OPEN} AND EXISTS (SELECT 1 FROM sign_requests r WHERE r.lead_id=leads.id AND r.kind='pack' AND r.status IN ('sent','opened') AND r.created_at < now() - interval '7 days')`)) await q(L, "sign_chase2");
    for (const L of await leads(`${OPEN} AND signed_at IS NOT NULL AND signed_at BETWEEN $1::date - 12 AND $1::date - 1`, [t])) await q(L, "cooling");
    for (const L of await leads(`stage = 'ni_wait'`)) await q(L, "ni_share");
    for (const L of await leads(`${OPEN} AND (soa_sent_at IS NOT NULL OR dwp_sent_at IS NOT NULL) AND stage NOT IN ('decision','invoiced','payment_plan')`)) await q(L, "waiting");
    for (const L of await leads(`${OPEN} AND EXISTS (SELECT 1 FROM sign_requests r WHERE r.lead_id=leads.id AND r.kind='cf411' AND r.status IN ('sent','opened') AND r.created_at < now() - interval '4 days')`)) await q(L, "cf411_chase");
    for (const L of await leads(`stage = 'submitted' AND submitted_at IS NOT NULL`)) await q(L, "submitted");
    for (const L of await leads(`${OPEN} AND stage IN ('ni_requested','dwp_requested','preparing','submitted','cf411_info','dwp_more','resubmit_648','hmrc_agent','uplift_dwp') AND coalesce(submitted_at, soa_sent_at, dwp_sent_at, signed_at) IS NOT NULL`)) {
      const n = Math.floor((Date.parse(t) - Date.parse(iso(L.submitted_at || L.soa_sent_at || L.dwp_sent_at || L.signed_at))) / 86400e3 / 56);
      if (n >= 1) { if (L.vulnerable) await vulnerableTask(L); else await queue(L, "periodic_" + n, { body: T.periodic(L) }); }
    }
    for (const L of await leads(`stage = 'decision'`)) await q(L, "arrears_req");
    for (const L of await leads(`stage = 'decision' AND NOT arrears_letter AND decision_at <= $1::date - 14`, [t])) await q(L, "arrears_chase");
    for (const L of await leads(`stage = 'invoiced' AND pay_token IS NOT NULL`)) await q(L, "invoice");
    for (const L of await leads(`stage = 'invoiced' AND invoice_due BETWEEN $1::date AND $1::date + 3`, [t])) await q(L, "due_soon");
    for (const [k, d] of [["rem1", 3], ["rem2", 10], ["rem3", 17]]) {
      for (const L of await leads(`stage = 'invoiced' AND invoice_due <= $1::date - ${d}`, [t])) {
        const before = (await pool.query("SELECT 1 FROM messages WHERE lead_id=$1 AND key=$2", [L.id, k])).rows.length;
        await q(L, k);
        if (!before && !L.vulnerable) { await pool.query("UPDATE leads SET reminders=GREATEST(reminders, $2), last_reminder=current_date WHERE id=$1", [L.id, Number(k.slice(3))]); await log(L.id, "fee", `Payment reminder ${k.slice(3)} queued automatically`); }
      }
    }
    /* after three reminders, a manager reviews before any final notice */
    for (const L of await leads(`stage = 'invoiced' AND invoice_due <= $1::date - 24`, [t])) {
      await pool.query("UPDATE leads SET stage='fee_review', next_action='Fee resolution review: manager checks the case, vulnerability and hardship before any final notice', next_action_date=current_date, updated_at=now() WHERE id=$1", [L.id]);
      await log(L.id, "fee", "Three reminders sent and still unpaid: moved to fee resolution review");
    }
    for (const L of await leads(`stage IN ('closed_none','closed_fulltime','closed_ineligible') AND updated_at > now() - interval '14 days'`)) await q(L, "closed");
  }
  async function sendDue() {
    if (!inWindow()) return 0;
    const { rows } = await pool.query("SELECT * FROM messages WHERE status='queued' AND direction='out' AND channel <> 'task' ORDER BY id LIMIT 100");
    for (const m of rows) await sendOne(m);
    return rows.length;
  }
  async function run() { try { await scan(); await sendDue(); } catch (e) { console.error("Messaging run failed:", e.message); } }

  return {
    INIT_SQL, queue, run, e164, isMobile, T,
    start() { setTimeout(run, 20e3); setInterval(run, 10 * 60e3); },
    publicRoutes(app) {
      /* replies from clients by text or WhatsApp (Twilio webhook) */
      app.post("/twilio/inbound", async (req, res) => {
        if (TW_TOKEN) {
          const url = (base || `https://${req.headers.host}`) + req.originalUrl;
          const data = url + Object.keys(req.body || {}).sort().map(k => k + req.body[k]).join("");
          const sig = crypto.createHmac("sha1", TW_TOKEN).update(Buffer.from(data, "utf-8")).digest("base64");
          const got = String(req.headers["x-twilio-signature"] || "");
          if (sig.length !== got.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(got))) return res.status(403).send("Forbidden");
        }
        const from = String(req.body.From || ""), wa = from.startsWith("whatsapp:"), num = from.replace(/^whatsapp:/, "");
        const text = clip(req.body.Body, 2000);
        const digits = num.replace(/\D/g, "").slice(-10);
        const L = digits.length >= 10 ? (await pool.query("SELECT * FROM leads WHERE NOT is_test AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1 ORDER BY updated_at DESC LIMIT 1", [digits])).rows[0] : null;
        await pool.query("INSERT INTO messages(lead_id,direction,channel,from_addr,body,status) VALUES($1,'in',$2,$3,$4,'received')", [L ? L.id : null, wa ? "whatsapp" : "sms", num, text || "(no text)"]);
        if (L) {
          await log(L.id, wa ? "whatsapp" : "sms", `Client replied: ${text}`);
          if (/^\s*(stop|unsubscribe|cancel texts)\s*$/i.test(text)) { await pool.query("UPDATE leads SET no_auto=true WHERE id=$1", [L.id]); await log(L.id, "check", "Client replied STOP: automatic messages turned off"); }
          else if (/^\s*cancel\b/i.test(text)) await pool.query("UPDATE leads SET next_action='Client may want to cancel: call them today', next_action_date=current_date, updated_at=now() WHERE id=$1", [L.id]);
          else await pool.query("UPDATE leads SET next_action='Reply to the client''s message', next_action_date=current_date, updated_at=now() WHERE id=$1", [L.id]);
        }
        res.set("Content-Type", "text/xml"); res.send("<Response></Response>");
      });
    },
    staffRoutes(app) {
      app.use((req, res, next) => { if (!base && req.headers.host) base = "https://" + req.headers.host; next(); });
      app.get("/messages", async (req, res) => {
        const queued = (await pool.query("SELECT m.*, l.first_name, l.last_name FROM messages m LEFT JOIN leads l ON l.id=m.lead_id WHERE m.status IN ('queued','failed') AND m.direction='out' AND m.channel <> 'task' ORDER BY m.id LIMIT 300")).rows;
        const inbound = (await pool.query("SELECT m.*, l.first_name, l.last_name FROM messages m LEFT JOIN leads l ON l.id=m.lead_id WHERE m.direction='in' ORDER BY m.id DESC LIMIT 50")).rows;
        const sent = (await pool.query("SELECT m.*, l.first_name, l.last_name FROM messages m LEFT JOIN leads l ON l.id=m.lead_id WHERE m.status IN ('sent','manual','test') AND m.direction='out' ORDER BY m.id DESC LIMIT 100")).rows;
        const who = m => m.lead_id ? `<a href="/lead/${m.lead_id}">${esc(m.first_name)} ${esc(m.last_name)}</a>` : "Unknown number";
        const ch = c => ({ sms: "Text", whatsapp: "WhatsApp", email: "Email" })[c] || c;
        res.send(page("Messages", `${req.query.done ? `<div class="flash">${esc(req.query.done)}</div>` : ""}<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h1>Messages</h1><form method="post" action="/messages/run"><button class="btn ghost">Check for messages now</button></form></div>
          <p class="muted">Automatic messages go out weekdays 9am to 7pm UK time. ${twilioReady() ? "Texts and WhatsApp are connected through Twilio." : "<b>Twilio isn't connected yet</b>, so texts and WhatsApp wait here: send them from your phone and click \"Sent by hand\"."} Vulnerable clients and anyone who replied STOP don't get automatic messages.</p>
          <div class="panel tablewrap"><h2>Waiting to send <span class="pill">${queued.length}</span></h2><table><thead><tr><th>Client</th><th>How</th><th>To</th><th>Message</th><th></th></tr></thead><tbody>
          ${queued.map(m => `<tr><td>${who(m)}</td><td>${ch(m.channel)}${m.status === "failed" ? `<br><span class="pill bad">Failed</span><br><small class="muted">${esc(m.error)}</small>` : ""}</td><td class="num">${esc(m.to_addr)}</td><td style="max-width:460px">${esc(m.body)}</td>
            <td><form method="post" action="/messages/${m.id}/manual"><button class="btn ghost" style="padding:4px 10px">Sent by hand</button></form><form method="post" action="/messages/${m.id}/retry"><button class="btn ghost" style="padding:4px 10px">Send now</button></form><form method="post" action="/messages/${m.id}/cancel"><button class="btn ghost" style="padding:4px 10px">Don't send</button></form></td></tr>`).join("") || `<tr><td colspan="5" class="muted">Nothing waiting.</td></tr>`}</tbody></table></div>
          <div class="panel tablewrap"><h2>Replies from clients</h2><table><tbody>${inbound.map(m => `<tr><td>${fmtDate(iso(m.created_at))}</td><td>${who(m)}</td><td>${ch(m.channel)} from ${esc(m.from_addr)}</td><td>${esc(m.body)}</td></tr>`).join("") || `<tr><td class="muted">No replies yet. Point Twilio's incoming message webhook at /twilio/inbound to collect them.</td></tr>`}</tbody></table></div>
          <div class="panel tablewrap"><h2>Recently sent</h2><table><tbody>${sent.map(m => `<tr><td>${fmtDate(iso(m.sent_at || m.created_at))}</td><td>${who(m)}</td><td>${ch(m.channel)}${m.status === "test" ? ` <span class="pill">Test, not sent</span>` : m.status === "manual" ? ` <span class="pill">By hand</span>` : ""}</td><td>${esc(m.body.slice(0, 140))}</td></tr>`).join("") || `<tr><td class="muted">None yet.</td></tr>`}</tbody></table></div>`, { nav: "messages" }));
      });
      app.post("/messages/run", async (req, res) => {
        await scan(); const n = await sendDue();
        res.redirect("/messages?done=" + encodeURIComponent(inWindow() ? `Checked. ${n} message${n === 1 ? "" : "s"} processed.` : "Checked and queued. Messages only go out weekdays 9am to 7pm UK time."));
      });
      app.post("/messages/:mid/manual", async (req, res) => {
        const m = (await pool.query("UPDATE messages SET status='manual', sent_at=now() WHERE id=$1 RETURNING *", [req.params.mid])).rows[0];
        if (m && m.lead_id) await log(m.lead_id, m.channel, `Sent by hand (${m.key}): ${m.body.slice(0, 160)}`);
        res.redirect("/messages");
      });
      app.post("/messages/:mid/cancel", async (req, res) => { await pool.query("UPDATE messages SET status='cancelled' WHERE id=$1", [req.params.mid]); res.redirect("/messages"); });
      app.post("/messages/:mid/retry", async (req, res) => {
        const m = (await pool.query("UPDATE messages SET status='queued', error=NULL WHERE id=$1 RETURNING *", [req.params.mid])).rows[0];
        if (m) await sendOne(m);
        const after = m ? (await pool.query("SELECT status, error FROM messages WHERE id=$1", [m.id])).rows[0] : null;
        res.redirect("/messages?done=" + encodeURIComponent(!after ? "Not found" : after.status === "sent" ? "Sent." : after.status === "queued" ? "Not sent: no provider connected for this channel. Send it by hand." : "Failed: " + (after.error || "")));
      });
      app.post("/lead/:id/message", async (req, res) => {
        const L = (await pool.query("SELECT * FROM leads WHERE id=$1", [req.params.id])).rows[0]; if (!L) return res.redirect("/");
        const ch = ["sms", "whatsapp", "email"].includes(req.body.channel) ? req.body.channel : "sms", body = clip(req.body.body, 1000);
        if (!body) return res.redirect("/lead/" + L.id);
        const to = ch === "email" ? L.email : e164(phoneOf(L));
        const m = (await pool.query("INSERT INTO messages(lead_id,channel,to_addr,subject,body,status,key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [L.id, ch, to, `${BRAND}: a message about your claim`, body, L.is_test ? "test" : "queued", "manual_" + Date.now()])).rows[0];
        /* a reply inside 24 hours of the client's own WhatsApp can be free text; otherwise WhatsApp needs a template */
        if (!L.is_test) { if (ch === "whatsapp") { const recent = (await pool.query("SELECT 1 FROM messages WHERE lead_id=$1 AND direction='in' AND channel='whatsapp' AND created_at > now() - interval '24 hours'", [L.id])).rows.length; if (recent) { const r = await twilioSendFree(m); if (r) { res.redirect("/lead/" + L.id + "?ok=1"); return; } } } await sendOne(m); }
        res.redirect("/lead/" + L.id + "?ok=1");
      });
      app.post("/lead/:id/contact-pref", async (req, res) => {
        const pref = ["sms", "whatsapp", "email", "post"].includes(req.body.contact_pref) ? req.body.contact_pref : null;
        await pool.query("UPDATE leads SET contact_pref=$2, no_auto=$3, updated_at=now() WHERE id=$1", [req.params.id, pref, req.body.no_auto === "1"]);
        await log(req.params.id, "check", `Contact preference: ${({ sms: "text", whatsapp: "WhatsApp", email: "email", post: "post only" })[pref] || "not set"}${req.body.no_auto === "1" ? "; automatic messages off" : ""}`);
        res.redirect("/lead/" + req.params.id + "?ok=1");
      });
      app.post("/admin/whatsapp", async (req, res) => {
        const keys = Object.keys(T); const out = {};
        for (const k of keys) { const v = clip(req.body["wa_" + k], 60); if (/^HX[0-9a-fA-F]{32}$/.test(v)) out[k] = v; }
        await pool.query("INSERT INTO settings(key,value) VALUES('wa_templates',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(out)]);
        res.redirect("/admin?done=" + encodeURIComponent(`${Object.keys(out).length} WhatsApp template${Object.keys(out).length === 1 ? "" : "s"} saved.`));
      });
    },
    async leadPanel(L) {
      const ms = (await pool.query("SELECT * FROM messages WHERE lead_id=$1 AND channel <> 'task' ORDER BY id DESC LIMIT 8", [L.id])).rows;
      const ch = c => ({ sms: "Text", whatsapp: "WhatsApp", email: "Email" })[c] || c;
      return `<div class="panel"><h2>Messages</h2>
        <form method="post" action="/lead/${L.id}/contact-pref" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:0">
          <label>Prefers <select name="contact_pref">${[["sms", "Text"], ["whatsapp", "WhatsApp"], ["email", "Email"], ["post", "Post only"]].map(([k, v]) => `<option value="${k}" ${(L.contact_pref || "sms") === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" name="no_auto" value="1" ${L.no_auto ? "checked" : ""}> No automatic messages</label>
          <button class="btn ghost" style="padding:4px 10px">Save</button></form>
        ${L.phone && !isMobile(phoneOf(L)) ? `<small class="muted">${esc(L.phone)} looks like a landline and there's no mobile, so texts and WhatsApp can't be sent.</small>` : ""}${L.contact_name ? `<small class="muted">Messages go to ${esc(L.contact_name)} (${esc(L.helper_relation || "helper")}).</small>` : ""}
        ${L.vulnerable ? `<small class="muted">Vulnerable client: automatic messages are paused.</small>` : ""}
        <form method="post" action="/lead/${L.id}/message" style="display:grid;gap:6px;margin:0">
          <div style="display:flex;gap:8px"><select name="channel"><option value="whatsapp">WhatsApp</option><option value="sms">Text</option><option value="email">Email</option></select></div>
          <textarea name="body" rows="2" placeholder="Write a message to the client"></textarea><button class="btn ghost">Send</button></form>
        ${ms.length ? `<table><tbody>${ms.map(m => `<tr><td><small>${fmtDate(iso(m.sent_at || m.created_at))}</small></td><td><small>${m.direction === "in" ? "From client, " : ""}${ch(m.channel)} · ${esc(m.status)}</small></td><td><small>${esc(m.body.slice(0, 120))}</small></td></tr>`).join("")}</tbody></table>` : ""}</div>`;
    },
    async waForm() {
      const W = await waTemplates();
      return `<form class="panel" method="post" action="/admin/whatsapp"><h2>WhatsApp templates</h2>
        <p class="muted">WhatsApp only allows businesses to start conversations with templates Meta has approved. Create one template per message in Twilio (Content Template Builder) with two variables: {{1}} for the client's name and {{2}} for the message text, then paste each Content SID (starts HX) here. Until a template is set, that message goes by text instead. Replies within 24 hours of a client's own WhatsApp message don't need a template.</p>
        <div class="grid2">${Object.keys(T).map(k => `<label>${esc(k)} <input name="wa_${k}" value="${esc(W[k] || "")}" placeholder="HX…"></label>`).join("")}</div><button>Save templates</button></form>`;
    }
  };

  /* free-text WhatsApp reply inside the 24-hour window */
  async function twilioSendFree(m) {
    if (!TW_SID || !TW_TOKEN || !TW_WA_FROM) return false;
    const p = new URLSearchParams({ To: "whatsapp:" + m.to_addr, From: "whatsapp:" + TW_WA_FROM.replace(/^whatsapp:/, ""), Body: m.body });
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(TW_SID + ":" + TW_TOKEN).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: p });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { await pool.query("UPDATE messages SET status='sent', sent_at=now(), provider_id=$2 WHERE id=$1", [m.id, j.sid]); await log(m.lead_id, "whatsapp", "Sent: " + m.body.slice(0, 160)); return true; }
    } catch { }
    return false;
  }
};
module.exports.INIT_SQL = INIT_SQL;
