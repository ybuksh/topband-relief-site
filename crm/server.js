"use strict";
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const BRAND = process.env.BRAND || "Missing Years";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SITE_ORIGINS = (process.env.SITE_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";
const PHONE = process.env.PHONE || "0800 999 999";
const FEE_RATE = 0.30, VAT_RATE = 0.20, PAY_DAYS = 14;

const DB_URL = process.env.DATABASE_URL || process.env.database_url || "";
const pool = DB_URL
  ? new Pool({ connectionString: DB_URL, ssl: DB_URL.includes("render.com") ? { rejectUnauthorized: false } : false })
  : null;

/* ---------- stages ---------- */
const STAGES = [
  { id: "new", label: "New enquiry", next: ["Call the client", 0] },
  { id: "contacted", label: "Called", next: ["Follow up call", 2] },
  { id: "qualified", label: "Qualified", next: ["Send sign-up pack", 0] },
  { id: "pack_sent", label: "Pack sent", next: ["Chase signature", 3] },
  { id: "signed", label: "Signed", next: ["Prepare claim (cooling-off ends in 14 days)", 14] },
  { id: "preparing", label: "Preparing claim", next: ["Check and send claim to HMRC", 3] },
  { id: "submitted", label: "With HMRC", next: ["Monthly update to client; chase HMRC if past reply date", 30] },
  { id: "decision", label: "Decision received", next: ["Get the DWP award letter from the client", 7] },
  { id: "invoiced", label: "Invoiced", next: ["Chase payment if unpaid", PAY_DAYS] },
  { id: "paid", label: "Fee paid", next: ["Ask for a review and referral", 1] },
  { id: "closed_none", label: "Closed: nothing owed", next: null },
  { id: "closed_lost", label: "Closed: not going ahead", next: null }
];
const STAGE = Object.fromEntries(STAGES.map(s => [s.id, s]));
const OPEN_STAGES = STAGES.filter(s => !s.id.startsWith("closed") && s.id !== "paid");

const LABELS = {
  cb: { yes: "Yes", partner: "Partner claimed, client was main carer", no: "No", unsure: "Not sure" },
  care: { yes: "Yes", no: "No" },
  for_whom: { me: "Themselves", help: "Someone they're helping", died: "Someone who has died" },
  pension: { less: "Less than full", full: "Full", none: "Not receiving yet", unsure: "Not sure" },
  marital: { married: "Married or civil partnership", widowed: "Widowed", divorced: "Divorced or dissolved", single: "Single" },
  credit: { yes: "Yes", no: "No", unsure: "Not sure" }
};

/* ---------- helpers ---------- */
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const gbp = n => n == null || n === "" ? "" : "£" + Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
function addDays(d, n) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function nextWorkingDay(d) { let x = addDays(d, 1); while ([0, 6].includes(new Date(x + "T12:00:00Z").getUTCDay())) x = addDays(x, 1); return x; }
const fmtDate = d => d ? new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const iso = d => d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : "";
const label = (k, v) => (LABELS[k] && LABELS[k][v]) || v || "";
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

/* ---------- auth ---------- */
function sign(v) { return crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex"); }
function makeSession() { const exp = Date.now() + 12 * 3600e3; return exp + "." + sign(String(exp)); }
function validSession(c) {
  if (!c) return false; const [exp, mac] = c.split("."); if (!exp || !mac || Number(exp) < Date.now()) return false;
  const good = sign(exp); return mac.length === good.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good));
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map(p => p.trim().split("=").map(decodeURIComponent)).filter(p => p[0])); }
function requireAuth(req, res, next) {
  if (validSession(cookies(req).s)) return next();
  res.redirect("/login");
}
function sameOrigin(req, res, next) {
  const o = req.headers.origin; if (o && !o.endsWith(req.headers.host)) return res.status(403).send("Forbidden");
  next();
}

