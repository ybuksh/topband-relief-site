"use strict";
/* Built-in electronic signing.
   Rules (from the HMRC-reviewed process): documents are completed in full before sending; the client
   previews every document before signing; nothing is edited after signing (a correction is a new
   version needing a fresh signature); a paper option is always offered; every step is audited. */
const crypto = require("crypto");
const { buildDocs, DOC_TYPES, DOC_CSS, FIRM_FIELDS, COOLING_DAYS, ukDate } = require("./esign-docs");

const LINK_DAYS = 30, MAX_TRIES = 5;
/* fixed declarations the client confirms when signing (aligned with the HMRC-reviewed wording) */
const DECL_PACK = [
  "the information I have given is true and complete, and I will tell Every Penny Back if anything changes",
  "I am signing for myself and I have the ability to make this decision",
  "I have read the final completed version of each document above before signing",
  "I understand DWP pays any arrears directly to me, and the fee is 36% of the arrears I actually receive (30% plus VAT), invoiced only after DWP confirms them and due 14 days from the invoice",
  "I understand HMRC will only be asked about specific tax years, and HMRC may contact me to check I authorised this",
  "I understand a claim form (CF411) will only be prepared, for me to check and sign later, if my records support a claim",
  "I can cancel within 14 days from today and pay nothing",
  "I agree to be contacted about my claim by phone, text, WhatsApp, email and post"
];
const DECL_CF411 = [
  "I have checked the details on this claim declaration and they are correct and complete",
  "I am signing for myself and I have the ability to make this decision",
  "I understand DWP pays any arrears directly to me"
];
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
/* fingerprint of the whole set, independent of how the database stores the JSON */
const setHash = docs => sha(docs.map(d => [d.key, d.title, d.hash].join("\u0000")).join("\n"));
const intact = r => r.docs.every(d => sha(d.html) === d.hash) && setHash(r.docs) === r.docs_hash;
const STATUS = { sent: "Sent, not opened", opened: "Opened, not signed", signed: "Signed", void: "Void", locked: "Locked (too many wrong answers)", paper: "Client asked for paper" };

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS sign_requests (
    id SERIAL PRIMARY KEY,
    lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, version INT NOT NULL, token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'sent', docs JSONB NOT NULL, docs_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
    opened_at TIMESTAMPTZ, signed_at TIMESTAMPTZ, signer_name TEXT, signature_png TEXT,
    signer_ip TEXT, signer_ua TEXT, seal TEXT, tries INT NOT NULL DEFAULT 0,
    voided_at TIMESTAMPTZ, void_reason TEXT, is_test BOOLEAN NOT NULL DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS sign_events (
    id SERIAL PRIMARY KEY, request_id INT NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT now(), event TEXT NOT NULL, ip TEXT, ua TEXT
  );
  CREATE INDEX IF NOT EXISTS sign_requests_lead_idx ON sign_requests(lead_id);
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS dob DATE;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS address TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS postcode TEXT;
`;

module.exports = function esign(ctx) {
  const { pool, log, page, esc, fmtDate, iso, today, addDays, validNi, requestYears, sendEmail, BRAND, PHONE, SESSION_SECRET, clip, claimSummary } = ctx;
  const ipOf = req => (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const uaOf = req => clip(req.headers["user-agent"], 300);
  const event = (rid, ev, req) => pool.query("INSERT INTO sign_events(request_id,event,ip,ua) VALUES($1,$2,$3,$4)", [rid, ev, req ? ipOf(req) : null, req ? uaOf(req) : null]);
  const london = d => new Date(d).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "medium" }) + " UK time";
  const linkFor = (req, r) => `https://${req.headers.host}/sign/${r.token}`;

  async function settings() {
    const r = await pool.query("SELECT key, value FROM settings");
    const F = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    F.trading_name = BRAND; if (!F.phone) F.phone = PHONE;
    /* known company details, used until someone saves different ones in Settings */
    const DEFAULTS = { company_name: "Tax Magpie Ltd", company_no: "14851288", arn: "WARN0051407",
      address: "56 Thornbury Road, Stretford, Manchester M32 0QE", email: "hello@everypennyback.co.uk", vat_no: "GB 445 9515 68" };
    for (const [k, v] of Object.entries(DEFAULTS)) if (!F[k]) F[k] = v;
    return F;
  }
  async function build(L, kind, body) {
    const F = await settings();
    const include = kind === "pack" && (body.include_ni === "1" || body.include_ni === true) ? ["nirequest"] : [];
    const ftYears = String(L.ft_years || "").split(",").map(Number).filter(Boolean);
    return buildDocs(kind, L, F, { validNi, include, years: requestYears(L) || [], ftYears, spYear: L.sp_start_year, claimDetails: body.claim_details || "" });
  }

  /* signer session: cookie per request, set after the date-of-birth check */
  const sgName = r => "sg" + r.id;
  const mac = v => crypto.createHmac("sha256", SESSION_SECRET).update("sign:" + v).digest("hex");
  function verified(req, r) {
    const c = Object.fromEntries((req.headers.cookie || "").split(";").map(p => p.trim().split("=")).filter(p => p[0]));
    const v = c[sgName(r)]; if (!v) return false; const [exp, m] = v.split(".");
    return Number(exp) > Date.now() && m === mac(r.id + "." + exp);
  }
  function setVerified(res, r) { const exp = Date.now() + 2 * 3600e3; res.set("Set-Cookie", `${sgName(r)}=${exp}.${mac(r.id + "." + exp)}; HttpOnly; Secure; SameSite=Lax; Path=/sign/${r.token}; Max-Age=7200`); }

  /* ---------- client pages ---------- */
  const shell = (title, inner) => page(title, `<style>${DOC_CSS}
    body{font-size:18px}.signwrap{max-width:780px;margin:0 auto;display:grid;gap:18px}
    .big{font-size:1.1rem;padding:14px 20px;min-height:52px}.ack{display:flex;gap:12px;align-items:flex-start;font-weight:600;background:var(--tint);padding:14px 16px;border-radius:10px;cursor:pointer}
    .ack input{width:24px;height:24px;margin-top:2px;flex:none;accent-color:var(--accent)}
    .pad{border:2px dashed var(--line);border-radius:10px;background:#fff;touch-action:none;width:100%;height:180px;display:block}
    .steps-mini{display:flex;gap:6px;flex-wrap:wrap}.steps-mini span{font-size:.85rem;padding:3px 10px;border-radius:999px;background:var(--tint)}
    .err{color:var(--bad);font-weight:600}</style>
    <div class="signwrap"><div class="noprint"><strong style="font-size:1.1rem">${esc(BRAND)}</strong></div>${inner}
    <p class="muted noprint">Questions? Call us free on ${esc(PHONE)}, weekdays 9am to 5pm. You can always ask for paper copies instead.</p></div>`, { bare: true });
  const notFound = () => shell("Signing link", `<div class="panel"><h1>This link isn't working</h1><p>It may have expired or been replaced by a newer version. Please call us and we'll help.</p></div>`);
  async function byToken(t) { if (!/^[A-Za-z0-9_-]{20,80}$/.test(t || "")) return null; return (await pool.query("SELECT * FROM sign_requests WHERE token=$1", [t])).rows[0]; }
  const getLead = async id => (await pool.query("SELECT * FROM leads WHERE id=$1", [id])).rows[0];

  function dobForm(r, err, tries) {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const alt = (tries || r.tries || 0) >= 2;
    return shell("Confirm it's you", `<div class="panel"><h1>Your documents to sign</h1>
      <p>For your security, please confirm your date of birth before we show your documents.</p>
      ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ""}
      <form method="post" action="/sign/${r.token}/verify" style="display:grid;gap:14px" autocomplete="off">
      <fieldset style="border:0;padding:0;margin:0;display:flex;gap:10px;flex-wrap:wrap"><legend style="font-weight:700;margin-bottom:6px">Date of birth</legend>
      <label>Day <select name="d" required><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option>${i + 1}</option>`).join("")}</select></label>
      <label>Month <select name="m" required><option value="">Month</option>${months.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select></label>
      <label>Year <select name="y" required><option value="">Year</option>${Array.from({ length: 50 }, (_, i) => `<option>${1975 - i}</option>`).join("")}</select></label></fieldset>
      <button class="big">Continue</button></form></div>
      ${alt ? `<form class="panel" method="post" action="/sign/${r.token}/verify" style="display:grid;gap:12px" autocomplete="off"><h2>Or use your postcode and phone number instead</h2>
        <label>Your postcode <input name="pc" autocapitalize="characters" required></label>
        <label>Last 4 digits of the phone number we have for you <input name="l4" inputmode="numeric" maxlength="4" required></label>
        <input type="hidden" name="alt" value="1"><button class="big">Continue</button></form>` : ""}
      <form class="panel" method="post" action="/sign/${r.token}/callme" style="display:grid;gap:10px"><p style="margin:0">Having trouble? We'll call you and help, or post paper copies.</p><button class="btn ghost">Please call me</button></form>`);
  }
  const KEY_POINTS = {
    agreement: ["You can claim yourself for free through GOV.UK.", "Our fee is 36% of any arrears DWP pays you, invoiced only after DWP confirms them. Nothing to pay if nothing is paid.", "You can cancel within 14 days and pay nothing."],
    hmrc: ["Lets HMRC talk to us about your National Insurance record.", "It doesn't let anyone receive money for you."],
    dwp: ["Lets DWP tell us about your State Pension.", "DWP still pays any money straight to you."],
    nirequest: ["Asks HMRC for your record for the listed tax years only.", "HMRC may contact you to check you agreed."],
    cf411: ["This is your claim to HMRC.", "Only sign if every detail is right."]
  };
  function docBlock(d, i, total) {
    const kp = KEY_POINTS[d.key];
    return `<section style="display:grid;gap:10px"><div class="steps-mini noprint"><span>Document ${i + 1} of ${total}</span> <button type="button" class="btn ghost readaloud" data-doc="doc${i}" style="padding:4px 12px">Read it to me</button></div>
      ${kp ? `<div class="panel noprint" style="background:var(--tint)"><b>In short:</b><ul style="margin:6px 0 0;padding-left:22px">${kp.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      <article class="doc" id="doc${i}" aria-label="${esc(d.title)}">${d.html}</article>
      <label class="ack noprint"><input type="checkbox" name="ack_${esc(d.key)}" value="1" required> I have read and understood "${esc(d.title)}"</label></section>`;
  }

  return {
    INIT_SQL,
    /* routes that don't need staff login */
    publicRoutes(app) {
      const fail = new Map();
      app.get("/sign/:token", async (req, res) => {
        const r = await byToken(req.params.token); if (!r) return res.status(404).send(notFound());
        if (r.status === "void") return res.send(shell("Replaced", `<div class="panel"><h1>This version has been replaced</h1><p>${esc(r.void_reason || "We've sent you a newer version.")} Please use the latest link we sent you, or call us.</p></div>`));
        if (r.status === "locked") return res.send(shell("Locked", `<div class="panel"><h1>This link has been locked</h1><p>The date of birth was entered incorrectly too many times. Please call us and we'll send a new link.</p></div>`));
        if (r.status !== "signed" && new Date(r.expires_at) < new Date()) return res.send(shell("Expired", `<div class="panel"><h1>This link has expired</h1><p>Please call us and we'll send you a new one.</p></div>`));
        if (!verified(req, r)) return res.send(dobForm(r));
        if (r.status === "signed") return res.redirect(`/sign/${r.token}/copy`);
        const L0 = await getLead(r.lead_id);
        if (r.kind === "pack" && !req.query.confirmed) {
          const kids = Array.isArray(L0.children) ? L0.children.filter(c => c && (c.name || c.dob)) : [];
          const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v ? esc(v) : `<span class="muted">Not given</span>`}</td></tr>`;
          return res.send(shell("Check your details", `<div class="panel"><h1>First, are these details right?</h1>
            <p>These details go on your forms to HMRC and DWP. A wrong detail can get a form rejected, so please check them carefully.</p>
            <table class="doc-fields"><tbody>${row("Name", [L0.title, L0.first_name, L0.last_name].filter(Boolean).join(" "))}${L0.hmrc_name ? row("Name on your pension letter", L0.hmrc_name) : ""}${row("Previous surnames", L0.prev_names || L0.maiden_name)}${row("Date of birth", L0.dob ? ukDate(L0.dob) : "")}${row("Address", [L0.address, L0.postcode].filter(Boolean).join(", "))}${row("National Insurance number", L0.ni_number ? L0.ni_number.replace(/^(..)(..)(..)(..)(.)$/, "$1 $2 $3 $4 $5") : "")}${kids.length ? row("Children", kids.map(c => `${c.name || "?"}${c.dob ? " (" + ukDate(c.dob) + ")" : ""}`).join("; ")) : ""}</tbody></table>
            <a class="btn big" href="/sign/${r.token}?confirmed=1" style="text-align:center">Yes, these are right. Show my documents</a></div>
            <form class="panel" method="post" action="/sign/${r.token}/wrong" style="display:grid;gap:10px"><h2>Something's wrong?</h2><label>What needs changing? <textarea name="what" rows="3" required></textarea></label><button class="btn ghost">Tell us and don't sign yet</button></form>`));
        }
        if (r.kind === "pack" && req.query.confirmed && !r.opened_at) await event(r.id, "Confirmed their details are correct", req);
        if (!r.opened_at) { await pool.query("UPDATE sign_requests SET opened_at=now(), status=CASE WHEN status='sent' THEN 'opened' ELSE status END WHERE id=$1", [r.id]); await event(r.id, "Opened the documents", req); }
        const L = await getLead(r.lead_id);
        const docs = r.docs;
        res.send(shell("Sign your documents", `<div class="panel"><h1>${r.kind === "cf411" ? "Your claim form to check and sign" : "Your documents to read and sign"}</h1>
          <p>Hello ${esc(L.title)} ${esc(L.last_name)}. Please read ${docs.length > 1 ? `each of these ${docs.length} documents` : "this document"} and tick the box under ${docs.length > 1 ? "each one" : "it"}. Then sign at the bottom. Everything has been filled in for you. Nothing can be changed after you sign.</p>
          ${r.kind === "pack" ? `<p><strong>You can cancel within ${COOLING_DAYS} days of signing and pay nothing</strong>, even if we've started work.</p>` : ""}
          <form method="post" action="/sign/${r.token}/paper" style="margin:0"><button class="btn ghost">I'd rather sign on paper. Post them to me.</button></form></div>
          <form method="post" action="/sign/${r.token}" id="signform" style="display:grid;gap:22px" novalidate>
          ${docs.map((d, i) => docBlock(d, i, docs.length)).join("")}
          <div class="panel" id="signbox"><h2>Sign</h2>
            <label>Type your full name <input name="signer_name" autocomplete="name" required style="font-size:1.1rem" placeholder="${esc(L.first_name)} ${esc(L.last_name)}"></label>
            <div style="display:grid;gap:6px"><b>Draw your signature <span class="muted" style="font-weight:400">(optional)</span></b>
              <canvas class="pad" id="pad" aria-label="Signature box. Draw with your finger or mouse."></canvas>
              <button type="button" class="btn ghost" id="clear" style="justify-self:start">Clear signature</button></div>
            <input type="hidden" name="signature_png" id="png">
            <div class="ack" style="display:block;cursor:default"><b>By signing I confirm that:</b><ul style="margin:8px 0 0;padding-left:22px;font-weight:400">${(r.kind === "cf411" ? DECL_CF411 : DECL_PACK).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
            <label class="ack"><input type="checkbox" name="consent" value="1" required> I confirm all of the above and agree to sign electronically. I understand an electronic signature has the same legal effect as a handwritten one, and that I can ask for paper copies instead.</label>
            <p class="err" id="err" role="alert"></p>
            <button class="big" type="submit">Sign ${docs.length > 1 ? "all documents" : "this document"}</button>
          </div></form>
          <script>(function(){
            var c=document.getElementById("pad"),x=c.getContext("2d"),drawing=false,used=false;
            function size(){var r=c.getBoundingClientRect(),d=window.devicePixelRatio||1;c.width=r.width*d;c.height=r.height*d;x.scale(d,d);x.lineWidth=2.4;x.lineCap="round";x.lineJoin="round";x.strokeStyle="#1b1420";}
            size();
            function p(e){var r=c.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
            c.addEventListener("pointerdown",function(e){drawing=true;used=true;c.setPointerCapture(e.pointerId);var q=p(e);x.beginPath();x.moveTo(q.x,q.y);});
            c.addEventListener("pointermove",function(e){if(!drawing)return;var q=p(e);x.lineTo(q.x,q.y);x.stroke();});
            ["pointerup","pointercancel"].forEach(function(t){c.addEventListener(t,function(){drawing=false;});});
            document.getElementById("clear").onclick=function(){x.clearRect(0,0,c.width,c.height);used=false;};
            document.getElementById("signform").addEventListener("submit",function(e){
              var miss=[].slice.call(this.querySelectorAll('input[type=checkbox]')).filter(function(i){return !i.checked;});
              if(miss.length){e.preventDefault();document.getElementById("err").textContent="Please tick every box to confirm you've read each document and agree to sign electronically.";miss[0].focus();return;}
              document.getElementById("png").value=used?c.toDataURL("image/png"):"";
              this.querySelector('button[type=submit]').disabled=true;
            });
          })();</script>
          <script>(function(){if(!("speechSynthesis" in window)){document.querySelectorAll(".readaloud").forEach(function(b){b.hidden=true;});return;}
            document.querySelectorAll(".readaloud").forEach(function(b){b.addEventListener("click",function(){var s=window.speechSynthesis;if(s.speaking){s.cancel();b.textContent="Read it to me";return;}var u=new SpeechSynthesisUtterance(document.getElementById(b.dataset.doc).innerText);u.lang="en-GB";u.rate=0.9;u.onend=function(){b.textContent="Read it to me";};s.speak(u);b.textContent="Stop reading";});});})();</script>`));
      });

      app.post("/sign/:token/callme", async (req, res) => {
        const r = await byToken(req.params.token); if (!r) return res.status(404).send(notFound());
        await event(r.id, "Asked us to call to help", req);
        await pool.query("UPDATE leads SET next_action='Client asked for help with their signing link: call them today', next_action_date=current_date, updated_at=now() WHERE id=$1", [r.lead_id]);
        await log(r.lead_id, "esign", "Client pressed 'Please call me' on the signing page");
        res.send(shell("We'll call you", `<div class="panel"><h1>Thank you, we'll call you</h1><p>One of our team will call you shortly, weekdays 9am to 5pm, to help. You can also call us free on ${esc(PHONE)}.</p></div>`));
      });
      app.post("/sign/:token/wrong", async (req, res) => {
        const r = await byToken(req.params.token); if (!r) return res.status(404).send(notFound());
        if (!verified(req, r)) return res.redirect(`/sign/${r.token}`);
        const what = clip(req.body.what, 1000) || "(not said)";
        await event(r.id, "Client said some details are wrong: " + what, req);
        await pool.query("UPDATE leads SET stage=CASE WHEN stage='pack_sent' THEN 'resign' ELSE stage END, next_action=$2, next_action_date=current_date, updated_at=now() WHERE id=$1", [r.lead_id, "Client says details are wrong before signing: correct them and send a new version"]);
        await log(r.lead_id, "esign", "Client reported wrong details before signing: " + what);
        res.send(shell("Thank you", `<div class="panel"><h1>Thank you for telling us</h1><p>Please don't sign this version. We'll correct the details and send you a new copy, usually the same working day. If you'd like to talk it through, call us free on ${esc(PHONE)}.</p></div>`));
      });
      app.post("/sign/:token/verify", async (req, res) => {
        const r = await byToken(req.params.token); if (!r) return res.status(404).send(notFound());
        if (["void", "locked"].includes(r.status)) return res.redirect(`/sign/${r.token}`);
        const ip = ipOf(req), t = (fail.get(ip) || []).filter(x => Date.now() - x < 15 * 60e3);
        if (t.length >= 10) return res.status(429).send(dobForm(r, "Too many attempts. Please wait 15 minutes or call us."));
        const L = await getLead(r.lead_id);
        const d = parseInt(req.body.d, 10), m = parseInt(req.body.m, 10), y = parseInt(req.body.y, 10);
        const given = y && m && d ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : "";
        if (L && L.dob && given === iso(L.dob)) {
          await event(r.id, "Confirmed date of birth", req);
          setVerified(res, r); return res.redirect(`/sign/${r.token}`);
        }
        /* fallback after two wrong dates: postcode plus last 4 digits of the phone we hold */
        if (req.body.alt === "1" && r.tries >= 2 && L) {
          const pc = String(req.body.pc || "").replace(/\s/g, "").toUpperCase(), l4 = String(req.body.l4 || "").replace(/\D/g, "");
          const phones = [L.phone, L.mobile, L.helper_phone].filter(Boolean).map(p => String(p).replace(/\D/g, ""));
          if (pc && L.postcode && pc === String(L.postcode).replace(/\s/g, "").toUpperCase() && l4.length === 4 && phones.some(p => p.endsWith(l4))) {
            await event(r.id, "Confirmed identity with postcode and phone number (date of birth didn't match)", req);
            await log(r.lead_id, "check", "Client couldn't confirm the date of birth we hold but matched postcode and phone. Check the date of birth on file.");
            setVerified(res, r); return res.redirect(`/sign/${r.token}`);
          }
        }
        t.push(Date.now()); fail.set(ip, t);
        const tries = r.tries + 1;
        await pool.query("UPDATE sign_requests SET tries=$2, status=CASE WHEN $2 >= $3 AND status <> 'signed' THEN 'locked' ELSE status END WHERE id=$1", [r.id, tries, MAX_TRIES]);
        await event(r.id, `Wrong date of birth entered (attempt ${tries})`, req);
        if (tries >= MAX_TRIES && r.status !== "signed") { await log(r.lead_id, "esign", "Signing link locked after too many wrong dates of birth. Send a new version."); return res.redirect(`/sign/${r.token}`); }
        if (tries === 2) await pool.query("UPDATE leads SET next_action='Client is struggling to open their signing link: call to help', next_action_date=current_date WHERE id=$1", [r.lead_id]);
        res.send(dobForm(r, `Those details don't match our records. You have ${MAX_TRIES - tries} ${MAX_TRIES - tries === 1 ? "try" : "tries"} left.`, tries));
      });

      app.post("/sign/:token", async (req, res) => {
        const r = await byToken(req.params.token); if (!r) return res.status(404).send(notFound());
        if (!verified(req, r) || !["sent", "opened"].includes(r.status) || new Date(r.expires_at) < new Date()) return res.redirect(`/sign/${r.token}`);
        const L = await getLead(r.lead_id);
        const name = clip(req.body.signer_name, 120).replace(/\s+/g, " ");
        const back = msg => res.send(shell("Please check", `<div class="panel"><h1>Please check</h1><p class="err">${esc(msg)}</p><a class="btn" href="/sign/${r.token}">Go back to your documents</a></div>`));
        if (r.docs.some(d => req.body["ack_" + d.key] !== "1") || req.body.consent !== "1") return back("Please tick every box to confirm you've read each document and agree to sign electronically.");
        if (name.length < 4 || !name.toLowerCase().includes(String(L.last_name || "").toLowerCase().trim())) return back(`Please type your full name, including your surname (${L.last_name}).`);
        let png = String(req.body.signature_png || "");
        if (png && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png) || png.length > 300000)) png = "";
        /* re-check the stored documents haven't changed since they were sent */
        if (!intact(r)) { await log(r.lead_id, "esign", "Signing stopped: document check failed. Issue a new version."); return back("Something has changed in these documents. Please call us and we'll send you a fresh copy."); }
        const at = new Date().toISOString(), ip = ipOf(req), ua = uaOf(req);
        const seal = sha([r.docs_hash, name, at, ip, sha(png)].join("|"));
        const up = await pool.query(`UPDATE sign_requests SET status='signed', signed_at=$2, signer_name=$3, signature_png=$4, signer_ip=$5, signer_ua=$6, seal=$7 WHERE id=$1 AND status IN ('sent','opened') RETURNING id`, [r.id, at, name, png || null, ip, ua, seal]);
        if (!up.rows.length) return res.redirect(`/sign/${r.token}`);
        await event(r.id, `Read and acknowledged: ${r.docs.map(d => d.title).join("; ")}`, req);
        await event(r.id, `Confirmed the declarations: ${(r.kind === "cf411" ? DECL_CF411 : DECL_PACK).join(" | ")}`, req);
        await event(r.id, `Signed as "${name}"${png ? " with a drawn signature" : ""}, agreeing to sign electronically`, req);
        if (r.kind === "pack") {
          const idPassed = L.kyc === "passed";
          await pool.query(`UPDATE leads SET signed_at=current_date, stage=CASE WHEN stage IN ('new','contacted','qualified','pack_sent','resign') THEN 'signed' ELSE stage END,
            next_action=$2, next_action_date=current_date, updated_at=now() WHERE id=$1`, [L.id, idPassed ? "Pack signed: invite client to share NI record and send DWP request" : "Pack signed: run the electronic ID check"]);
          await log(L.id, "esign", `Client signed the sign-up pack (version ${r.version}) online. Cooling-off ends ${ukDate(addDays(today(), COOLING_DAYS))}.`);
        } else {
          await pool.query("UPDATE leads SET next_action=$2, next_action_date=current_date, updated_at=now() WHERE id=$1", [L.id, "CF411 signed: send it to HMRC"]);
          await log(L.id, "esign", `Client signed the CF411 declaration (version ${r.version}) online.`);
        }
        sendEmail(L.email, `${BRAND}: your signed documents`, `Dear ${L.title || ""} ${L.last_name},\n\nThank you for signing. You can view and print your signed ${r.kind === "cf411" ? "claim declaration" : "documents"} at any time here:\n${linkFor(req, r)}\n\n${r.kind === "pack" ? `You can cancel within ${COOLING_DAYS} days of signing and pay nothing, even if we've started work.\n\n` : ""}Questions? Call us free on ${PHONE}, weekdays 9am to 5pm.\n\n${BRAND}`)
          .then(ok => ok && event(r.id, "Signed copy emailed to client"));
        res.redirect(`/sign/${r.token}/copy?done=1`);
      });

      app.post("/sign/:token/paper", async (req, res) => {
        const r = await byToken(req.params.token); if (!r) return res.status(404).send(notFound());
        if (!verified(req, r)) return res.redirect(`/sign/${r.token}`);
        if (["sent", "opened"].includes(r.status)) {
          await event(r.id, "Asked for paper copies instead", req);
          await pool.query("UPDATE leads SET paper_requested=true, next_action=$2, next_action_date=current_date, updated_at=now() WHERE id=$1", [r.lead_id, "Client asked for paper: post the documents with a reply envelope (see Post)"]);
          await log(r.lead_id, "esign", "Client asked to sign on paper instead. Post the same version of the documents.");
        }
        res.send(shell("Paper copies", `<div class="panel"><h1>We'll post them to you</h1><p>Thank you. We'll post paper copies of the same documents with a prepaid envelope, usually within 2 working days. You don't need to do anything else now.</p></div>`));
      });

      app.get("/sign/:token/copy", async (req, res) => {
        const r = await byToken(req.params.token); if (!r) return res.status(404).send(notFound());
        if (!verified(req, r)) return res.send(dobForm(r));
        if (r.status !== "signed") return res.redirect(`/sign/${r.token}`);
        const evs = (await pool.query("SELECT * FROM sign_events WHERE request_id=$1 ORDER BY at, id", [r.id])).rows;
        res.send(shell("Your signed documents", `${req.query.done ? `<div class="panel noprint" style="border-color:var(--good)"><h1>Thank you, you've signed</h1><p>We'll be in touch with the next steps.${r.kind === "pack" ? ` You can cancel within ${COOLING_DAYS} days and pay nothing.` : ""} You can print or save this page for your records.</p></div>` : ""}
          <button class="btn ghost noprint" onclick="window.print()" style="justify-self:start">Print or save as PDF</button>
          ${signedView(r, evs)}`));
      });
    },

    /* staff routes (after login) */
    staffRoutes(app) {
      app.get("/lead/:id/esign/new", async (req, res) => {
        const L = await getLead(req.params.id); if (!L) return res.redirect("/");
        const kind = req.query.kind === "cf411" ? "cf411" : "pack";
        const body = { include_ni: req.query.include_ni === "1", claim_details: req.query.claim_details || (kind === "cf411" && claimSummary ? claimSummary(L) : "") };
        const { docs, missing } = await build(L, kind, body);
        const blocked = missing.length && !L.is_test;
        const years = requestYears(L);
        res.send(page("Prepare documents", `<style>${DOC_CSS}</style>
          <div><a href="/lead/${L.id}">← Back to ${esc(L.first_name)} ${esc(L.last_name)}</a><h1 style="margin-top:6px">${kind === "cf411" ? "CF411 declaration" : "Sign-up pack"}: preview</h1></div>
          <form class="panel" method="get" action="/lead/${L.id}/esign/new"><input type="hidden" name="kind" value="${kind}">
            ${kind === "pack" ? `<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="include_ni" value="1" ${body.include_ni ? "checked" : ""}> Include the NI record request (only if needed${years && years.length ? `: ${years.length} tax years` : ", and the tax years must be known"})</label>`
              : `<label>Claim details for the CF411 (tax years claimed, each child's name and date of birth, Child Benefit details)<textarea name="claim_details" rows="6">${esc(body.claim_details)}</textarea></label>`}
            <button class="btn ghost">Update preview</button></form>
          ${missing.length ? `<div class="panel" style="border-color:var(--bad)"><h2>${L.is_test ? "Missing details (allowed because this is test data)" : "Fill these in before sending"}</h2><ul>${missing.map(m => `<li>${esc(m)}</li>`).join("")}</ul>
            <p class="muted">Client details are on the client record under Case details. Firm details are in Settings. Documents must be complete before the client signs.</p></div>` : ""}
          <form class="panel" method="post" action="/lead/${L.id}/esign">
            <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="include_ni" value="${body.include_ni ? "1" : ""}">
            <input type="hidden" name="claim_details" value="${esc(body.claim_details)}">
            <p>The client will confirm their date of birth, read each document, tick to confirm, and sign. ${L.email ? `We'll email the link to ${esc(L.email)}` : "There's no email on file, so copy the link to send by text"}. Any open version of this ${kind === "cf411" ? "declaration" : "pack"} will be replaced.</p>
            <button ${blocked ? "disabled" : ""}>${blocked ? "Complete the missing details first" : "Send for signature"}</button></form>
          ${docs.map(d => `<article class="doc">${d.html}</article>`).join("")}`, { nav: "board" }));
      });

      app.post("/lead/:id/esign", async (req, res) => {
        const L = await getLead(req.params.id); if (!L) return res.redirect("/");
        const kind = req.body.kind === "cf411" ? "cf411" : "pack";
        if (L.attorney && !L.is_test) return res.redirect(`/lead/${L.id}?err=${encodeURIComponent("Someone else acts for this client. The policy on attorneys isn't decided yet, so documents can't be sent.")}`);
        if (L.stage === "fraud_freeze") return res.redirect(`/lead/${L.id}?err=${encodeURIComponent("This case is frozen for suspected fraud. Documents can't be sent.")}`);
        const { docs, missing } = await build(L, kind, req.body);
        if (missing.length && !L.is_test) return res.redirect(`/lead/${L.id}?err=${encodeURIComponent("Documents aren't complete: " + missing.join(", "))}`);
        const prev = (await pool.query("SELECT coalesce(max(version),0) AS v FROM sign_requests WHERE lead_id=$1 AND kind=$2", [L.id, kind])).rows[0].v;
        const version = prev + 1;
        const open = (await pool.query("UPDATE sign_requests SET status='void', voided_at=now(), void_reason=$3 WHERE lead_id=$1 AND kind=$2 AND status IN ('sent','opened','locked') RETURNING id, version", [L.id, kind, `Replaced by version ${version}.`])).rows;
        for (const o of open) await event(o.id, `Replaced by version ${version}`, req);
        const stored = docs.map(d => ({ ...d, hash: sha(d.html) }));
        const token = crypto.randomBytes(24).toString("base64url");
        const r = (await pool.query(`INSERT INTO sign_requests(lead_id,kind,version,token,docs,docs_hash,expires_at,is_test) VALUES($1,$2,$3,$4,$5,$6,now() + interval '${LINK_DAYS} days',$7) RETURNING *`,
          [L.id, kind, version, token, JSON.stringify(stored), setHash(stored), !!L.is_test])).rows[0];
        await event(r.id, `Version ${version} created and sent: ${stored.map(d => d.title).join("; ")}`, req);
        const hadSigned = (await pool.query("SELECT 1 FROM sign_requests WHERE lead_id=$1 AND kind='pack' AND void_reason LIKE 'Correction%' LIMIT 1", [L.id])).rows.length;
        if (kind === "pack") await pool.query(`UPDATE leads SET stage=CASE WHEN stage IN ('new','contacted','qualified') THEN 'pack_sent' ELSE stage END, next_action='Chase signature', next_action_date=$2, updated_at=now() WHERE id=$1`, [L.id, addDays(today(), 3)]);
        else await pool.query(`UPDATE leads SET stage=CASE WHEN stage IN ('preparing','on_hold') THEN 'cf411_sent' ELSE stage END, next_action='Chase the CF411 signature', next_action_date=$2, updated_at=now() WHERE id=$1`, [L.id, addDays(today(), 5)]);
        await log(L.id, "esign", `${kind === "cf411" ? "CF411 declaration" : "Sign-up pack"} version ${version} sent for signature${open.length ? ` (version ${open.map(o => o.version).join(", ")} replaced)` : ""}${hadSigned && kind === "pack" ? ". This is a corrected version needing a fresh signature" : ""}.`);
        const link = linkFor(req, r);
        sendEmail(L.email, `${BRAND}: your ${kind === "cf411" ? "claim form" : "documents"} to sign`, `Dear ${L.title || ""} ${L.last_name},\n\nYour ${kind === "cf411" ? "claim declaration is" : "documents are"} ready to read and sign:\n${link}\n\nYou'll be asked for your date of birth to open them. Everything is filled in for you; please read each document before signing. If you'd prefer paper copies, there's a button on the page, or call us.\n\n${kind === "pack" ? `You can cancel within ${COOLING_DAYS} days of signing and pay nothing, even if we've started work.\n\n` : ""}Questions? Call us free on ${PHONE}, weekdays 9am to 5pm.\n\n${BRAND}`)
          .then(ok => ok && event(r.id, `Link emailed to ${L.email}`));
        res.redirect(`/lead/${L.id}/esign/${r.id}?sent=1`);
      });

      app.get("/lead/:id/esign/:rid", async (req, res) => {
        const L = await getLead(req.params.id);
        const r = (await pool.query("SELECT * FROM sign_requests WHERE id=$1 AND lead_id=$2", [req.params.rid, req.params.id])).rows[0];
        if (!L || !r) return res.redirect("/");
        const evs = (await pool.query("SELECT * FROM sign_events WHERE request_id=$1 ORDER BY at, id", [r.id])).rows;
        const link = linkFor(req, r);
        const sms = `Hello ${L.title || ""} ${L.last_name}, your ${BRAND} ${r.kind === "cf411" ? "claim form is" : "documents are"} ready to read and sign: ${link} You'll need your date of birth. Any questions, call ${PHONE}.`;
        res.send(page("Signing", `<style>${DOC_CSS}</style>
          <div class="noprint"><a href="/lead/${L.id}">← Back to ${esc(L.first_name)} ${esc(L.last_name)}</a>
          <h1 style="margin-top:6px">${r.kind === "cf411" ? "CF411 declaration" : "Sign-up pack"}, version ${r.version}</h1>
          <span class="pill ${r.status === "signed" ? "good" : ["void", "locked"].includes(r.status) ? "bad" : ""}">${esc(STATUS[r.status] || r.status)}</span>${r.is_test ? ` <span class="pill bad">Test</span>` : ""}</div>
          ${req.query.sent ? `<div class="flash noprint">Sent for signature${L.email ? " (and emailed, if email sending is set up)" : ""}. You can also send the link below by text or WhatsApp.</div>` : ""}
          ${["sent", "opened"].includes(r.status) ? `<div class="panel noprint"><h2>Signing link</h2>
            <input readonly value="${esc(link)}" style="width:100%" onclick="this.select()">
            <label>Text message to send <textarea readonly rows="3" onclick="this.select()">${esc(sms)}</textarea></label>
            <p class="muted">The link expires ${fmtDate(iso(r.expires_at))}. The client needs their date of birth (${L.dob ? "on file" : "<b>not on file: add it or they can't open it</b>"}).</p></div>` : ""}
          ${r.status !== "void" ? `<form class="panel noprint" method="post" action="/lead/${L.id}/esign/${r.id}/void">
            <h2>${r.status === "signed" ? "Correct a signed document" : "Cancel this version"}</h2>
            <p class="muted">${r.status === "signed" ? "Signed documents can't be edited. To correct one, void this version and send a new version for a fresh signature. The signed copy stays on record." : "The link stops working straight away."}</p>
            <label>Reason <input name="reason" required style="width:100%" placeholder="${r.status === "signed" ? "e.g. maiden name misspelt" : "e.g. sent by mistake"}"></label>
            <button class="btn ghost" style="border-color:var(--bad);color:var(--bad)">${r.status === "signed" ? "Void for correction" : "Cancel this version"}</button></form>` : `<div class="panel noprint"><p><b>Void:</b> ${esc(r.void_reason)} ${r.voided_at ? `(${london(r.voided_at)})` : ""}</p></div>`}
          <button class="btn ghost noprint" onclick="window.print()" style="justify-self:start">Print or save as PDF</button>
          ${signedView(r, evs, true)}`, { nav: "board" }));
      });

      app.post("/lead/:id/esign/:rid/void", async (req, res) => {
        const r = (await pool.query("SELECT * FROM sign_requests WHERE id=$1 AND lead_id=$2", [req.params.rid, req.params.id])).rows[0];
        if (!r || r.status === "void") return res.redirect(`/lead/${req.params.id}`);
        const reason = clip(req.body.reason, 300) || "No reason given";
        const wasSigned = r.status === "signed";
        await pool.query("UPDATE sign_requests SET status='void', voided_at=now(), void_reason=$2 WHERE id=$1", [r.id, (wasSigned ? "Correction needed: " : "Cancelled: ") + reason]);
        await event(r.id, `${wasSigned ? "Voided for correction" : "Cancelled"} by staff: ${reason}`, req);
        if (wasSigned && r.kind === "pack") {
          await pool.query("UPDATE leads SET stage='resign', next_action='Send a corrected new version for a fresh signature', next_action_date=current_date, updated_at=now() WHERE id=$1", [r.lead_id]);
          await log(r.lead_id, "esign", `Signed pack version ${r.version} voided for correction: ${reason}. A new version needs a fresh signature.`);
        } else await log(r.lead_id, "esign", `${r.kind === "cf411" ? "CF411 declaration" : "Sign-up pack"} version ${r.version} ${wasSigned ? "voided for correction" : "cancelled"}: ${reason}`);
        res.redirect(`/lead/${r.lead_id}/esign/${r.id}`);
      });

      app.post("/admin/firm", async (req, res) => {
        for (const [k] of FIRM_FIELDS) await pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [k, clip(req.body[k], 300) || null]);
        res.redirect("/admin?done=" + encodeURIComponent("Firm details saved. They're used in new documents only; documents already sent don't change."));
      });
    },

    /* for print-and-post: latest signed (or open, for paper) request of a kind */
    async latest(leadId, kind, statuses) {
      return (await pool.query("SELECT * FROM sign_requests WHERE lead_id=$1 AND kind=$2 AND status = ANY($3) ORDER BY id DESC LIMIT 1", [leadId, kind, statuses])).rows[0];
    },
    docsForPrint(r, keys, paper) {
      return r.docs.filter(d => !keys || keys.includes(d.key)).map(d => `<article class="doc">${d.html}
        ${paper ? `<div style="margin-top:1.4em;font-family:system-ui,sans-serif"><p>Signed: ______________________________ Date: ______________</p><p>Print name: ______________________________</p></div>`
        : r.signed_at ? `<div style="border-top:2px solid #ddd5e1;margin-top:1.2em;padding-top:.8em;font-family:system-ui,sans-serif"><p style="margin:0 0 6px"><b>Signed electronically by ${esc(r.signer_name)}</b> on ${esc(london(r.signed_at))}. Record ${r.id}, version ${r.version}.</p>
        ${r.signature_png ? `<img src="${r.signature_png}" alt="Signature" style="max-width:320px;max-height:110px;border-bottom:1px solid #999">` : `<p style="font:italic 1.6rem Georgia,serif;margin:4px 0">${esc(r.signer_name)}</p>`}<p class="doc-small">Fingerprint SHA-256 ${esc(d.hash)}</p></div>` : ""}</article>`).join("");
    },
    settings,
    DOC_CSS,
    /* panel for the client record */
    async leadPanel(L) {
      const rs = (await pool.query("SELECT id, kind, version, status, created_at, signed_at, opened_at FROM sign_requests WHERE lead_id=$1 ORDER BY created_at DESC", [L.id])).rows;
      return `<div class="panel"><h2>E-signature</h2>
        ${rs.length ? `<div class="tablewrap"><table><thead><tr><th>Document</th><th>Status</th><th>Date</th></tr></thead><tbody>${rs.map(r => `<tr><td><a href="/lead/${L.id}/esign/${r.id}">${r.kind === "cf411" ? "CF411 declaration" : "Sign-up pack"} v${r.version}</a></td><td><span class="pill ${r.status === "signed" ? "good" : ["void", "locked"].includes(r.status) ? "bad" : ""}">${esc(STATUS[r.status] || r.status)}</span></td><td>${fmtDate(iso(r.signed_at || r.opened_at || r.created_at))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Nothing sent for signature yet.</p>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="/lead/${L.id}/esign/new?kind=pack">Prepare sign-up pack</a><a class="btn ghost" href="/lead/${L.id}/esign/new?kind=cf411">Prepare CF411 declaration</a></div></div>`;
    },
    async firmForm() {
      const F = await settings();
      return `<form class="panel" method="post" action="/admin/firm"><h2>Firm details for documents</h2>
        <p class="muted">These go into every agreement and authority. Documents can't be sent to real clients until they're all filled in.</p>
        <div class="grid2">${FIRM_FIELDS.map(([k, l]) => `<label>${esc(l)} <input name="${k}" value="${esc(F[k] || "")}"></label>`).join("")}</div>
        <button>Save firm details</button></form>`;
    }
  };

  /* signed copy plus audit certificate */
  function signedView(r, evs, staff) {
    const signed = r.status === "signed" || (r.status === "void" && r.signed_at);
    return `${r.docs.map(d => `<article class="doc">${d.html}
      ${signed ? `<div style="border-top:2px solid #ddd5e1;margin-top:1.2em;padding-top:.8em;font-family:system-ui,sans-serif">
        <p style="margin:0 0 6px"><b>Signed electronically by ${esc(r.signer_name)}</b> on ${esc(london(r.signed_at))}</p>
        ${r.signature_png ? `<img src="${r.signature_png}" alt="Signature of ${esc(r.signer_name)}" style="max-width:320px;max-height:110px;border-bottom:1px solid #999">` : `<p style="font:italic 1.6rem Georgia,serif;margin:4px 0">${esc(r.signer_name)}</p>`}
      </div>` : ""}</article>`).join("")}
      <article class="doc" style="font-family:system-ui,sans-serif;font-size:15px"><h2>Signing certificate</h2>
        <table class="doc-fields"><tbody>
        <tr><th>Document set</th><td>${r.kind === "cf411" ? "CF411 declaration" : "Sign-up pack"}, version ${r.version} (record ${r.id})</td></tr>
        <tr><th>Status</th><td>${esc(STATUS[r.status] || r.status)}${r.void_reason ? `: ${esc(r.void_reason)}` : ""}</td></tr>
        ${signed ? `<tr><th>Signed by</th><td>${esc(r.signer_name)}, identity checked by date of birth</td></tr><tr><th>Signed at</th><td>${esc(london(r.signed_at))}</td></tr>
        <tr><th>IP address</th><td>${esc(r.signer_ip)}</td></tr><tr><th>Device</th><td style="word-break:break-word">${esc(r.signer_ua)}</td></tr>` : ""}
        ${r.docs.map(d => `<tr><th>${esc(d.title)}</th><td style="word-break:break-all;font-family:ui-monospace,monospace;font-size:.82rem">SHA-256 ${esc(d.hash)}</td></tr>`).join("")}
        ${r.seal ? `<tr><th>Signature seal</th><td style="word-break:break-all;font-family:ui-monospace,monospace;font-size:.82rem">${esc(r.seal)}</td></tr>` : ""}
        </tbody></table>
        <h3>Audit trail</h3><table class="doc-fields"><tbody>${evs.map(e => `<tr><th>${esc(london(e.at))}</th><td>${esc(e.event)}${staff && e.ip ? `<br><small style="color:#6b6070">IP ${esc(e.ip)}</small>` : ""}</td></tr>`).join("")}</tbody></table>
        <p class="doc-small">The document fingerprints (SHA-256) are taken when the documents are issued. Any change to a document after issue would change its fingerprint.</p>
      </article>`;
  }
};
module.exports.INIT_SQL = INIT_SQL;