/* ---------- database ---------- */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      stage TEXT NOT NULL DEFAULT 'new',
      source TEXT, cb TEXT, care TEXT, for_whom TEXT, pension TEXT, born INT, marital TEXT, credit TEXT,
      title TEXT, first_name TEXT, last_name TEXT, maiden_name TEXT, email TEXT, phone TEXT, best_time TEXT,
      consent BOOLEAN NOT NULL DEFAULT false, consent_text TEXT,
      next_action TEXT, next_action_date DATE,
      signed_at DATE, submitted_at DATE, decision_at DATE,
      arrears NUMERIC(12,2), fee NUMERIC(12,2), vat NUMERIC(12,2), invoice_date DATE, invoice_due DATE, paid_at DATE,
      owner TEXT
    );
    CREATE TABLE IF NOT EXISTS activity (
      id SERIAL PRIMARY KEY,
      lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads(stage);
    CREATE INDEX IF NOT EXISTS activity_lead_idx ON activity(lead_id);
  `);
}
const log = (id, kind, text) => pool.query("INSERT INTO activity(lead_id,kind,text) VALUES($1,$2,$3)", [id, kind, text]);

/* ---------- email (optional, via Resend) ---------- */
async function sendEmail(to, subject, text) {
  if (!RESEND_API_KEY || !FROM_EMAIL || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, text })
    });
    return r.ok;
  } catch { return false; }
}

/* ---------- layout ---------- */
function page(title, body, opts = {}) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)} · ${esc(BRAND)} CRM</title>
<style>
:root{--bg:#F6F4F7;--paper:#fff;--ink:#221A26;--muted:#5E5464;--line:#E2DAE6;--accent:#6B3E75;--accent-ink:#fff;--tint:#F0E7F3;--warn:#9A5B12;--warn-tint:#FBEEDB;--bad:#A3302A;--bad-tint:#FBE6E4;--good:#2F6B4F;--good-tint:#E3F1E9}
@media (prefers-color-scheme:dark){:root{--bg:#151018;--paper:#1E1722;--ink:#F1EBF3;--muted:#B7AABD;--line:#3A2F40;--accent:#C99BD4;--accent-ink:#1A1020;--tint:#33243A;--warn:#E6A55B;--warn-tint:#3A2A16;--bad:#F08A82;--bad-tint:#3A1D1B;--good:#7FD1A6;--good-tint:#1D3329;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}h1,h2,h3{margin:0;line-height:1.2}h1{font-size:1.5rem}h2{font-size:1.1rem}
header{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:12px max(16px,env(safe-area-inset-left));background:var(--paper);border-bottom:1px solid var(--line);flex-wrap:wrap}
header nav{display:flex;gap:16px;flex-wrap:wrap}header nav a{text-decoration:none;font-weight:600;color:var(--muted)}header nav a.on{color:var(--ink)}
main{padding:20px max(16px,env(safe-area-inset-left));max-width:1400px;margin:0 auto;display:grid;gap:18px}
.board{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;align-items:flex-start}
.col{flex:0 0 240px;background:var(--tint);border-radius:12px;padding:10px;display:grid;gap:8px}
.col h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between}
.card{display:block;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:10px;text-decoration:none;color:var(--ink)}
.card:hover{border-color:var(--accent)}.card b{display:block}.card small{color:var(--muted);display:block}
.due{font-size:.8rem;font-weight:600;margin-top:4px}.due.over{color:var(--bad)}.due.today{color:var(--warn)}
.panel{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;display:grid;gap:12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:860px){.grid2{grid-template-columns:1fr}}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;font-weight:500}
form.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:end}
label{display:grid;gap:4px;font-weight:600;font-size:.9rem}
input,select,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
textarea{min-height:70px;width:100%}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:8px;padding:9px 14px;background:var(--accent);color:var(--accent-ink);cursor:pointer;text-decoration:none;display:inline-block}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:.85rem}
.tablewrap{overflow-x:auto}
.pill{display:inline-block;font-size:.78rem;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--tint);color:var(--accent)}
.pill.good{background:var(--good-tint);color:var(--good)}.pill.bad{background:var(--bad-tint);color:var(--bad)}
.log{display:grid;gap:8px;max-height:420px;overflow:auto}.log div{border-left:3px solid var(--line);padding-left:10px}.log small{color:var(--muted)}
.stats{display:flex;gap:12px;flex-wrap:wrap}.stat{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:12px 16px;min-width:150px}
.stat b{display:block;font-size:1.4rem;font-variant-numeric:tabular-nums}.stat small{color:var(--muted)}
.muted{color:var(--muted)}.num{font-variant-numeric:tabular-nums}
.flash{background:var(--good-tint);color:var(--good);padding:10px 14px;border-radius:8px;font-weight:600}
</style></head><body>
${opts.bare ? "" : `<header><strong>${esc(BRAND)} CRM</strong><nav>
<a href="/" class="${opts.nav === "board" ? "on" : ""}">Pipeline</a>
<a href="/today" class="${opts.nav === "today" ? "on" : ""}">Today</a>
<a href="/money" class="${opts.nav === "money" ? "on" : ""}">Fees</a>
<a href="/closed" class="${opts.nav === "closed" ? "on" : ""}">Closed</a>
<a href="/new" class="${opts.nav === "new" ? "on" : ""}">Add enquiry</a>
<a href="/export.csv">Export</a>
<a href="/logout">Log out</a></nav></header>`}
<main>${body}</main></body></html>`;
}
function dueBadge(d) {
  if (!d) return "";
  const s = iso(d), t = today();
  const cls = s < t ? "over" : s === t ? "today" : "";
  return `<div class="due ${cls}">${s < t ? "Overdue: " : s === t ? "Due today: " : "Next: "}${fmtDate(s)}</div>`;
}

/* ---------- app ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
/* pass errors from async handlers to the error page */
for (const m of ["get", "post"]) {
  const orig = app[m].bind(app);
  app[m] = (path, ...hs) => hs.length ? orig(path, ...hs.map(h => (req, res, next) => { try { const r = h(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } })) : orig(path);
}
app.use(express.urlencoded({ extended: false, limit: "50kb" }));
app.use("/api", express.json({ limit: "20kb" }));

app.get("/healthz", (req, res) => res.send("ok"));

if (!pool || !ADMIN_PASSWORD) {
  app.use((req, res) => res.status(503).send(page("Setup needed", `<div class="panel"><h1>Almost ready</h1>
  <p>Add these settings in Render, under this service's <b>Environment</b> tab, then the CRM will start:</p>
  <ul>${!pool ? "<li><b>DATABASE_URL</b>: copy the <i>Internal Database URL</i> from the database's page in Render</li>" : ""}
  ${!ADMIN_PASSWORD ? "<li><b>ADMIN_PASSWORD</b>: the password staff will use to log in</li>" : ""}</ul></div>`, { bare: true })));
} else {

/* public: website enquiries */
const hits = new Map();
app.use("/api", (req, res, next) => {
  const o = req.headers.origin || "";
  if (SITE_ORIGINS.length === 0 || SITE_ORIGINS.includes(o)) res.set("Access-Control-Allow-Origin", o || "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Vary", "Origin");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.post("/api/leads", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
    if (list.length >= 10) return res.status(429).json({ ok: false, error: "Too many submissions. Please call us instead." });
    list.push(now); hits.set(ip, list);
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // honeypot
    const f = {
      cb: clip(b.cb, 20), care: clip(b.care, 10), for_whom: clip(b.for, 10), pension: clip(b.pension, 10),
      born: parseInt(b.born, 10) || null, marital: clip(b.status, 12), credit: clip(b.credit, 10),
      title: clip(b.ti, 10), first_name: clip(b.fn, 80), last_name: clip(b.ln, 80), maiden_name: clip(b.mn, 80),
      email: clip(b.em, 160), phone: clip(b.ph, 30), best_time: clip(b.bt, 60), consent: b.ok === true || b.ok === "true",
      consent_text: clip(b.consent_text, 400), source: clip(b.source || "website", 60)
    };
    if (!f.first_name || !f.last_name || (!f.email && !f.phone) || !f.consent)
      return res.status(400).json({ ok: false, error: "Please fill in your name, a phone number or email, and tick the consent box." });
    const due = nextWorkingDay(today());
    const r = await pool.query(`INSERT INTO leads(source,cb,care,for_whom,pension,born,marital,credit,title,first_name,last_name,maiden_name,email,phone,best_time,consent,consent_text,next_action,next_action_date)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [f.source, f.cb, f.care, f.for_whom, f.pension, f.born, f.marital, f.credit, f.title, f.first_name, f.last_name, f.maiden_name, f.email, f.phone, f.best_time, f.consent, f.consent_text, "Call the client (" + (f.best_time || "any time") + ")", due]);
    const id = r.rows[0].id;
    await log(id, "created", "Enquiry received from " + f.source + (f.consent ? ", consent to contact given" : ""));
    sendEmail(f.email, `${BRAND}: we've received your State Pension check`,
      `Dear ${f.title ? f.title + " " : ""}${f.last_name},\n\nThank you for completing our State Pension check. One of our team will call you within one working day${f.best_time ? " (" + f.best_time.toLowerCase() + ")" : ""} to go through your record.\n\nThere is nothing to pay and no obligation. You can also apply to HMRC yourself for free.\n\nIf you have any questions, call us free on ${PHONE}, weekdays 9am to 5pm.\n\n${BRAND}`)
      .then(ok => ok && log(id, "email", "Confirmation email sent to client"));
    sendEmail(NOTIFY_EMAIL, `New enquiry #${id}: ${f.first_name} ${f.last_name}`, `New enquiry from the website.\nBest time to call: ${f.best_time || "not given"}\nPhone: ${f.phone}\n\nOpen the CRM to view it.`);
    res.json({ ok: true, ref: id });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: "Something went wrong. Please call us instead." }); }
});

/* login */
app.get("/login", (req, res) => res.send(page("Log in", `<form class="panel" method="post" action="/login" style="max-width:360px;margin:40px auto">
<h1>${esc(BRAND)} CRM</h1>${req.query.e ? `<p class="pill bad">That password didn't match. Try again.</p>` : ""}
<label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button>Log in</button></form>`, { bare: true })));
const tries = new Map();
app.post("/login", (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const t = (tries.get(ip) || []).filter(x => Date.now() - x < 15 * 60e3);
  if (t.length >= 8) return res.status(429).send("Too many attempts. Wait 15 minutes.");
  const p = String(req.body.password || ""), a = crypto.createHash("sha256").update(p).digest(), b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) { t.push(Date.now()); tries.set(ip, t); return res.redirect("/login?e=1"); }
  res.set("Set-Cookie", `s=${makeSession()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
  res.redirect("/");
});
app.get("/logout", (req, res) => { res.set("Set-Cookie", "s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"); res.redirect("/login"); });

app.use(requireAuth);
app.use(sameOrigin);

/* pipeline board */
app.get("/", async (req, res) => {
  const q = clip(req.query.q, 80);
  const params = q ? ["%" + q + "%"] : [];
  const where = q ? "AND (first_name ILIKE $1 OR last_name ILIKE $1 OR maiden_name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1)" : "";
  const { rows } = await pool.query(`SELECT * FROM leads WHERE stage <> ALL(ARRAY['paid','closed_none','closed_lost']) ${where} ORDER BY next_action_date NULLS LAST, created_at`, params);
  const stats = (await pool.query(`SELECT
     count(*) FILTER (WHERE created_at > now() - interval '7 days') AS week,
     count(*) FILTER (WHERE stage = 'new') AS new,
     count(*) FILTER (WHERE next_action_date <= current_date AND stage <> ALL(ARRAY['paid','closed_none','closed_lost'])) AS due,
     count(*) FILTER (WHERE stage = 'submitted') AS hmrc,
     coalesce(sum(fee + vat) FILTER (WHERE stage = 'invoiced'),0) AS owed
     FROM leads`)).rows[0];
  const cols = OPEN_STAGES.map(s => {
    const items = rows.filter(r => r.stage === s.id);
    return `<section class="col"><h2>${esc(s.label)} <span>${items.length}</span></h2>${items.map(r => `<a class="card" href="/lead/${r.id}">
      <b>${esc(r.title)} ${esc(r.first_name)} ${esc(r.last_name)}</b>
      <small>${r.born ? "Born " + r.born + " · " : ""}${esc(label("pension", r.pension))}${r.for_whom && r.for_whom !== "me" ? " · " + esc(label("for_whom", r.for_whom)) : ""}</small>
      ${dueBadge(r.next_action_date)}</a>`).join("") || `<small class="muted">None</small>`}</section>`;
  }).join("");
  res.send(page("Pipeline", `
  <div class="stats">
    <div class="stat"><b>${stats.new}</b><small>New, not yet called</small></div>
    <div class="stat"><b>${stats.due}</b><small>Actions due or overdue</small></div>
    <div class="stat"><b>${stats.week}</b><small>Enquiries in last 7 days</small></div>
    <div class="stat"><b>${stats.hmrc}</b><small>Claims with HMRC</small></div>
    <div class="stat"><b>${gbp(stats.owed)}</b><small>Invoiced, not yet paid</small></div>
  </div>
  <form class="inline" method="get" action="/"><label>Search <input name="q" value="${esc(q)}" placeholder="Name, phone or email"></label><button class="btn ghost">Search</button>${q ? `<a class="btn ghost" href="/">Clear</a>` : ""}</form>
  <div class="board">${cols}</div>`, { nav: "board" }));
});

/* today */
app.get("/today", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE next_action_date <= current_date AND stage <> ALL(ARRAY['paid','closed_none','closed_lost']) ORDER BY next_action_date, created_at`);
  res.send(page("Today", `<h1>Due today and overdue (${rows.length})</h1>
  <div class="panel tablewrap"><table><thead><tr><th>Due</th><th>Client</th><th>Stage</th><th>Action</th><th>Phone</th><th>Best time</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td>${dueBadge(r.next_action_date)}</td><td><a href="/lead/${r.id}">${esc(r.first_name)} ${esc(r.last_name)}</a></td><td>${esc(STAGE[r.stage]?.label)}</td><td>${esc(r.next_action)}</td><td class="num">${esc(r.phone)}</td><td>${esc(r.best_time)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Nothing due. New enquiries will appear here on the next working day.</td></tr>`}
  </tbody></table></div>`, { nav: "today" }));
});

/* fees */
app.get("/money", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE stage IN ('decision','invoiced','paid') ORDER BY invoice_due NULLS FIRST`);
  const t = rows.reduce((a, r) => { const tot = Number(r.fee || 0) + Number(r.vat || 0); if (r.stage === "paid") a.paid += tot; else if (r.stage === "invoiced") a.owed += tot; a.arrears += Number(r.arrears || 0); return a; }, { paid: 0, owed: 0, arrears: 0 });
  res.send(page("Fees", `<div class="stats">
  <div class="stat"><b>${gbp(t.arrears)}</b><small>Arrears won for clients</small></div>
  <div class="stat"><b>${gbp(t.owed)}</b><small>Invoiced, unpaid (inc. VAT)</small></div>
  <div class="stat"><b>${gbp(t.paid)}</b><small>Fees received (inc. VAT)</small></div></div>
  <div class="panel tablewrap"><table><thead><tr><th>Client</th><th>Stage</th><th>Arrears</th><th>Fee + VAT</th><th>Invoiced</th><th>Due</th><th>Paid</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td><a href="/lead/${r.id}">${esc(r.first_name)} ${esc(r.last_name)}</a></td><td>${esc(STAGE[r.stage]?.label)}</td><td class="num">${gbp(r.arrears)}</td><td class="num">${r.fee != null ? gbp(Number(r.fee) + Number(r.vat)) : ""}</td><td>${fmtDate(iso(r.invoice_date))}</td><td>${r.stage === "invoiced" ? dueBadge(r.invoice_due) : fmtDate(iso(r.invoice_due))}</td><td>${fmtDate(iso(r.paid_at))}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">No decisions yet.</td></tr>`}
  </tbody></table></div>`, { nav: "money" }));
});

/* closed */
app.get("/closed", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE stage IN ('paid','closed_none','closed_lost') ORDER BY updated_at DESC LIMIT 500`);
  res.send(page("Closed", `<h1>Finished and closed</h1><div class="panel tablewrap"><table><thead><tr><th>Client</th><th>Outcome</th><th>Updated</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td><a href="/lead/${r.id}">${esc(r.first_name)} ${esc(r.last_name)}</a></td><td><span class="pill ${r.stage === "paid" ? "good" : ""}">${esc(STAGE[r.stage]?.label)}</span></td><td>${fmtDate(iso(r.updated_at))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Nothing closed yet.</td></tr>`}
  </tbody></table></div>`, { nav: "closed" }));
});

/* manual add (phone enquiries) */
app.get("/new", (req, res) => res.send(page("Add enquiry", `<form class="panel" method="post" action="/new" style="max-width:640px">
<h1>Add an enquiry</h1><p class="muted">For people who phone in rather than using the website.</p>
<div class="grid2"><label>Title <input name="title"></label><label>First name <input name="first_name" required></label>
<label>Last name <input name="last_name" required></label><label>Maiden or previous name <input name="maiden_name"></label>
<label>Phone <input name="phone"></label><label>Email <input name="email" type="email"></label>
<label>Year of birth <input name="born" inputmode="numeric" pattern="\\d{4}"></label>
<label>Child Benefit 1978–2010 <select name="cb">${Object.entries(LABELS.cb).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
<label>State Pension <select name="pension">${Object.entries(LABELS.pension).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
<label>Who for <select name="for_whom">${Object.entries(LABELS.for_whom).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label></div>
<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="consent" value="1" required> Client agreed to be contacted about their claim</label>
<button>Add enquiry</button></form>`, { nav: "new" })));
app.post("/new", async (req, res) => {
  const b = req.body;
  const r = await pool.query(`INSERT INTO leads(source,title,first_name,last_name,maiden_name,phone,email,born,cb,pension,for_whom,consent,consent_text,next_action,next_action_date)
    VALUES('phone',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Consent given by phone',$12,$13) RETURNING id`,
    [clip(b.title, 10), clip(b.first_name, 80), clip(b.last_name, 80), clip(b.maiden_name, 80), clip(b.phone, 30), clip(b.email, 160), parseInt(b.born, 10) || null, clip(b.cb, 20), clip(b.pension, 10), clip(b.for_whom, 10), b.consent === "1", "Call the client", today()]);
  await log(r.rows[0].id, "created", "Enquiry added by phone");
  res.redirect("/lead/" + r.rows[0].id);
});

/* lead record */
async function getLead(id) { const r = await pool.query("SELECT * FROM leads WHERE id=$1", [id]); return r.rows[0]; }
app.get("/lead/:id", async (req, res) => {
  const L = await getLead(req.params.id); if (!L) return res.status(404).send(page("Not found", "<p>No such client.</p>"));
  const acts = (await pool.query("SELECT * FROM activity WHERE lead_id=$1 ORDER BY at DESC", [L.id])).rows;
  const fee = L.fee != null ? Number(L.fee) : null, vat = L.vat != null ? Number(L.vat) : null;
  const coolingEnds = L.signed_at ? addDays(iso(L.signed_at), 14) : null;
  res.send(page(`${L.first_name} ${L.last_name}`, `
  ${req.query.ok ? `<div class="flash">Saved.</div>` : ""}
  <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
    <div><h1>${esc(L.title)} ${esc(L.first_name)} ${esc(L.last_name)}</h1><span class="muted">Ref ${L.id} · received ${fmtDate(iso(L.created_at))} · via ${esc(L.source)}</span></div>
    <span class="pill">${esc(STAGE[L.stage]?.label)}</span>
  </div>
  <div class="grid2">
    <div style="display:grid;gap:18px">
      <form class="panel" method="post" action="/lead/${L.id}/stage">
        <h2>Move to stage</h2>
        <div class="inline" style="display:flex;gap:8px;flex-wrap:wrap"><select name="stage">${STAGES.map(s => `<option value="${s.id}" ${s.id === L.stage ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
        <button>Update stage</button></div>
        <small class="muted">Moving stage sets a suggested next action and date, which you can change below.</small>
      </form>
      <form class="panel" method="post" action="/lead/${L.id}/next">
        <h2>Next action</h2>${dueBadge(L.next_action_date)}
        <label>What <input name="next_action" value="${esc(L.next_action)}" style="width:100%"></label>
        <label>When <input type="date" name="next_action_date" value="${iso(L.next_action_date)}"></label>
        <button>Save next action</button>
      </form>
      <form class="panel" method="post" action="/lead/${L.id}/note">
        <h2>Add a note</h2>
        <select name="kind"><option value="call">Call</option><option value="note">Note</option><option value="email">Email or letter</option><option value="hmrc">HMRC contact</option><option value="dwp">DWP contact</option></select>
        <textarea name="text" required placeholder="What happened, what was agreed"></textarea>
        <button>Add note</button>
      </form>
      <div class="panel"><h2>History</h2><div class="log">${acts.map(a => `<div><small>${new Date(a.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · ${esc(a.kind)}</small><br>${esc(a.text)}</div>`).join("")}</div></div>
    </div>
    <div style="display:grid;gap:18px">
      <div class="panel"><h2>Contact</h2><dl>
        <dt>Phone</dt><dd class="num">${esc(L.phone)}</dd><dt>Email</dt><dd>${esc(L.email)}</dd>
        <dt>Best time</dt><dd>${esc(L.best_time)}</dd><dt>Maiden name</dt><dd>${esc(L.maiden_name)}</dd>
        <dt>Consent</dt><dd>${L.consent ? "Yes" : "No"}${L.consent_text ? `<br><small class="muted">${esc(L.consent_text)}</small>` : ""}</dd></dl></div>
      <div class="panel"><h2>Check answers</h2><dl>
        <dt>Who for</dt><dd>${esc(label("for_whom", L.for_whom))}</dd>
        <dt>Child Benefit 1978–2010</dt><dd>${esc(label("cb", L.cb))}</dd>
        ${L.care ? `<dt>Carer or foster</dt><dd>${esc(label("care", L.care))}</dd>` : ""}
        <dt>Born</dt><dd>${L.born || ""}</dd><dt>Marital status</dt><dd>${esc(label("marital", L.marital))}</dd>
        <dt>State Pension</dt><dd>${esc(label("pension", L.pension))}</dd><dt>Pension Credit</dt><dd>${esc(label("credit", L.credit))}</dd></dl></div>
      <form class="panel" method="post" action="/lead/${L.id}/claim">
        <h2>Claim and fee</h2>
        <div class="grid2">
          <label>Signed on <input type="date" name="signed_at" value="${iso(L.signed_at)}"></label>
          <label>Sent to HMRC <input type="date" name="submitted_at" value="${iso(L.submitted_at)}"></label>
          <label>Decision received <input type="date" name="decision_at" value="${iso(L.decision_at)}"></label>
          <label>Arrears paid by DWP (£) <input name="arrears" inputmode="decimal" value="${L.arrears ?? ""}"></label>
          <label>Invoice date <input type="date" name="invoice_date" value="${iso(L.invoice_date)}"></label>
          <label>Fee paid on <input type="date" name="paid_at" value="${iso(L.paid_at)}"></label>
        </div>
        ${coolingEnds ? `<small class="muted">Cooling-off period ends ${fmtDate(coolingEnds)}.</small>` : ""}
        ${fee != null ? `<dl><dt>Fee (30%)</dt><dd class="num">${gbp(fee)}</dd><dt>VAT (20%)</dt><dd class="num">${gbp(vat)}</dd><dt>Total to invoice</dt><dd class="num">${gbp(fee + vat)}</dd><dt>Client keeps</dt><dd class="num">${gbp(Number(L.arrears) - fee - vat)}</dd>${L.invoice_due ? `<dt>Payment due</dt><dd>${fmtDate(iso(L.invoice_due))}</dd>` : ""}</dl>` : `<small class="muted">Enter the arrears from the DWP award letter to work out the fee.</small>`}
        <button>Save claim details</button>
      </form>
    </div>
  </div>`, { nav: "board" }));
});

app.post("/lead/:id/stage", async (req, res) => {
  const L = await getLead(req.params.id); const s = STAGE[req.body.stage]; if (!L || !s) return res.redirect("/");
  if (s.id === L.stage) return res.redirect("/lead/" + L.id);
  const sets = ["stage=$2", "updated_at=now()"], vals = [L.id, s.id];
  if (s.next) { vals.push(s.next[0], s.id === "invoiced" && L.invoice_due ? iso(L.invoice_due) : addDays(today(), s.next[1])); sets.push(`next_action=$${vals.length - 1}`, `next_action_date=$${vals.length}`); }
  else sets.push("next_action=NULL", "next_action_date=NULL");
  if (s.id === "signed" && !L.signed_at) sets.push("signed_at=current_date");
  if (s.id === "submitted" && !L.submitted_at) sets.push("submitted_at=current_date");
  if (s.id === "decision" && !L.decision_at) sets.push("decision_at=current_date");
  if (s.id === "invoiced" && !L.invoice_date) sets.push("invoice_date=current_date", `invoice_due=current_date + ${PAY_DAYS}`);
  if (s.id === "paid" && !L.paid_at) sets.push("paid_at=current_date");
  await pool.query(`UPDATE leads SET ${sets.join(",")} WHERE id=$1`, vals);
  await log(L.id, "stage", `Moved from ${STAGE[L.stage]?.label} to ${s.label}`);
  res.redirect("/lead/" + L.id + "?ok=1");
});
app.post("/lead/:id/next", async (req, res) => {
  await pool.query("UPDATE leads SET next_action=$2, next_action_date=$3, updated_at=now() WHERE id=$1", [req.params.id, clip(req.body.next_action, 200), req.body.next_action_date || null]);
  await log(req.params.id, "next", `Next action: ${clip(req.body.next_action, 200)}${req.body.next_action_date ? " by " + fmtDate(req.body.next_action_date) : ""}`);
  res.redirect("/lead/" + req.params.id + "?ok=1");
});
app.post("/lead/:id/note", async (req, res) => {
  const text = clip(req.body.text, 4000); if (text) { await log(req.params.id, clip(req.body.kind, 20) || "note", text); await pool.query("UPDATE leads SET updated_at=now() WHERE id=$1", [req.params.id]); }
  res.redirect("/lead/" + req.params.id + "?ok=1");
});
app.post("/lead/:id/claim", async (req, res) => {
  const b = req.body, d = v => v || null;
  const arrears = b.arrears === "" || b.arrears == null ? null : Math.round(parseFloat(String(b.arrears).replace(/[£,\s]/g, "")) * 100) / 100;
  const fee = arrears != null && !isNaN(arrears) ? Math.round(arrears * FEE_RATE * 100) / 100 : null;
  const vat = fee != null ? Math.round(fee * VAT_RATE * 100) / 100 : null;
  const due = b.invoice_date ? addDays(b.invoice_date, PAY_DAYS) : null;
  await pool.query(`UPDATE leads SET signed_at=$2, submitted_at=$3, decision_at=$4, arrears=$5, fee=$6, vat=$7, invoice_date=$8, invoice_due=$9, paid_at=$10, updated_at=now() WHERE id=$1`,
    [req.params.id, d(b.signed_at), d(b.submitted_at), d(b.decision_at), isNaN(arrears) ? null : arrears, fee, vat, d(b.invoice_date), due, d(b.paid_at)]);
  await log(req.params.id, "claim", "Claim details updated" + (arrears ? `: arrears ${gbp(arrears)}, fee ${gbp(fee + vat)} inc. VAT` : ""));
  res.redirect("/lead/" + req.params.id + "?ok=1");
});

/* export */
app.get("/export.csv", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM leads ORDER BY id");
  const cols = ["id", "created_at", "stage", "source", "title", "first_name", "last_name", "maiden_name", "phone", "email", "best_time", "born", "cb", "care", "for_whom", "pension", "marital", "credit", "consent", "next_action", "next_action_date", "signed_at", "submitted_at", "decision_at", "arrears", "fee", "vat", "invoice_date", "invoice_due", "paid_at"];
  const cell = v => { let s = v instanceof Date ? v.toISOString() : String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="crm-export-${today()}.csv"`);
  res.send([cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n"));
});

app.use((err, req, res, next) => { console.error(err); res.status(500).send(page("Error", `<div class="panel"><h1>Something went wrong</h1><p>${esc(err.message)}</p><a href="/">Back to pipeline</a></div>`)); });
}

(async () => {
  if (pool) { try { await initDb(); console.log("Database ready"); } catch (e) { console.error("Database setup failed:", e.message); } }
  app.listen(PORT, () => console.log("CRM listening on " + PORT));
})();
