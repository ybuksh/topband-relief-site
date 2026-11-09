"use strict";
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const BRAND = process.env.BRAND || "Every Penny Back";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SITE_ORIGINS = (process.env.SITE_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";
const PHONE = process.env.PHONE || "0161 399 2916";
const FEE_RATE = 0.30, VAT_RATE = 0.20, PAY_DAYS = 14;

const DB_URL = process.env.DATABASE_URL || process.env.database_url || "";
const pool = DB_URL
  ? new Pool({ connectionString: DB_URL, ssl: DB_URL.includes("render.com") ? { rejectUnauthorized: false } : false })
  : null;

/* ---------- stages (grouped as in the HMRC-reviewed case workflow) ---------- */
const STAGES = [
  { id: "new", group: "Intake", label: "New enquiry", next: ["Call the client", 0] },
  { id: "contacted", group: "Intake", label: "Called", next: ["Follow up call", 2] },
  { id: "qualified", group: "Intake", label: "Qualified", next: ["Prepare the sign-up pack (fee agreement, 64-8, DWP authority), fully completed before sending", 0] },
  { id: "pack_sent", group: "Documents", label: "Pack sent to sign", next: ["Chase signature", 3] },
  { id: "resign", group: "Documents", label: "Re-sign needed", next: ["Send corrected new version for a fresh signature", 1] },
  { id: "signed", group: "ID check", label: "Signed, ID check", next: ["Run the electronic ID check. Nothing moves on until it passes", 0] },
  { id: "ni_wait", group: "HMRC", label: "Invited to share NI record", next: ["If the client hasn't shared their NI record, send the targeted request to HMRC", 7] },
  { id: "ni_requested", group: "HMRC", label: "NI record requested", next: ["Call the HMRC NI agent helpline about the NI record request", 21] },
  { id: "hmrc_invalid", group: "HMRC", label: "HMRC rejected client details", next: ["Correct the details HMRC rejected (name, date of birth, address or signature) and resubmit", 2] },
  { id: "resubmit_648", group: "HMRC", label: "64-8 rejected, resubmit", next: ["Fix the 64-8 problem and resubmit it to HMRC", 1] },
  { id: "hmrc_agent", group: "HMRC", label: "Another agent on HMRC record", next: ["Ask the client whether to remove the other agent, then resubmit the 64-8", 2] },
  { id: "dwp_requested", group: "DWP", label: "DWP info requested", next: ["Chase DWP for the information", 21] },
  { id: "dwp_more", group: "DWP", label: "DWP needs more evidence", next: ["Get the evidence DWP asked for from the client", 7] },
  { id: "uplift_dwp", group: "DWP", label: "Uplift claim with DWP", next: ["Chase DWP on the married or widowed uplift claim", 30] },
  { id: "preparing", group: "Review", label: "Reviewing evidence", next: ["Decide: prepare CF411 if HMRC and DWP evidence supports a claim, otherwise close", 3] },
  { id: "cf411_sent", group: "CF411", label: "CF411 sent to sign", next: ["Client asked to sign within 7 days: chase if not signed", 7] },
  { id: "cf411_info", group: "CF411", label: "HMRC asked for more information", next: ["Get the missing details from the client and reply to HMRC", 5] },
  { id: "submitted", group: "CF411", label: "CF411 with HMRC", next: ["Call the HMRC NI agent line for an update, then every 2 weeks", 28] },
  { id: "decision", group: "Outcome", label: "Outcome received", next: ["Get the DWP arrears breakdown letter", 7] },
  { id: "invoiced", group: "Fees", label: "Invoiced", next: ["If unpaid, send reminder 1", PAY_DAYS] },
  { id: "payment_plan", group: "Fees", label: "Payment plan", next: ["Check this month's plan payment arrived", 30] },
  { id: "fee_review", group: "Fees", label: "Fee resolution review", next: ["Manager reviews the case, vulnerability and hardship before any final notice", 2] },
  { id: "on_hold", group: "Hold", label: "On hold", next: ["Review why this is on hold", 14] },
  { id: "hold_complaint", group: "Hold", label: "Hold: complaint open", next: ["Resolve the complaint before any chasing", 5] },
  { id: "hold_sar", group: "Hold", label: "Hold: data request or restriction", next: ["Answer the data request; no processing beyond what's allowed", 5] },
  { id: "estate_review", group: "Hold", label: "Hold: client died, estate review", next: ["Get the death certificate and grant or letters, confirm the personal representative", 7] },
  { id: "fraud_freeze", group: "Hold", label: "STOP: suspected fraud", next: ["Compliance to review: do not contact HMRC or DWP", 1] },
  { id: "paid", group: "Closed", label: "Fee paid", next: ["Ask for a review and referral", 1] },
  { id: "closed_none", group: "Closed", label: "Closed: nothing owed", next: null },
  { id: "closed_withdrawn", group: "Closed", label: "Closed: cancelled in cooling-off (no fee)", next: null },
  { id: "closed_lost", group: "Closed", label: "Closed: not going ahead", next: null },
  { id: "closed_ineligible", group: "Closed", label: "Closed: does not qualify", next: null },
  { id: "closed_fulltime", group: "Closed", label: "Closed: worked full time, no years", next: null },
  { id: "closed_duplicate", group: "Closed", label: "Closed: duplicate", next: null },
  { id: "closed_nocontact", group: "Closed", label: "Closed: no contact", next: null },
  { id: "closed_deceased", group: "Closed", label: "Closed: client died, estate not claiming", next: null },
  { id: "closed_elsewhere", group: "Closed", label: "Closed: already claimed elsewhere", next: null }
];
const STAGE = Object.fromEntries(STAGES.map(s => [s.id, s]));
const DONE = ["paid", "closed_none", "closed_withdrawn", "closed_lost", "closed_ineligible", "closed_fulltime", "closed_duplicate", "closed_nocontact", "closed_deceased", "closed_elsewhere"];
const OPEN_STAGES = STAGES.filter(s => !DONE.includes(s.id));
const DONE_SQL = "ARRAY['" + DONE.join("','") + "']";
const ORDER = STAGES.map(s => s.id);
/* stages that need a passed ID check first */
const NEEDS_ID = ["ni_wait", "ni_requested", "resubmit_648", "uplift_dwp", "hmrc_agent", "dwp_more", "cf411_info", "dwp_requested", "preparing", "cf411_sent", "submitted", "decision", "invoiced", "payment_plan", "paid"];
const KYC = { pending: "Pending", passed: "Passed", escalation: "Escalated for review", failed: "Failed" };

const CLIENT_STEPS = ["Enquiry received", "Your paperwork", "Gathering your records", "Claim with HMRC", "Decision made", "Complete"];
const CLIENT_STAGE = {
  new: [0, "We've received your enquiry. One of our team will call you at the time you chose."],
  contacted: [0, "We've spoken with you and are looking at whether we can help."],
  qualified: [1, "We're getting your paperwork ready. You'll receive it to read and sign shortly."],
  pack_sent: [1, "We've sent your paperwork. Please read and sign it when you're ready, or call us with any questions. You can ask for paper copies."],
  resign: [1, "We've sent you an updated version of your paperwork. Please sign the new version."],
  signed: [1, "Thank you for signing. We're confirming your identity, which we do electronically. You can cancel free within 14 days of signing."],
  ni_wait: [2, "We're gathering your records. If you use your HMRC online account, you can share your National Insurance record with us, but you don't have to."],
  ni_requested: [2, "We've asked HMRC for your National Insurance record for the years that matter. We'll chase them if needed."],
  dwp_requested: [2, "We've asked DWP for your State Pension details. We'll chase them if needed."],
  preparing: [2, "We're reviewing your HMRC and DWP records to see whether a claim is supported."],
  cf411_sent: [2, "Your records support a claim. We've sent your claim form (CF411) to check and sign."],
  submitted: [3, "Your claim is with HMRC. They currently take several months to reply. We'll chase them and keep you updated."],
  decision: [4, "HMRC has made a decision. If arrears are due, DWP will pay them straight to you. Please send us the DWP letter showing your arrears when it arrives."],
  invoiced: [4, "DWP has confirmed your arrears and we've sent our invoice, due 14 days from the invoice date. Please call us if you need a payment plan."],
  payment_plan: [4, "Your claim is complete and you're paying our fee by instalments. Thank you."],
  on_hold: [2, "Your claim is on hold for the moment. We'll be in touch, or call us for an update."],
  paid: [5, "Your claim is complete. Thank you for using us."],
  closed_none: [5, "This claim is now closed. Please call us if you have any questions."],
  closed_withdrawn: [5, "You cancelled within the cooling-off period, so there is nothing to pay. Please call us if you have any questions."],
  closed_lost: [5, "This claim is now closed. Please call us if you have any questions."],
  resubmit_648: [2, "HMRC needs us to resend your authority form. We're dealing with it and there's nothing you need to do."],
  uplift_dwp: [3, "We've sent your State Pension increase claim to DWP. We'll chase them and keep you updated."],
  closed_ineligible: [5, "We've looked at your records and you don't qualify for a claim, so there's nothing to pay. Please call us if you have any questions."],
  closed_fulltime: [5, "Your records show you were working full time in the relevant years, so there's nothing to claim and nothing to pay."],
  closed_duplicate: [5, "This enquiry is a duplicate of another one we hold for you, so we've closed it. Your other claim carries on."],
  closed_nocontact: [5, "We closed this enquiry because we couldn't reach you. Please call us if you'd like to carry on."],
  hmrc_agent: [2, "HMRC shows another adviser acting for you. We'll call you to check how you'd like to go ahead."],
  dwp_more: [2, "DWP has asked for some more information. We'll be in touch about what's needed."],
  cf411_info: [3, "HMRC has asked for a little more information about your claim. We'll be in touch if we need anything from you."],
  closed_deceased: [5, "This claim has been closed. Please call us if you have any questions."],
  closed_elsewhere: [5, "This claim is closed because it's already being handled elsewhere. Please call us if you have any questions."],
  hmrc_invalid: [2, "HMRC has asked us to correct some details. We may need to check them with you."],
  fee_review: [4, "We'll be in touch about your invoice. If you're finding it hard to pay, please call us and we'll help."],
  hold_complaint: [2, "We're looking into the concern you raised and will be in touch."],
  hold_sar: [2, "We're dealing with your request about your information and will be in touch."],
  estate_review: [2, "We're sorry for your loss. We'll contact the person dealing with the estate about the next steps."],
  fraud_freeze: [2, "We're carrying out some checks on this claim. Please call us if you have any questions."]
};
const QA_ITEMS = [
  ["intro", "Said who we are, and that we're not HMRC, DWP or the government", false],
  ["identity", "Confirmed identity before discussing the claim", false],
  ["free", "Explained they can claim free through GOV.UK", true],
  ["cb", "Explained that Child Benefit doesn't automatically mean a claim", false],
  ["fee", "Explained the fee clearly: 30% + VAT (36%) of arrears, none on the weekly increase, nothing if nothing is paid", true],
  ["cooling", "Explained they can cancel within 14 days at no cost", false],
  ["benefits", "Mentioned a higher pension can affect Pension Credit and other benefits", false],
  ["vulnerable", "Checked for vulnerability and made adjustments", false],
  ["nopressure", "No pressure, no promises about amounts or timescales", true]
];
const CLAIM_TYPES = { hrp: "Missing HRP", married: "Married uplift", catbl: "Category BL", widowed: "Widowed or inherited pension", divorced: "Former partner's record", deferred: "Deferred State Pension", nicredits: "NI credits error", pensioncredit: "Linked Pension Credit", over80: "Over-80 pension", other: "Other record error" };
/* DWP State Pension information request, sent under the client's signed DWP letter of authority.
   Only the sections that match the case's claim types are requested; the rest are marked "not requested". */
const DWP_SECTIONS = [
  ["A", "HRP-related State Pension correction", ["hrp"], ["whether the State Pension award has been checked or recalculated for missing or wrongly recorded Home Responsibilities Protection (HRP)", "the HRP credits or equivalent qualifying years taken into account", "the current or revised weekly State Pension rate resulting from those credits"]],
  ["B", "National Insurance credit or qualifying-year correction affecting State Pension", ["nicredits"], ["whether any National Insurance credit or qualifying-year correction has been applied or taken into account", "the number of qualifying years or credits added, where available", "the current or revised weekly State Pension rate resulting from those corrections"]],
  ["C", "Widow's, widower's or surviving spouse's increase, or inherited State Pension", ["widowed"], ["whether the client has been reviewed for any widow's, widower's or surviving spouse's increase or inherited State Pension", "whether any increase or correction has been identified or applied", "the revised weekly rate and the amount of any increase"]],
  ["D", "Increase based on a husband's, wife's or civil partner's record, including Category BL", ["married", "catbl", "divorced"], ["whether the client has been reviewed for any increase based on a spouse's or civil partner's record, including Category BL", "whether any increase or correction has been identified or applied", "the revised weekly rate and the amount of any increase"]],
  ["E", "Deferred State Pension", ["deferred"], ["whether DWP records show a period of deferral relevant to the award, and the period used", "whether any extra State Pension or lump sum is due or has been applied", "the revised weekly rate and the amount of any increase or lump sum"]],
  ["F", "Linked Pension Credit effect only", ["pensioncredit"], ["whether the State Pension correction has affected any Pension Credit award or refusal", "any revised Pension Credit amount or arrears arising from the correction"]],
  ["G", "Outcome, arrears and revised payment for the matters requested", null, ["whether the correction was made, and the decision date", "the exact backdated arrears or lump sum due to the client, the period it covers, and any amount withheld (for example to recover an overpayment)", "the revised weekly State Pension rate and the payment date, where available"]]
];
function dwpRequestBody(L, pack, brand, company) {
  const types = new Set(String(L.claim_types || "").split(",").filter(Boolean));
  if (!types.size) types.add("hrp");
  const want = s => !s[2] || s[2].some(t => types.has(t));
  const name = [L.title, L.first_name, L.last_name].filter(Boolean).join(" ");
  const signedOn = pack && pack.signed_at ? fmtDate(iso(pack.signed_at)) : "[date signed]";
  return `<p><b>State Pension correction and underpayment review: information request</b></p>
<p>We write on behalf of ${esc(name)} about a possible correction to their State Pension, limited to the sections marked "requested" below and any resulting arrears. ${esc(name)} signed the enclosed letter of authority on ${esc(signedOn)}, allowing you to share information about these matters with ${esc(company)} (trading as ${esc(brand)}). We have verified the client's identity as part of our onboarding checks.</p>
<p>We understand that DWP will continue to pay any money due directly to the client. We act only as the client's representative for this review: we are not their appointee, attorney or deputy, and we cannot receive or redirect any payment.</p>
<p><b>Core information</b>, where available and only as relevant to the sections requested: a copy of the client's current or most recent State Pension award notice; any statement or calculation breakdown showing the qualifying years and credits used and the resulting weekly rate; and the total number of qualifying years used.${L.marriage_date ? ` The client married on ${fmtDate(iso(L.marriage_date))}.` : ""}${L.partner_death_date ? ` The client's spouse or civil partner died on ${fmtDate(iso(L.partner_death_date))}.` : ""} If you need further spouse or civil partner details to identify a record, please tell us what you need.</p>
<table class="doc-fields"><thead><tr><th>Section</th><td><b>Status</b></td></tr></thead><tbody>${DWP_SECTIONS.map(s => `<tr><th>${s[0]}. ${esc(s[1])}</th><td>${want(s) ? "<b>Requested</b>" : "Not requested"}</td></tr>`).join("")}</tbody></table>
${DWP_SECTIONS.filter(want).map(s => `<p><b>${s[0]}. ${esc(s[1])}.</b> Please confirm, limited to the effect on the client's State Pension:</p><ul>${s[3].map(x => `<li>${esc(x)};</li>`).join("")}</ul>`).join("")}
<p>Please respond only to the sections requested; the others are not part of this request. Where you issue a formal decision or award notice about the matters requested, please send us a copy under the enclosed authority. Thank you for your help.</p>`;
}

const FILE_KINDS = { soa: "NI statement (SoA) from HMRC", reject648: "64-8 rejection from HMRC", cf411reply: "CF411 reply from HMRC", dwp: "DWP letter", arrears: "DWP arrears letter", id: "ID document", other: "Other" };
const LABELS = {
  cb: { yes: "Yes, paid to the client", partner: "Paid to partner (partner should claim)", no: "No", unsure: "Not sure" },
  care: { yes: "Yes", no: "No" },
  for_whom: { me: "Themselves", help: "Someone they're helping", died: "Someone who has died" },
  pension: { less: "Less than full", full: "Full", none: "Not receiving yet", unsure: "Not sure" },
  marital: { married: "Married or civil partnership", widowed: "Widowed", divorced: "Divorced or dissolved", single: "Single" },
  credit: { yes: "Yes", no: "No", unsure: "Not sure" },
  ft: { no: "Never full time while children were young", some: "Full time in some years", throughout: "Says full time throughout", unsure: "Not sure" },
  sp_band: { u100: "Under £100 a week", "100": "£100 to £150 a week", "150": "£150 to £200 a week", "200": "Over £200 a week", unsure: "Not sure" }
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
const normNi = v => String(v ?? "").replace(/\s/g, "").toUpperCase().slice(0, 9);
const validNi = n => /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(n) && !/^(BG|GB|KN|NK|NT|TN|ZZ)/.test(n);
const fmtNi = n => n && n.length === 9 ? `${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)} ${n[8]}` : n || "";
const ty = y => `${y}–${String(y + 1).slice(2)}`;
const parseYears = v => [...new Set(String(v ?? "").split(/[^0-9]+/).map(Number).filter(y => y >= 1978 && y <= 2009))].sort((a, b) => a - b);
/* the tax years to ask HMRC about: Child Benefit years (child under 16), 1978-79 to 2009-10, minus full-time years */
/* tax year a date falls in (tax years start 6 April) */
const taxYearOf = d => { const x = new Date(String(d).slice(0, 10) + "T12:00:00Z"); const y = x.getUTCFullYear(); return (x.getUTCMonth() > 3 || (x.getUTCMonth() === 3 && x.getUTCDate() >= 6)) ? y : y - 1; };
const kids = L => (Array.isArray(L.children) ? L.children : []).filter(c => c && (c.name || c.dob));
/* Child Benefit years for children under 16: from the eldest's birth to the youngest's 16th birthday */
function cbRange(L) {
  const dobs = kids(L).map(c => c.dob).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d || "")).sort();
  if (L.cb_from && L.cb_to) return [L.cb_from, L.cb_to];
  if (dobs.length) { const last = dobs[dobs.length - 1]; return [taxYearOf(dobs[0]), taxYearOf((Number(last.slice(0, 4)) + 16) + last.slice(4)) - 1]; }
  if (L.kid1) return [Number(L.kid1), L.kid2 ? Number(L.kid2) + 15 : Number(L.kid1) + 15];
  return null;
}
const hrpMap = L => (L.hrp_years && typeof L.hrp_years === "object" ? L.hrp_years : {});
/* years HMRC's record shows HRP missing for, within the Child Benefit years */
function hrpDue(L) { const m = hrpMap(L); return Object.keys(m).filter(y => m[y] === "missing").map(Number).sort((a, b) => a - b); }
function hrpAudit(L) {
  const m = hrpMap(L), ft = new Set(parseYears(L.ft_years)), vals = Object.values(m);
  if (!vals.length) return null;
  const conflict = Object.keys(m).filter(y => m[y] === "missing" && ft.has(Number(y)));
  if (conflict.length) return { kind: "conflict", text: `HRP conflict: marked missing but also listed as full-time in ${yearRanges(conflict.map(Number))}` };
  const due = hrpDue(L);
  return due.length ? { kind: "due", text: `HRP due for ${due.length} year${due.length > 1 ? "s" : ""}: ${yearRanges(due)}` } : { kind: "notdue", text: "HRP not due: every year checked is already covered" };
}
function claimSummary(L) {
  const due = hrpDue(L), ks = kids(L);
  const lines = [];
  lines.push(due.length ? `Tax years claimed: ${yearRanges(due)} (${due.length} year${due.length > 1 ? "s" : ""})` : "Tax years claimed: [record HMRC's answer for each year on the client record]");
  if (ks.length) { lines.push("Children:"); ks.forEach(c => lines.push(`- ${c.name || "[name]"}, born ${c.dob ? fmtDate(c.dob) : "[date of birth]"}${c.father ? `, father ${c.father}` : ""}`)); }
  else lines.push("Children: [add each child on the client record]");
  lines.push(`Child Benefit paid to: ${[L.title, L.first_name, L.last_name].filter(Boolean).join(" ")}`);
  return lines.join("\n");
}
const PC_RE = /^(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/i;
/* field-level checks at capture: each is ok / bad / missing, plus a message */
function validation(L, signedName) {
  const v = [];
  const nm = [L.first_name, L.last_name].every(x => x && String(x).trim().length >= 2);
  v.push({ key: "name", label: "Name", st: nm ? (L.hmrc_name && L.hmrc_name.trim().toLowerCase() !== [L.first_name, L.last_name].join(" ").toLowerCase() ? "ok" : "ok") : "bad", msg: nm ? (L.hmrc_name ? `HMRC holds "${L.hmrc_name}"` : "Confirm the name HMRC holds") : "First and last name needed" });
  if (!L.dob) v.push({ key: "dob", label: "Date of birth", st: "missing", msg: "Not recorded" });
  else { const y = Number(iso(L.dob).slice(0, 4)); const bad = L.born && y !== Number(L.born); const age = new Date().getUTCFullYear() - y;
    v.push({ key: "dob", label: "Date of birth", st: bad || age < 60 || age > 110 ? "bad" : "ok", msg: bad ? `Year doesn't match the check (${L.born})` : age < 60 ? "Too young for State Pension" : age > 110 ? "Looks wrong" : fmtDate(iso(L.dob)) }); }
  v.push({ key: "ni", label: "NI number", st: !L.ni_number ? "missing" : validNi(L.ni_number) ? "ok" : "bad", msg: !L.ni_number ? "Not recorded" : validNi(L.ni_number) ? fmtNi(L.ni_number) : "Not a valid format" });
  v.push({ key: "address", label: "Address", st: !L.address || !L.postcode ? "missing" : PC_RE.test(String(L.postcode).trim()) ? "ok" : "bad", msg: !L.address || !L.postcode ? "Address and postcode needed" : PC_RE.test(String(L.postcode).trim()) ? L.postcode : "Postcode isn't a valid UK format" });
  v.push({ key: "signature", label: "Signature", st: signedName === undefined ? "missing" : signedName === null ? "missing" : "ok", msg: signedName ? `Signed as "${signedName}"` : "Pack not signed yet" });
  v.push({ key: "hmrc", label: "HMRC details verified", st: L.hmrc_verified ? "ok" : "missing", msg: L.hmrc_verified ? "Matches HMRC's records" : "Not yet checked against HMRC" });
  return v;
}
/* risk rating from the enhanced-check triggers in the AML policy */
function riskOf(L) {
  const t = [];
  if (L.sanctions === "confirmed") t.push(["high", "Sanctions or PEP match confirmed"]);
  if (L.sanctions === "possible") t.push(["medium", "Possible sanctions or PEP match"]);
  if (L.kyc === "failed") t.push(["high", "ID check failed"]);
  if (L.kyc === "escalation") t.push(["medium", "ID check escalated"]);
  if (L.stage === "fraud_freeze") t.push(["high", "Suspected fraud"]);
  if (L.vulnerable) t.push(["medium", "Vulnerable client"]);
  if (L.third_party_payer) t.push(["medium", "Fee paid by a third party"]);
  if (L.attorney) t.push(["medium", "Someone else acts for the client"]);
  if (L.dup_of) t.push(["medium", "Possible duplicate"]);
  if (L.stage === "hmrc_agent") t.push(["medium", "Another agent on HMRC record"]);
  if (L.cb === "partner" || L.other_cb) t.push(["medium", "Child Benefit may have been paid to someone else"]);
  const level = t.some(x => x[0] === "high") ? "high" : t.length ? "medium" : "low";
  return { level, reasons: t.map(x => x[1]) };
}
/* rough arrears value: missing years x weekly value of a year x weeks since State Pension started */
let RATES = { basic: 184.90, nsp: 241.30, at: 0 };
async function loadRates() { if (Date.now() - RATES.at < 300e3 || !pool) return RATES; try { const r = await pool.query("SELECT key, value FROM settings WHERE key IN ('rate_basic','rate_nsp')"); const m = Object.fromEntries(r.rows.map(x => [x.key, Number(x.value)])); RATES = { basic: m.rate_basic || 184.90, nsp: m.rate_nsp || 241.30, at: Date.now() }; } catch { } return RATES; }
function spStart(L) {
  if (L.sp_start_year) return `${L.sp_start_year}-06-01`;
  const dob = L.dob ? iso(L.dob) : L.born ? `${L.born}-07-01` : null; if (!dob) return null;
  const y = Number(dob.slice(0, 4)), male = /^(Mr|Sir)$/i.test(String(L.title || "").trim());
  const age = male ? (y < 1954 ? 65 : y < 1960 ? 66 : 66.5) : (y < 1950 ? 60 : y < 1953 ? 62 : y < 1954 ? 64 : y < 1960 ? 66 : 66.5);
  const d = new Date(dob + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + Math.round(age * 12)); return d.toISOString().slice(0, 10);
}
/* Upper-bound arrears used to rank cases: every missing year counted, each worth 1/n of the full pension
   (n = 39 for women and 44 for men whose pension started before April 2010, 30 to April 2016, 35 after),
   with past weekly rates taken as roughly 3.5% a year lower than today's. Real arrears are usually lower. */
function estimate(L) {
  const st = spStart(L); if (!st || st > today()) return null;
  const due = hrpDue(L), yrs = due.length || Math.round((requestYears(L) || []).length * 0.6);
  if (!yrs) return null;
  const male = /^(Mr|Sir)$/i.test(String(L.title || "").trim());
  const nsp = st >= "2016-04-06", n = nsp ? 35 : st >= "2010-04-06" ? 30 : male ? 44 : 39;
  const weekly = Math.min(yrs, n) * (nsp ? RATES.nsp : RATES.basic) / n;
  const yearsPaid = Math.max(0, (Date.parse(today()) - Date.parse(st)) / (365.25 * 86400e3));
  let weeks = 0; for (let k = 0; k < yearsPaid; k++) weeks += Math.min(1, yearsPaid - k) * 52.18 / Math.pow(1.035, k);
  return { amount: Math.round(weekly * weeks / 10) * 10, years: yrs, confirmed: !!due.length, nsp, start: st };
}
function requestYears(L) {
  const cr = cbRange(L);
  const from = cr && cr[0], to = cr && cr[1];
  if (!from || !to) return null;
  const ft = new Set(parseYears(L.ft_years)), out = [];
  for (let y = Math.max(1978, from); y <= Math.min(2009, to); y++) if (!ft.has(y)) out.push(y);
  return out;
}
function yearRanges(list) {
  const r = []; for (const y of list) { const l = r[r.length - 1]; if (l && l[1] === y - 1) l[1] = y; else r.push([y, y]); }
  return r.map(([a, b]) => a === b ? ty(a) : `${ty(a)} to ${ty(b)}`).join(", ");
}
async function findDuplicate(id, f) {
  const digits = String(f.phone || "").replace(/\D/g, "").slice(-10);
  const r = await pool.query(`SELECT id FROM leads WHERE id <> $1 AND NOT is_test AND (
      ($2 <> '' AND lower(email) = lower($2)) OR ($3 <> '' AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $3)
      OR ($4 <> '' AND ni_number = $4)
      OR (lower(first_name) = lower($5) AND lower(last_name) = lower($6) AND born IS NOT DISTINCT FROM $7))
    ORDER BY id LIMIT 1`, [id, f.email || "", digits.length >= 9 ? digits : "", f.ni_number || "", f.first_name || "", f.last_name || "", f.born || null]);
  if (r.rows[0]) { await pool.query("UPDATE leads SET dup_of=$2 WHERE id=$1", [id, r.rows[0].id]); await log(id, "check", `Possible duplicate of ref ${r.rows[0].id}. Check before contacting.`); }
  else if (f.ip) {
    const ipm = await pool.query("SELECT id FROM leads WHERE id <> $1 AND NOT is_test AND ip = $2 AND created_at > now() - interval '30 days' ORDER BY id LIMIT 1", [id, f.ip]);
    if (ipm.rows[0]) await log(id, "check", `Sent from the same internet connection as ref ${ipm.rows[0].id} in the last 30 days. Could be the same household, or a duplicate.`);
  }
}

/* ---------- auth ---------- */
function sign(v) { return crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex"); }
function makeSession() { const exp = Date.now() + 12 * 3600e3; return exp + "." + sign(String(exp)); }
function validSession(c) {
  if (!c) return false; const [exp, mac] = c.split("."); if (!exp || !mac || Number(exp) < Date.now()) return false;
  const good = sign(exp); return mac.length === good.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good));
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map(p => p.trim().split("=").map(decodeURIComponent)).filter(p => p[0])); }
async function submissionHold() { const r = await pool.query("SELECT value FROM settings WHERE key='hmrc_hold'"); return (r.rows[0] || {}).value || ""; }
let ipList = { at: 0, list: [] };
async function allowedIps() {
  if (Date.now() - ipList.at > 60e3 && pool) { try { const r = await pool.query("SELECT value FROM settings WHERE key='staff_ips'"); ipList = { at: Date.now(), list: String((r.rows[0] || {}).value || "").split(/[\s,]+/).filter(Boolean) }; } catch { } }
  return ipList.list;
}
const clientIp = req => (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
async function ipGate(req, res, next) {
  const list = await allowedIps();
  if (!list.length || list.includes(clientIp(req))) return next();
  res.status(403).send(page("Not allowed", `<div class="panel" style="max-width:520px;margin:40px auto"><h1>Access from this network isn't allowed</h1><p>Staff access is limited to approved internet connections. Your address is ${esc(clientIp(req))}. Ask an administrator to add it.</p></div>`, { bare: true }));
}
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
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_message TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_message_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ni_number TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS kid1 INT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS kid2 INT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS cb_from INT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS cb_to INT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ft TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ft_years TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_name TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_ni TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_unknown TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS kyc TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS dup_of INT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS deductions NUMERIC(12,2);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS arrears_letter BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS reminders INT NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_reminder DATE;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS plan_note TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS pay_method TEXT;
    ${require("./esign").INIT_SQL}
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS vulnerable BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS vulnerable_note TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS hmrc_name TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS prev_names TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS prev_address TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS born_uk TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS outside_uk TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS other_cb TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS working_caring TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS children JSONB;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS marriage_date DATE;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_death_date DATE;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_self_employed TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS hrp_years JSONB;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS claim_types TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS sp_start_year INT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ip TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS user_agent TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS referrer TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_bad BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_bad BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS hmrc_verified BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS soa_sent_at DATE;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS dwp_sent_at DATE;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS paper_requested BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE activity ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS invoice_no TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS attorney TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS partial BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS partial_token TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS answers JSONB;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS detail_token TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS details_done_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS helper_name TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS helper_relation TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS helper_ok BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS helper_phone TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS helper_email TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_name TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS death_date TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS mobile TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS sp_band TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ft_from INT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS years_at_address TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_dob DATE;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_attempts INT NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_call_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS book_token TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS booked_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS leads_partial_token_idx ON leads(partial_token) WHERE partial_token IS NOT NULL;
    CREATE TABLE IF NOT EXISTS funnel_events (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), sid TEXT NOT NULL, step TEXT NOT NULL, utm TEXT);
    CREATE INDEX IF NOT EXISTS funnel_events_at_idx ON funnel_events(at);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS sanctions TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS edd_approved_by TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS cf411_checked_by TEXT;
    ${require("./messaging").INIT_SQL}
    ${require("./payments").INIT_SQL}
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS invoice_sent_at DATE;
    CREATE TABLE IF NOT EXISTS qa_scores (
      id SERIAL PRIMARY KEY, lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE, at TIMESTAMPTZ NOT NULL DEFAULT now(),
      agent TEXT, call_type TEXT, items JSONB NOT NULL, score INT NOT NULL, critical_fail BOOLEAN NOT NULL DEFAULT false, notes TEXT, reviewer TEXT
    );
    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY, lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT, size INT, data BYTEA NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_lead_idx ON files(lead_id);
    CREATE INDEX IF NOT EXISTS leads_ip_idx ON leads(ip);
    UPDATE leads SET kyc = 'passed' WHERE kyc = 'pending' AND signed_at IS NOT NULL AND stage = ANY(ARRAY['preparing','submitted','decision','invoiced','paid']);
  `);
}
const log = (id, kind, text) => pool.query("INSERT INTO activity(lead_id,kind,text) VALUES($1,$2,$3)", [id, kind, text]);
const getLeadRow = async id => (await pool.query("SELECT * FROM leads WHERE id=$1", [id])).rows[0];

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
<a href="/post" class="${opts.nav === "post" ? "on" : ""}">Post</a>
<a href="/complaints" class="${opts.nav === "complaints" ? "on" : ""}">Complaints</a>
<a href="/qa" class="${opts.nav === "qa" ? "on" : ""}">Call quality</a>
<a href="/messages" class="${opts.nav === "messages" ? "on" : ""}">Messages</a>
<a href="/reports" class="${opts.nav === "reports" ? "on" : ""}">Reports</a>
<a href="/closed" class="${opts.nav === "closed" ? "on" : ""}">Closed</a>
<a href="/new" class="${opts.nav === "new" ? "on" : ""}">Add enquiry</a>
<a href="/export.csv">Export</a>
<a href="/admin" class="${opts.nav === "admin" ? "on" : ""}">Settings</a>
<a href="/logout">Log out</a></nav></header>`}
<main>${body}</main></body></html>`;
}
function flags(r) {
  const f = [];
  if (r.is_test) f.push(`<span class="pill">Test</span>`);
  if (r.dup_of) f.push(`<span class="pill bad">Possible duplicate</span>`);
  if (r.cb === "partner") f.push(`<span class="pill bad">Partner claimed CB</span>`);
  if (r.ni_number && !validNi(r.ni_number)) f.push(`<span class="pill bad">Check NI number</span>`);
  if (r.signed_at && r.kyc !== "passed") f.push(`<span class="pill ${r.kyc === "failed" ? "bad" : ""}">ID: ${esc(KYC[r.kyc] || r.kyc)}</span>`);
  if (r.signed_at && r.partner_unknown && !r.partner_name) f.push(`<span class="pill">Partner details not known</span>`);
  if (r.vulnerable) f.push(`<span class="pill bad">Vulnerable</span>`);
  if (r.email_bad) f.push(`<span class="pill bad">Email bouncing</span>`);
  if (r.phone_bad) f.push(`<span class="pill bad">Phone not working</span>`);
  if (r.paper_requested) f.push(`<span class="pill">Wants paper</span>`);
  if (r.partial) f.push(`<span class="pill bad">Unfinished check</span>`);
  if (r.details_done_at) f.push(`<span class="pill good">Details online</span>`);
  if (r.for_whom === "help") f.push(`<span class="pill">Helper: ${esc(r.helper_relation || "yes")}</span>`);
  if (r.for_whom === "died") f.push(`<span class="pill">Estate</span>`);
  if (r.booked_at && new Date(r.booked_at) > new Date()) f.push(`<span class="pill good">Call booked</span>`);
  if (r.call_attempts && ["new", "contacted"].includes(r.stage)) f.push(`<span class="pill">${r.call_attempts} call${r.call_attempts > 1 ? "s" : ""} tried</span>`);
  if (r.owner) f.push(`<span class="pill">${esc(r.owner)}</span>`);
  if (r.attorney) f.push(`<span class="pill bad">Attorney: hold</span>`);
  if (r.sanctions === "possible" || r.sanctions === "confirmed") f.push(`<span class="pill bad">Sanctions check</span>`);
  if (r.stage === "fraud_freeze") f.push(`<span class="pill bad">STOP</span>`);
  return f.join(" ");
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
const PAY = require("./payments")({ pool, log, page, esc, fmtDate, iso, today, BRAND, PHONE, clip, gbp, settings: (...a) => ES.settings(...a) });
const MSG = require("./messaging")({ pool, log, page, esc, fmtDate, iso, today, addDays, sendEmail, BRAND, PHONE, clip, gbp });
PAY.rawRoutes(app, express);
app.use(express.urlencoded({ extended: false, limit: "400kb" }));
app.use("/api", express.json({ limit: "20kb" }));

app.get("/healthz", (req, res) => res.send("ok"));

const ES = require("./esign")({ pool, log, page, esc, fmtDate, iso, today, addDays, validNi, requestYears, sendEmail, BRAND, PHONE, SESSION_SECRET, clip, claimSummary });
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
const SITE_URL = (process.env.SITE_URL || SITE_ORIGINS[0] || "https://topband-relief-test.onrender.com").replace(/\/$/, "");
const tok = () => crypto.randomBytes(24).toString("base64url");
const ipOfReq = req => (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
function rateOk(req, max = 30) { const ip = ipOfReq(req), now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3); if (list.length >= max) return false; list.push(now); hits.set(ip, list); return true; }
/* answers from the website check, mapped onto the case record */
function mapAnswers(b) {
  const forWhom = clip(b.for, 10) || "me";
  const helped = forWhom !== "me";
  const ftMode = clip(b.ft, 12);
  const f = {
    cb: clip(b.cb, 20), care: clip(b.care, 10), for_whom: forWhom, pension: clip(b.pension, 10),
    born: parseInt(b.born, 10) || null, marital: clip(b.status, 12), credit: clip(b.credit, 10),
    title: clip(b.ti, 10), first_name: clip(b.fn, 80) || (forWhom === "me" ? clip(b.efn, 80) : ""), last_name: clip(b.ln, 80), maiden_name: clip(b.mn, 80),
    best_time: clip(b.bt, 60), consent: b.ok === true || b.ok === "true",
    ni_number: normNi(b.ni) || null, kid1: parseInt(b.kid1, 10) || null, kid2: parseInt(b.kid2, 10) || null,
    ft: ftMode || null, ft_years: ftMode === "some" && Array.isArray(b.fty) ? parseYears(b.fty.join(",")).join(",") : null,
    ft_from: parseInt(b.ftFrom, 10) || null, sp_band: clip(b.spb, 10) || null, sp_start_year: parseInt(b.spy, 10) || null,
    helper_name: helped ? [clip(b.hfn || b.efn, 60), clip(b.hln, 60)].filter(Boolean).join(" ") || null : null,
    helper_relation: helped ? clip(b.rel, 60) || null : null, helper_ok: b.hok === true,
    death_date: forWhom === "died" ? clip(b.dd, 40) || null : null, upliftOnly: !!b.upliftOnly
  };
  /* who we phone and text: the claimant if they gave a number, otherwise the helper */
  const claimantPhone = forWhom === "help" ? clip(b.cph, 30) : "";
  const helperPhone = clip(b.ph || b.eph, 30);
  f.phone = forWhom === "me" ? clip(b.ph || b.eph, 30) : (claimantPhone || helperPhone);
  f.mobile = clip(b.mob, 30) || null;
  f.email = clip(b.em, 160);
  f.helper_phone = helped ? helperPhone || null : null;
  f.helper_email = helped ? f.email || null : null;
  f.contact_name = helped && !claimantPhone ? clip(b.hfn || b.efn, 60) || null : null;
  return f;
}
const leadCols = ["cb", "care", "for_whom", "pension", "born", "marital", "credit", "title", "first_name", "last_name", "maiden_name", "email", "phone", "mobile", "best_time", "ni_number", "kid1", "kid2", "ft", "ft_years", "ft_from", "sp_band", "sp_start_year", "helper_name", "helper_relation", "helper_ok", "helper_phone", "helper_email", "death_date", "contact_name"];

/* step 1: name and phone early, so an unfinished check can be picked up */
app.post("/api/partial", async (req, res) => {
  try {
    if (!rateOk(req)) return res.status(429).json({ ok: false });
    const b = req.body || {}, A = b.answers || {};
    if (b.website) return res.json({ ok: true });
    if (b.token) return res.json({ ok: false });
    const name = clip(A.efn, 80), phone = clip(A.eph, 30);
    if (!name || !phone || !(A.ok === true)) return res.status(400).json({ ok: false, error: "Name, phone and consent needed" });
    const t = tok(), f = mapAnswers(A);
    const r = await pool.query(`INSERT INTO leads(source,partial,partial_token,answers,first_name,phone,for_whom,cb,care,consent,consent_text,next_action,next_action_date,ip,user_agent,referrer,utm,helper_name,contact_name,last_name)
      VALUES('website',true,$1,$2,$3,$4,$5,$6,$7,true,$8,'Unfinished check: we text a reminder; call if they don''t finish',$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [t, JSON.stringify(A), name, phone, f.for_whom, f.cb, f.care, "I agree to Every Penny Back contacting me about this check by phone, text, email and WhatsApp. I understand I can claim from HMRC myself for free.", nextWorkingDay(today()), ipOfReq(req) || null, clip(req.headers["user-agent"], 300) || null, clip(b.ref_url, 300) || null, clip(b.utm, 300) || null, f.for_whom === "me" ? null : name, f.for_whom === "me" ? null : name, f.for_whom === "me" ? "" : "(person they're helping)"]);
    await log(r.rows[0].id, "created", `Check started on the website by ${name}${f.for_whom !== "me" ? " (for someone else)" : ""}; not finished yet`);
    res.json({ ok: true, token: t });
  } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});
app.post("/api/partial/:token", async (req, res) => {
  const A = (req.body || {}).answers; if (!A || typeof A !== "object" || !/^[A-Za-z0-9_-]{20,60}$/.test(req.params.token)) return res.json({ ok: false });
  await pool.query("UPDATE leads SET answers=$2, updated_at=now() WHERE partial_token=$1 AND partial", [req.params.token, JSON.stringify(A).slice(0, 20000)]);
  res.json({ ok: true });
});
app.get("/api/partial/:token", async (req, res) => {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(req.params.token)) return res.json({ ok: false });
  const L = (await pool.query("SELECT id, answers, partial FROM leads WHERE partial_token=$1", [req.params.token])).rows[0];
  if (!L || !L.partial) return res.json({ ok: false });
  await log(L.id, "status", "Came back to finish their check");
  const A = L.answers || {}; delete A.ni;
  res.json({ ok: true, answers: A });
});
/* which step people reach, to see where they give up */
app.post("/api/events", express.text({ type: "*/*", limit: "2kb" }), async (req, res) => {
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const sid = clip(b.sid, 40), step = clip(b.step, 40);
    if (sid && step && rateOk(req, 300)) await pool.query("INSERT INTO funnel_events(sid,step,utm) VALUES($1,$2,$3)", [sid, step, clip(b.utm, 200) || null]);
  } catch { }
  res.sendStatus(204);
});

app.post("/api/leads", async (req, res) => {
  try {
    if (!rateOk(req, 10)) return res.status(429).json({ ok: false, error: "Too many submissions. Please call us instead." });
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // honeypot
    const f = mapAnswers(b);
    f.consent_text = clip(b.consent_text, 400); f.source = clip(b.source || "website", 60);
    if (!f.first_name || !f.last_name || !f.phone || !f.consent)
      return res.status(400).json({ ok: false, error: "Please fill in the name, a phone number, and tick the consent box." });
    const due = nextWorkingDay(today());
    const partial = b.token && /^[A-Za-z0-9_-]{20,60}$/.test(b.token) ? (await pool.query("SELECT id FROM leads WHERE partial_token=$1 AND partial", [b.token])).rows[0] : null;
    let id;
    const vals = leadCols.map(c => f[c] === undefined ? null : f[c]);
    if (partial) {
      id = partial.id;
      await pool.query(`UPDATE leads SET ${leadCols.map((c, i) => `${c}=$${i + 2}`).join(", ")}, partial=false, answers=$${leadCols.length + 2}, consent=true, consent_text=$${leadCols.length + 3}, next_action=$${leadCols.length + 4}, next_action_date=$${leadCols.length + 5}, created_at=now(), updated_at=now() WHERE id=$1`,
        [id, ...vals, JSON.stringify(b).slice(0, 20000), f.consent_text, "Call the client (" + (f.best_time || "any time") + ")", due]);
      await log(id, "created", "Check finished on the website");
    } else {
      const r = await pool.query(`INSERT INTO leads(source,consent,consent_text,next_action,next_action_date,answers,${leadCols.join(",")}) VALUES($1,$2,$3,$4,$5,$6,${leadCols.map((c, i) => "$" + (i + 7)).join(",")}) RETURNING id`,
        [f.source, f.consent, f.consent_text, "Call the client (" + (f.best_time || "any time") + ")", due, JSON.stringify(b).slice(0, 20000), ...vals]);
      id = r.rows[0].id;
      await log(id, "created", "Enquiry received from " + f.source + (f.consent ? ", consent to contact given" : ""));
    }
    const dtoken = tok();
    await pool.query("UPDATE leads SET detail_token=$2, ip=coalesce(ip,$3), user_agent=coalesce(user_agent,$4), referrer=coalesce(referrer,$5), utm=coalesce(utm,$6) WHERE id=$1", [id, dtoken, ipOfReq(req) || null, clip(req.headers["user-agent"], 300) || null, clip(b.ref_url, 300) || null, clip(b.utm, 300) || null]);
    if (f.for_whom === "help") await log(id, "check", `Check done by ${f.helper_name || "a helper"} (${f.helper_relation || "relationship not given"}) for ${f.first_name} ${f.last_name}. ${f.helper_ok ? "They confirmed the client knows and agrees." : "Client's agreement NOT confirmed: check on the call."} ${f.contact_name ? "We contact the helper; the client gave no number." : ""} The client must sign documents personally.`);
    if (f.for_whom === "died") { await log(id, "check", `Estate claim: ${f.first_name} ${f.last_name} has died${f.death_date ? " (" + f.death_date + ")" : ""}. Contact is ${f.helper_name} (${f.helper_relation || "relationship not given"}). Verify the personal representative before any paperwork.`); await pool.query("UPDATE leads SET next_action='Estate claim: call the contact, ask for the death certificate and grant, confirm who the personal representative is' WHERE id=$1", [id]); }
    if (f.upliftOnly || f.cb === "partner") await log(id, "check", "Child Benefit was paid to the partner, so no HRP on this record: check for married or widowed increases only.");
    if (f.ft === "throughout") await log(id, "check", "Says they worked full time throughout: HRP unlikely. Check the years on the call before going further.");
    if (f.pension === "full") await log(id, "check", "Already gets the full State Pension: missing HRP unlikely to change it. Look at uplifts.");
    if (f.ni_number && !validNi(f.ni_number)) await log(id, "check", "NI number given doesn't look valid: confirm it on the call.");
    await findDuplicate(id, { ...f, ip: ipOfReq(req) });
    const L = await getLeadRow(id);
    await MSG.queue(L, "welcome");
    sendEmail(f.email, `${BRAND}: we've received your State Pension check`,
      `Dear ${f.contact_name || ((f.title ? f.title + " " : "") + f.last_name)},\n\nThank you for completing our State Pension check. The reference is ${id}. One of our team will call within one working day${f.best_time ? " (" + f.best_time.toLowerCase() + ")" : ""} to go through the answers.\n\nThere is nothing to pay and no obligation. Receiving Child Benefit doesn't automatically mean anything is owed: we only make a claim if the HMRC and DWP records show one is supported. You can also apply to HMRC yourself for free.\n\nIf you have any questions, call us on ${PHONE}, weekdays 9am to 5pm.\n\n${BRAND}`)
      .then(ok => ok && log(id, "email", "Confirmation email sent"));
    sendEmail(NOTIFY_EMAIL, `New enquiry #${id}: ${f.first_name} ${f.last_name}`, `New enquiry from the website.\nBest time to call: ${f.best_time || "not given"}\nPhone: ${f.phone}\n\nOpen the CRM to view it.`);
    res.json({ ok: true, ref: id, dtoken });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: "Something went wrong. Please call us instead." }); }
});
/* optional second step on the website: the details HMRC and DWP need */
app.post("/api/leads/:ref/details", async (req, res) => {
  try {
    const b = req.body || {};
    const L = (await pool.query("SELECT * FROM leads WHERE id=$1 AND detail_token=$2", [parseInt(req.params.ref, 10) || 0, String(b.dtoken || "")])).rows[0];
    if (!L || !b.dtoken) return res.status(403).json({ ok: false });
    const dt = v => /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;
    const kids = (Array.isArray(b.children) ? b.children : []).slice(0, 7).map(c => ({ name: clip(c.name, 80), dob: dt(c.dob) || "", father: "" })).filter(c => c.name || c.dob).sort((a, c) => (a.dob || "9").localeCompare(c.dob || "9"));
    const ni = normNi(b.ni) || L.ni_number;
    const pc = clip(b.postcode, 10).toUpperCase() || null;
    await pool.query(`UPDATE leads SET dob=coalesce($2,dob), hmrc_name=coalesce(nullif($3,''),hmrc_name), ni_number=$4, postcode=coalesce($5,postcode), address=coalesce(nullif($6,''),address), years_at_address=$7, prev_address=coalesce(nullif($8,''),prev_address),
      prev_names=coalesce(nullif($9,''),prev_names), children=coalesce($10,children), partner_name=coalesce(nullif($11,''),partner_name), partner_dob=$12, marriage_date=coalesce($13,marriage_date), partner_death_date=coalesce($14,partner_death_date), partner_unknown=coalesce(nullif($15,''),partner_unknown), partner_ni=coalesce($17,partner_ni),
      details_done_at=now(), next_action=$16, next_action_date=current_date, updated_at=now() WHERE id=$1`,
      [L.id, dt(b.dob), clip(b.hmrc_name, 120), ni, pc, clip(b.address, 300), clip(b.years_at_address, 10) || null, clip(b.prev_address, 300), clip(b.prev_names, 200), kids.length ? JSON.stringify(kids) : null, clip(b.partner_name, 120), dt(b.partner_dob), dt(b.marriage_date), dt(b.partner_death_date), clip(b.partner_unknown, 300), "Details completed online: confirm them on the call, then send the pack", normNi(b.partner_ni) || null]);
    const after = await getLeadRow(L.id);
    const V = validation(after, null).filter(v => v.key !== "signature" && v.key !== "hmrc" && v.st !== "ok");
    await log(L.id, "case", `Client completed their details online${V.length ? ". Still to check: " + V.map(v => v.label + " (" + v.msg + ")").join("; ") : ". All checks passed"}`);
    if (b.years_at_address === "lt4" && !clip(b.prev_address, 300)) await log(L.id, "check", "At current address under 4 years but no previous address given");
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});

/* public: client progress check */
const statusTries = new Map();
function statusPage(inner) {
  return page("Check your claim", `<div style="max-width:620px;margin:24px auto;display:grid;gap:16px">
  <div><strong style="font-size:1.1rem">${esc(BRAND)}</strong><h1 style="margin-top:6px">Check how your claim is going</h1></div>${inner}
  <p class="muted">Questions? Call us on ${esc(PHONE)}, weekdays 9am to 5pm.</p></div>`, { bare: true });
}
const statusForm = (err, v = {}) => `<form class="panel" method="post" action="/status" autocomplete="off">
  ${err ? `<p class="pill bad" role="alert">${esc(err)}</p>` : `<p class="muted">For your security, enter your reference number and the details below exactly as you gave them to us.</p>`}
  <label>Reference number <input name="ref" inputmode="numeric" value="${esc(v.ref || "")}" required></label>
  <label>Surname <input name="surname" value="${esc(v.surname || "")}" required></label>
  <label>Last 4 digits of your phone number <input name="last4" inputmode="numeric" maxlength="4" pattern="\\d{4}" required></label>
  <button style="font-size:1.05rem;padding:12px 18px">Show my progress</button></form>`;
app.get("/status", (req, res) => res.send(statusPage(statusForm())));
app.post("/status", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const t = (statusTries.get(ip) || []).filter(x => Date.now() - x < 15 * 60e3);
  if (t.length >= 6) return res.status(429).send(statusPage(statusForm("Too many attempts. Please wait 15 minutes or call us.")));
  t.push(Date.now()); statusTries.set(ip, t);
  const ref = parseInt(String(req.body.ref || "").replace(/\D/g, ""), 10);
  const surname = clip(req.body.surname, 80).toLowerCase();
  const last4 = String(req.body.last4 || "").replace(/\D/g, "");
  const L = ref ? (await pool.query("SELECT * FROM leads WHERE id=$1", [ref])).rows[0] : null;
  const ok = L && (L.last_name || "").trim().toLowerCase() === surname && last4.length === 4 && (L.phone || "").replace(/\D/g, "").endsWith(last4);
  if (!ok) return res.send(statusPage(statusForm("We couldn't find a claim matching those details. Please check them and try again, or call us.", { ref: req.body.ref, surname: req.body.surname })));
  await log(L.id, "status", "Client checked their progress online");
  const exp = Date.now() + 2 * 3600e3; res.set("Set-Cookie", `cs=${L.id}.${exp}.${crypto.createHmac("sha256", SESSION_SECRET).update("client:" + L.id + "." + exp).digest("hex")}; HttpOnly; Secure; SameSite=Lax; Path=/status; Max-Age=7200`);
  const [step, text] = CLIENT_STAGE[L.stage] || [0, ""];
  const closed = L.stage.startsWith("closed");
  res.send(statusPage(`<div class="panel">
    <p class="muted">Reference ${L.id} · ${esc(L.title)} ${esc(L.last_name)}</p>
    <ol style="list-style:none;padding:0;margin:0;display:grid;gap:10px">
    ${CLIENT_STEPS.map((s, i) => `<li style="display:flex;gap:12px;align-items:center"><span style="flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:700;${i < step || (i === step && step === 5) ? "background:var(--good);color:#fff" : i === step ? "background:var(--accent);color:var(--accent-ink)" : "background:var(--tint);color:var(--muted)"}">${i < step || (i === step && step === 5) ? "✓" : i + 1}</span><span style="${i === step ? "font-weight:700" : i > step ? "color:var(--muted)" : ""}">${esc(closed && i === 5 ? "Closed" : s)}</span></li>`).join("")}
    </ol></div>
    <div class="panel"><h2>Latest update</h2><p style="font-size:1.05rem">${esc(L.client_message || text)}</p>
    <p class="muted">Last updated ${fmtDate(iso(L.client_message_at || L.updated_at))}</p></div>
    ${["invoiced", "payment_plan", "fee_review"].includes(L.stage) && L.pay_token ? `<a class="btn" href="/pay/${L.pay_token}" style="font-size:1.1rem;padding:14px 18px;text-align:center">Pay your invoice</a>` : ""}
    <div class="panel"><h2>Send us a document</h2><p>Had a letter from DWP or HMRC? Take a clear photo and send it here. It's the quickest way to move your claim on.</p>
      <form id="cup" style="display:grid;gap:10px"><label>What is it? <select id="ckind"><option value="arrears">DWP letter about my pension arrears</option><option value="dwp">Another DWP letter</option><option value="soa">My National Insurance record</option><option value="id">Photo ID or proof of address</option><option value="hmrc">A letter from HMRC</option><option value="other">Something else</option></select></label>
      <label>Photo or file <input type="file" id="cfile" accept="image/*,.pdf" capture="environment"></label><button style="font-size:1.05rem;padding:12px 18px">Send</button><p id="cmsg" class="muted" role="status"></p></form>
      <script>document.getElementById("cup").addEventListener("submit",function(e){e.preventDefault();var f=document.getElementById("cfile").files[0],m=document.getElementById("cmsg");if(!f){m.textContent="Choose a photo or file first.";return;}if(f.size>10*1024*1024){m.textContent="That file is too big. Please send a smaller photo, or call us.";return;}m.textContent="Sending…";var r=new FileReader();r.onload=function(){fetch("/status/upload",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({kind:document.getElementById("ckind").value,name:f.name,mime:f.type,data:String(r.result).split(",")[1]})}).then(function(x){return x.json();}).then(function(j){m.textContent=j.ok?"Thank you, we've received it. We'll be in touch if we need anything else.":(j.error||"Sorry, that didn't work. Please call us.");if(j.ok)document.getElementById("cfile").value="";}).catch(function(){m.textContent="Sorry, that didn't work. Please call us.";});};r.readAsDataURL(f);});</script>
      <p class="muted"><a href="/ni-record">How to get your National Insurance record (optional)</a></p></div>
    <a class="btn ghost" href="/status">Check another claim</a>`));
});

/* public: payments, messages from clients, NI record guide */
PAY.publicRoutes(app);
MSG.publicRoutes(app);
app.get("/ni-record", (req, res) => res.send(page("Your National Insurance record", `<div style="max-width:680px;margin:24px auto;display:grid;gap:16px;font-size:18px">
  <div><strong style="font-size:1.1rem">${esc(BRAND)}</strong><h1 style="margin-top:6px">Sharing your National Insurance record (optional)</h1></div>
  <div class="panel"><p>If you already use GOV.UK online, you can look at your National Insurance record yourself and send us a picture of it. It can save weeks, because we won't need to write to HMRC for it. <b>This is optional.</b> If you'd rather not, we'll ask HMRC for you.</p>
  <p><b>We will never ask for your password or sign-in details.</b> Don't share them with anyone.</p></div>
  <div class="panel"><h2>How to do it</h2><ol style="display:grid;gap:10px;padding-left:22px">
    <li>Go to <b>gov.uk/check-national-insurance-record</b> and choose <b>Start now</b>.</li>
    <li>Sign in, or create your sign-in details. You may be asked to prove your identity, usually with photo ID such as a passport or driving licence.</li>
    <li>Find the years between <b>1978 and 2010</b>. Look for years shown as gaps or "not a full year".</li>
    <li>Take a screenshot or a photo of those years. Make sure the years and the words next to them are readable.</li>
    <li>Send it to us: go to <a href="/status">Check your claim</a>, enter your details and use "Send us a document". You can also send it by WhatsApp to the number we message you from.</li></ol></div>
  <div class="panel"><p>Can't get online or stuck? That's fine. Call us on ${esc(PHONE)}, weekdays 9am to 5pm, and we'll take care of it.</p></div></div>`, { bare: true })));

/* public: e-signing */
ES.publicRoutes(app);

app.post("/status/upload", express.json({ limit: "15mb" }), async (req, res) => {
  const c = Object.fromEntries((req.headers.cookie || "").split(";").map(p => p.trim().split("=")).filter(p => p[0]));
  const [id, exp, mac] = String(c.cs || "").split(".");
  const good = id && Number(exp) > Date.now() && mac === crypto.createHmac("sha256", SESSION_SECRET).update("client:" + id + "." + exp).digest("hex");
  if (!good) return res.status(401).json({ ok: false, error: "Your session has ended. Please enter your details again." });
  const b = req.body || {}, data = String(b.data || "");
  const kinds = { arrears: "arrears", dwp: "dwp", soa: "soa", id: "id", hmrc: "other", other: "other" }, kind = kinds[b.kind] || "other";
  if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 10) return res.status(400).json({ ok: false, error: "That file couldn't be read. Please try a photo instead." });
  const size = Math.floor(data.length * 3 / 4); if (size > 10 * 1024 * 1024) return res.status(400).json({ ok: false, error: "That file is too big." });
  const name = "client-" + (clip(b.name, 120).replace(/[^\w .()-]/g, "_") || "upload");
  await pool.query("INSERT INTO files(lead_id,kind,name,mime,size,data) VALUES($1,$2,$3,$4,$5,decode($6,'base64'))", [Number(id), kind, name, clip(b.mime, 80) || "application/octet-stream", size, data]);
  await log(Number(id), "file", `Client uploaded ${FILE_KINDS[kind]}${b.kind === "hmrc" ? " (HMRC letter)" : ""}: ${name}`);
  const next = kind === "arrears" ? "Client sent their DWP arrears letter: check it against the case, enter the arrears and invoice" : kind === "soa" ? "Client sent their NI record: record HRP for each tax year" : kind === "id" ? "Client sent ID documents: check them and update the ID check" : "Client sent a document: check it";
  await pool.query("UPDATE leads SET next_action=$2, next_action_date=current_date, updated_at=now() WHERE id=$1", [Number(id), next]);
  res.json({ ok: true });
});

/* public: clients book a call back */
function slots() {
  const out = []; let d = today();
  while (out.length < 5) { d = nextWorkingDay(d); out.push(d); }
  return out.map(day => ({ day, times: ["09:30", "11:00", "12:30", "14:00", "15:30", "16:30"] }));
}
app.get("/book/:token", async (req, res) => {
  const L = /^[A-Za-z0-9_-]{20,60}$/.test(req.params.token) ? (await pool.query("SELECT * FROM leads WHERE book_token=$1", [req.params.token])).rows[0] : null;
  const shell = inner => page("Book a call", `<div style="max-width:620px;margin:24px auto;display:grid;gap:16px;font-size:18px"><div><strong style="font-size:1.1rem">${esc(BRAND)}</strong><h1 style="margin-top:6px">Pick a time for us to call</h1></div>${inner}<p class="muted">Or call us on ${esc(PHONE)}, weekdays 9am to 5pm.</p></div>`, { bare: true });
  if (!L) return res.status(404).send(shell(`<div class="panel"><p>This link isn't working. Please call us and we'll help.</p></div>`));
  if (req.query.done) return res.send(shell(`<div class="panel" style="border-color:var(--good)"><p><b>Thank you.</b> We'll call ${esc(L.phone)} on ${esc(new Date(L.booked_at).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }))}.</p></div>`));
  res.send(shell(`<form method="post" class="panel" style="display:grid;gap:14px"><p>We'll call <b>${esc(L.phone)}</b>. Choose a day and time (UK time):</p>
    ${slots().map(s => `<fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:700;margin-bottom:6px">${esc(fmtDate(s.day))} (${new Date(s.day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long" })})</legend><div style="display:flex;gap:8px;flex-wrap:wrap">${s.times.map(t => `<label style="display:flex;gap:6px;align-items:center;border:2px solid var(--line);border-radius:10px;padding:10px 14px;font-weight:600"><input type="radio" name="slot" value="${s.day}T${t}" required> ${t}</label>`).join("")}</div></fieldset>`).join("")}
    <label>A different number to call? <span class="muted">(optional)</span><input name="alt" type="tel"></label><button style="font-size:1.1rem;padding:14px">Book my call</button></form>`));
});
app.post("/book/:token", async (req, res) => {
  const L = /^[A-Za-z0-9_-]{20,60}$/.test(req.params.token) ? (await pool.query("SELECT * FROM leads WHERE book_token=$1", [req.params.token])).rows[0] : null;
  const slot = String(req.body.slot || "");
  if (!L || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot)) return res.redirect("/book/" + req.params.token);
  /* slots are UK time: convert with the UK offset on that date */
  const guess = new Date(slot + ":00Z"), ukHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(guess));
  const at = new Date(guess.getTime() - (ukHour - guess.getUTCHours()) * 3600e3);
  const alt = clip(req.body.alt, 30);
  await pool.query("UPDATE leads SET booked_at=$2, next_action=$3, next_action_date=$4, updated_at=now() WHERE id=$1", [L.id, at.toISOString(), `Booked call at ${slot.slice(11)} UK time${alt ? " on " + alt : ""}`, slot.slice(0, 10)]);
  await log(L.id, "call", `Client booked a call for ${slot.replace("T", " ")} UK time${alt ? ", on " + alt : ""}`);
  await MSG.queue({ ...(await getLeadRow(L.id)) }, "booked_" + slot, { body: MSG.T.booked({ ...(await getLeadRow(L.id)) }) });
  res.redirect("/book/" + req.params.token + "?done=1");
});

/* login */
app.use("/login", (req, res, next) => ipGate(req, res, next));
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

app.use((req, res, next) => ipGate(req, res, next));
app.use(requireAuth);
app.use(sameOrigin);
ES.staffRoutes(app);
PAY.staffRoutes(app);
MSG.staffRoutes(app);

/* pipeline board */
app.get("/", async (req, res) => {
  const q = clip(req.query.q, 80);
  const params = q ? ["%" + q + "%"] : [];
  const where = q ? "AND (first_name ILIKE $1 OR last_name ILIKE $1 OR maiden_name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1)" : "";
  const { rows } = await pool.query(`SELECT * FROM leads WHERE stage <> ALL(${DONE_SQL}) ${where} ORDER BY next_action_date NULLS LAST, created_at`, params);
  const stats = (await pool.query(`SELECT
     count(*) FILTER (WHERE created_at > now() - interval '7 days') AS week,
     count(*) FILTER (WHERE stage = 'new') AS new,
     count(*) FILTER (WHERE next_action_date <= current_date AND stage <> ALL(${DONE_SQL})) AS due,
     count(*) FILTER (WHERE stage = 'submitted') AS hmrc,
     count(*) FILTER (WHERE stage = 'signed' AND kyc <> 'passed') AS idwait,
     coalesce(sum(fee + vat) FILTER (WHERE stage IN ('invoiced','payment_plan')),0) AS owed
     FROM leads`)).rows[0];
  const cols = OPEN_STAGES.map(s => {
    const items = rows.filter(r => r.stage === s.id);
    return `<section class="col"><small class="muted" style="font-weight:700">${esc(s.group)}</small><h2>${esc(s.label)} <span>${items.length}</span></h2>${items.map(r => `<a class="card" href="/lead/${r.id}">
      <b>${esc(r.title)} ${esc(r.first_name)} ${esc(r.last_name)}</b>${flags(r) ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin:4px 0">${flags(r)}</div>` : ""}
      <small>${r.born ? "Born " + r.born + " · " : ""}${esc(label("pension", r.pension))}${r.for_whom && r.for_whom !== "me" ? " · " + esc(label("for_whom", r.for_whom)) : ""}</small>
      ${dueBadge(r.next_action_date)}</a>`).join("") || `<small class="muted">None</small>`}</section>`;
  }).join("");
  res.send(page("Pipeline", `
  <div class="stats">
    <div class="stat"><b>${stats.new}</b><small>New, not yet called</small></div>
    <div class="stat"><b>${stats.due}</b><small>Actions due or overdue</small></div>
    <div class="stat"><b>${stats.week}</b><small>Enquiries in last 7 days</small></div>
    <div class="stat"><b>${stats.idwait}</b><small>Signed, ID check not passed</small></div>
    <div class="stat"><b>${stats.hmrc}</b><small>CF411 claims with HMRC</small></div>
    <div class="stat"><b>${gbp(stats.owed)}</b><small>Invoiced, not yet paid</small></div>
  </div>
  <form class="inline" method="get" action="/"><label>Search <input name="q" value="${esc(q)}" placeholder="Name, phone or email"></label><button class="btn ghost">Search</button>${q ? `<a class="btn ghost" href="/">Clear</a>` : ""}</form>
  <div class="board">${cols}</div>`, { nav: "board" }));
});

/* today */
app.get("/today", async (req, res) => {
  await loadRates();
  let { rows } = await pool.query(`SELECT * FROM leads WHERE next_action_date <= current_date AND stage <> ALL(${DONE_SQL}) ORDER BY next_action_date, created_at`);
  const sortV = req.query.sort !== "due";
  rows = rows.map(r => ({ ...r, est: estimate(r) }));
  if (sortV) rows.sort((a, b) => ((b.est && b.est.amount) || 0) - ((a.est && a.est.amount) || 0) || String(iso(a.next_action_date)).localeCompare(iso(b.next_action_date)));
  res.send(page("Today", `<h1>Due today and overdue (${rows.length})</h1>
  <p class="muted">${sortV ? `Sorted by estimated value, highest first, so the biggest claims move fastest. <a href="/today?sort=due">Sort by due date</a>` : `Sorted by due date. <a href="/today">Sort by estimated value</a>`}</p>
  <div class="panel tablewrap"><table><thead><tr><th>Due</th><th>Client</th><th>Est. value</th><th>Stage</th><th>Action</th><th>Phone</th><th>Best time</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td>${dueBadge(r.next_action_date)}</td><td><a href="/lead/${r.id}">${esc(r.first_name)} ${esc(r.last_name)}</a>${r.vulnerable ? ` <span class="pill bad">Vulnerable</span>` : ""}</td><td class="num">${r.est ? gbp(r.est.amount).replace(/\.00$/, "") + (r.est.confirmed ? "" : "*") : ""}</td><td>${esc(STAGE[r.stage]?.label)}</td><td>${esc(r.next_action)}</td><td class="num">${esc(r.phone)}</td><td>${esc(r.best_time)}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">Nothing due. New enquiries will appear here on the next working day.</td></tr>`}
  </tbody></table></div>
  ${await (async () => { const st = await stuckCases(); return `<div class="panel tablewrap"><h2>Stuck cases <span class="pill ${st.length ? "bad" : "good"}">${st.length}</span></h2><p class="muted" style="margin:0">Open cases with no activity for longer than their stage normally takes (intake 3 days, documents 7, HMRC and DWP 35, review 7, CF411 10, outcome and fees 21).</p>
    <table><tbody>${st.slice(0, 50).map(r => `<tr><td><a href="/lead/${r.id}">${esc(r.first_name)} ${esc(r.last_name)}</a></td><td>${esc(STAGE[r.stage]?.label)}</td><td class="num"><span class="due over">${r.days} days quiet</span></td><td class="muted">${esc(r.next_action || "No next action set")}</td></tr>`).join("") || `<tr><td class="muted">Nothing stuck.</td></tr>`}</tbody></table></div>`; })()}
  <p class="muted">Estimates are an "up to" figure for ranking only: they assume every missing year counts in full. Real arrears are usually lower (DWP's average is £8,377). * means the missing years aren't confirmed from HMRC's record yet.</p>`, { nav: "today" }));
});

/* fees */
app.get("/money", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE stage IN ('decision','invoiced','payment_plan','paid') ORDER BY invoice_due NULLS FIRST`);
  const t = rows.reduce((a, r) => { const tot = Number(r.fee || 0) + Number(r.vat || 0); if (r.stage === "paid") a.paid += tot; else if (r.stage === "invoiced" || r.stage === "payment_plan") a.owed += tot; a.arrears += Number(r.arrears || 0) - Number(r.deductions || 0); return a; }, { paid: 0, owed: 0, arrears: 0 });
  res.send(page("Fees", `${req.query.ok ? `<div class="flash">${esc(req.query.ok)}</div>` : ""}<div class="stats">
  <div class="stat"><b>${gbp(t.arrears)}</b><small>Arrears paid to clients</small></div>
  <div class="stat"><b>${gbp(t.owed)}</b><small>Invoiced, unpaid (inc. VAT)</small></div>
  <div class="stat"><b>${gbp(t.paid)}</b><small>Fees received (inc. VAT)</small></div></div>
  <p class="muted">Invoices go out only once DWP has confirmed the arrears, and are due ${PAY_DAYS} days from the invoice date. Up to three reminders, then offer a payment plan.</p>
  <div class="panel tablewrap"><table><thead><tr><th>Client</th><th>Stage</th><th>Paid to client</th><th>Fee + VAT</th><th>Invoiced</th><th>Due</th><th>Reminders</th><th>Paid</th></tr></thead><tbody>
  ${rows.map(r => { const over = r.stage === "invoiced" && r.invoice_due && iso(r.invoice_due) < today(); return `<tr><td><a href="/lead/${r.id}">${esc(r.first_name)} ${esc(r.last_name)}</a></td><td>${esc(STAGE[r.stage]?.label)}</td><td class="num">${r.arrears != null ? gbp(Number(r.arrears) - Number(r.deductions || 0)) : ""}</td><td class="num">${r.fee != null ? gbp(Number(r.fee) + Number(r.vat)) : ""}</td><td>${fmtDate(iso(r.invoice_date))}</td><td>${r.stage === "invoiced" ? dueBadge(r.invoice_due) : fmtDate(iso(r.invoice_due))}</td>
  <td>${r.reminders ? `${r.reminders} sent${r.last_reminder ? `<br><small class="muted">last ${fmtDate(iso(r.last_reminder))}</small>` : ""}` : ""}${over && r.reminders < 3 ? `<form method="post" action="/lead/${r.id}/reminder"><input type="hidden" name="back" value="money"><button class="btn ghost" style="padding:4px 10px">Log reminder ${r.reminders + 1}</button></form>` : ""}</td>
  <td>${fmtDate(iso(r.paid_at))}</td></tr>`; }).join("") || `<tr><td colspan="8" class="muted">No outcomes yet.</td></tr>`}
  </tbody></table></div>`, { nav: "money" }));
});

/* closed */
app.get("/closed", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE stage = ANY(${DONE_SQL}) ORDER BY updated_at DESC LIMIT 500`);
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
<label>NI number (if known) <input name="ni_number" autocapitalize="characters"></label>
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
  const id = r.rows[0].id, ni = normNi(b.ni_number) || null;
  if (ni) await pool.query("UPDATE leads SET ni_number=$2 WHERE id=$1", [id, ni]);
  await log(id, "created", "Enquiry added by phone");
  await findDuplicate(id, { email: clip(b.email, 160), phone: clip(b.phone, 30), ni_number: ni, first_name: clip(b.first_name, 80), last_name: clip(b.last_name, 80), born: parseInt(b.born, 10) || null });
  res.redirect("/lead/" + r.rows[0].id);
});

/* lead record */
async function getLead(id) { const r = await pool.query("SELECT * FROM leads WHERE id=$1", [id]); return r.rows[0]; }
const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
app.get("/lead/:id", async (req, res) => {
  const L = await getLead(req.params.id); if (!L) return res.status(404).send(page("Not found", "<p>No such client.</p>"));
  const acts = (await pool.query("SELECT * FROM activity WHERE lead_id=$1 ORDER BY at DESC", [L.id])).rows;
  const esignPanel = await ES.leadPanel(L);
  await loadRates(); const EST = estimate(L), RISK = riskOf(L);
  const signedPack = (await pool.query("SELECT signer_name FROM sign_requests WHERE lead_id=$1 AND kind='pack' AND status='signed' ORDER BY id DESC LIMIT 1", [L.id])).rows[0];
  const V = validation(L, signedPack ? signedPack.signer_name : null);
  const files = (await pool.query("SELECT id, kind, name, size, at FROM files WHERE lead_id=$1 ORDER BY at DESC", [L.id])).rows;
  const cr = cbRange(L), hm = hrpMap(L), audit = hrpAudit(L), ftSet = new Set(parseYears(L.ft_years));
  const ks = kids(L); while (ks.length < 7) ks.push({});
  const types = new Set(String(L.claim_types || "").split(",").filter(Boolean));
  const stIcon = st => st === "ok" ? `<span class="pill good">Pass</span>` : st === "bad" ? `<span class="pill bad">Fail</span>` : `<span class="pill">Missing</span>`;
  const fee = L.fee != null ? Number(L.fee) : null, vat = L.vat != null ? Number(L.vat) : null;
  const net = L.arrears != null ? Number(L.arrears) - Number(L.deductions || 0) : null;
  const coolingEnds = L.signed_at ? addDays(iso(L.signed_at), 14) : null;
  const inCooling = coolingEnds && today() <= coolingEnds;
  const reqYears = requestYears(L), ftList = parseYears(L.ft_years);
  const groups = [...new Set(STAGES.map(s => s.group))];
  res.send(page(`${L.first_name} ${L.last_name}`, `
  ${req.query.ok ? `<div class="flash">Saved.</div>` : ""}
  ${req.query.err ? `<div class="flash" style="background:var(--bad-tint);color:var(--bad)">${esc(req.query.err)}</div>` : ""}
  <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
    <div><h1>${esc(L.title)} ${esc(L.first_name)} ${esc(L.last_name)}</h1><span class="muted">Ref ${L.id} · received ${fmtDate(iso(L.created_at))} · via ${esc(L.source)}</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><span class="pill ${RISK.level === "high" ? "bad" : RISK.level === "medium" ? "" : "good"}" title="${esc(RISK.reasons.join("; "))}">Risk: ${RISK.level}${RISK.reasons.length ? ` (${esc(RISK.reasons.join("; "))})` : ""}</span>${RISK.level !== "low" ? `<span class="pill ${L.edd_approved_by ? "good" : "bad"}">${L.edd_approved_by ? "Enhanced checks approved by " + esc(L.edd_approved_by) : "Enhanced checks need approval"}</span>` : ""}
      ${EST ? `<span class="pill" title="Rough estimate">Arrears up to about ${gbp(EST.amount).replace(/\.00$/, "")}${EST.confirmed ? "" : " (years not yet confirmed)"}</span>` : ""}</div></div>
    <span>${L.is_test ? `<span class="pill bad">Test data</span> ` : ""}${L.dup_of ? `<a class="pill bad" href="/lead/${L.dup_of}">Possible duplicate of ref ${L.dup_of}</a> ` : ""}<span class="pill">${esc(STAGE[L.stage]?.group)}: ${esc(STAGE[L.stage]?.label)}</span></span>
  </div>
  <form class="panel" method="post" action="/lead/${L.id}/header" style="display:flex;gap:14px;flex-wrap:wrap;align-items:end;padding:12px 16px${L.vulnerable ? ";border-color:var(--bad)" : ""}">
    <label>Owner <input name="owner" value="${esc(L.owner)}" placeholder="Agent name" size="14"></label>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="vulnerable" value="1" ${L.vulnerable ? "checked" : ""}> Vulnerable client</label>
    <label style="flex:1 1 260px">Vulnerability notes and adjustments <input name="vulnerable_note" value="${esc(L.vulnerable_note)}" placeholder="e.g. hard of hearing: post everything, call daughter first" style="width:100%"></label>
    <button class="btn ghost">Save</button></form>
  <div class="grid2">
    <div style="display:grid;gap:18px">
      ${["new", "contacted", "qualified", "pack_sent"].includes(L.stage) ? `<form class="panel" method="post" action="/lead/${L.id}/call">
        <h2>Log a call <span class="pill">${L.call_attempts || 0} tried</span>${L.booked_at ? ` <span class="pill good">Booked: ${esc(new Date(L.booked_at).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</span>` : ""}</h2>
        <p class="muted" style="margin:0">Call ${esc(L.contact_name ? L.contact_name + " (" + (L.helper_relation || "helper") + ")" : "the client")} on <b class="num">${esc(L.phone)}</b>${L.mobile ? ` or mobile <b class="num">${esc(L.mobile)}</b>` : ""}${L.helper_phone && L.helper_phone !== L.phone ? `, helper ${esc(L.helper_name)} on <b class="num">${esc(L.helper_phone)}</b>` : ""}. Best time: ${esc(L.best_time || "any")}.</p>
        <input name="note" placeholder="Note (optional)" style="width:100%">
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button name="outcome" value="spoke">Spoke to them</button><button class="btn ghost" name="outcome" value="no_answer">No answer</button><button class="btn ghost" name="outcome" value="voicemail">Left voicemail</button><button class="btn ghost" name="outcome" value="wrong_number">Wrong number</button></div>
        <small class="muted">No answer sets the next try automatically (6 tries over about 10 working days at different times), and texts a "book a call" link after the 2nd and 4th tries.</small></form>` : ""}
      <form class="panel" method="post" action="/lead/${L.id}/stage">
        <h2>Move to stage</h2>
        <div class="inline" style="display:flex;gap:8px;flex-wrap:wrap"><select name="stage">${groups.map(g => `<optgroup label="${esc(g)}">${STAGES.filter(s => s.group === g).map(s => `<option value="${s.id}" ${s.id === L.stage ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</optgroup>`).join("")}</select>
        <button>Update stage</button></div>
        <small class="muted">Moving stage sets a suggested next action and date. Records and claim stages need a passed ID check; invoicing needs the DWP arrears letter.</small>
      </form>
      <form class="panel" method="post" action="/lead/${L.id}/next">
        <h2>Next action</h2>${dueBadge(L.next_action_date)}
        <label>What <input name="next_action" value="${esc(L.next_action)}" style="width:100%"></label>
        <label>When <input type="date" name="next_action_date" value="${iso(L.next_action_date)}"></label>
        <button>Save next action</button>
      </form>
      <form class="panel" method="post" action="/lead/${L.id}/client-message">
        <h2>Update for the client</h2>
        <p class="muted">Shown when the client checks their progress online. Leave blank to use the standard message for their stage: "${esc((CLIENT_STAGE[L.stage] || [0, ""])[1])}"</p>
        <textarea name="client_message" placeholder="For example: HMRC has confirmed they're reviewing your claim.">${esc(L.client_message)}</textarea>
        <button>Save client update</button>
      </form>
      <form class="panel" method="post" action="/lead/${L.id}/note">
        <h2>Add a note</h2>
        <select name="kind"><option value="call">Call</option><option value="note">Note</option><option value="email">Email or letter</option><option value="hmrc">HMRC contact</option><option value="dwp">DWP contact</option><option value="complaint">Complaint</option><option value="data">Data request</option></select>
        <textarea name="text" required placeholder="What happened, what was agreed"></textarea>
        <button>Add note</button>
      </form>
      <div class="panel"><h2>History</h2><div class="log">${acts.map(a => `<div><small>${new Date(a.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · ${esc(a.kind)}</small><br>${esc(a.text)}</div>`).join("")}</div></div>
    </div>
    <div style="display:grid;gap:18px">
      <div class="panel"><h2>Checks at sign-up</h2>
        <p class="muted" style="margin:0">Wrong details at sign-up cause rejected forms later. Fix anything marked Fail or Missing before sending the pack.</p>
        <table><tbody>${V.map(v => `<tr><td>${esc(v.label)}</td><td>${stIcon(v.st)}</td><td class="muted">${esc(v.msg)}</td></tr>`).join("")}</tbody></table>
        <form method="post" action="/lead/${L.id}/verify-hmrc" style="margin:0"><label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="v" value="1" ${L.hmrc_verified ? "checked" : ""} onchange="this.form.submit()"> Name, date of birth, NI number and address match what HMRC holds</label></form></div>
      ${esignPanel}
      ${await MSG.leadPanel(L)}
      ${await PAY.leadPanel(L)}
      ${await qaPanel(L)}
      <div class="panel"><h2>Contact</h2><dl>
        <dt>Phone</dt><dd class="num">${esc(L.phone)}</dd><dt>Email</dt><dd>${esc(L.email)}</dd>
        <dt>Best time</dt><dd>${esc(L.best_time)}</dd><dt>Maiden name</dt><dd>${esc(L.maiden_name)}</dd>
        <dt>Consent</dt><dd>${L.consent ? "Yes" : "No"}${L.consent_text ? `<br><small class="muted">${esc(L.consent_text)}</small>` : ""}</dd>
        ${L.ip || L.referrer || L.utm ? `<dt>Source</dt><dd><small>${L.ip ? `IP ${esc(L.ip)}` : ""}${L.utm ? `<br>${esc(L.utm)}` : ""}${L.referrer ? `<br>From ${esc(L.referrer)}` : ""}${L.user_agent ? `<br><span class="muted">${esc(L.user_agent.slice(0, 90))}</span>` : ""}</small></dd>` : ""}</dl>
        <form method="post" action="/lead/${L.id}/contact-flags" style="display:flex;gap:14px;flex-wrap:wrap;margin:0">
          <label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" name="email_bad" value="1" ${L.email_bad ? "checked" : ""}> Email bouncing</label>
          <label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" name="phone_bad" value="1" ${L.phone_bad ? "checked" : ""}> Phone or texts not working</label>
          <button class="btn ghost" style="padding:4px 10px">Save</button></form></div>
      <form class="panel" method="post" action="/lead/${L.id}/details">
        <h2>Client details</h2>
        <div class="grid2">
          <label>Name as HMRC holds it <input name="hmrc_name" value="${esc(L.hmrc_name)}" placeholder="e.g. Margaret Ann Lee"></label>
          <label>Previous names (up to 3) <input name="prev_names" value="${esc(L.prev_names)}" placeholder="e.g. Price; Doyle"></label>
          <label>Previous address <input name="prev_address" value="${esc(L.prev_address)}"></label>
          <label>Born in the UK <select name="born_uk"><option value=""></option>${opt({ yes: "Yes", no: "No" }, L.born_uk)}</select></label>
          <label>Time living outside the UK <input name="outside_uk" value="${esc(L.outside_uk)}" placeholder="e.g. Australia 1975 to 1979"></label>
          <label>Anyone else claim Child Benefit for these children? <input name="other_cb" value="${esc(L.other_cb)}"></label>
          <label>Working while caring <input name="working_caring" value="${esc(L.working_caring)}" placeholder="e.g. part time 1985 to 1990"></label>
          <label>State Pension started (year) <input name="sp_start_year" inputmode="numeric" value="${L.sp_start_year ?? ""}"></label>
        </div>
        <h3 style="font-size:1rem">Children (up to 7)</h3>
        <div class="tablewrap"><table><thead><tr><th>Name</th><th>Date of birth</th><th>Father's name</th></tr></thead><tbody>
        ${ks.slice(0, 7).map((c, i) => `<tr><td><input name="c${i}_name" value="${esc(c.name)}" style="width:100%"></td><td><input type="date" name="c${i}_dob" value="${esc(c.dob)}"></td><td><input name="c${i}_father" value="${esc(c.father)}" style="width:100%"></td></tr>`).join("")}
        </tbody></table></div>
        <h3 style="font-size:1rem">Husband, wife or civil partner (for uplift claims)</h3>
        <div class="grid2">
          <label>Date of marriage or civil partnership <input type="date" name="marriage_date" value="${iso(L.marriage_date)}"></label>
          <label>Partner's date of death (if widowed) <input type="date" name="partner_death_date" value="${iso(L.partner_death_date)}"></label>
          <label>Partner self-employed 2015 to 2024? <select name="partner_self_employed"><option value=""></option>${opt({ yes: "Yes", no: "No", unsure: "Not sure" }, L.partner_self_employed)}</select></label>
        </div>
        <h3 style="font-size:1rem">Claim types</h3>
        <div style="display:flex;gap:12px;flex-wrap:wrap">${Object.entries(CLAIM_TYPES).map(([k, v]) => `<label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" name="ct_${k}" value="1" ${types.has(k) ? "checked" : ""}> ${esc(v)}</label>`).join("")}</div>
        <button>Save client details</button>
      </form>
      <form class="panel" method="post" action="/lead/${L.id}/hrp" id="hrpform">
        <h2>HRP by tax year</h2>
        <p class="muted" style="margin:0">Record what HMRC's NI statement shows for each year. Tap a year to cycle: not checked → HRP present → HRP missing → NI paid. ${cr ? `Child Benefit years: ${esc(yearRanges(Array.from({ length: Math.max(0, Math.min(2009, cr[1]) - Math.max(1978, cr[0]) + 1) }, (_, i) => Math.max(1978, cr[0]) + i)))}.` : "Add children's dates of birth to highlight the Child Benefit years."}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:6px" id="hrpchips">
        ${Array.from({ length: 32 }, (_, i) => 1978 + i).map(y => { const st = hm[y] || ""; const inCb = cr && y >= cr[0] && y <= cr[1]; return `<button type="button" class="hy" data-y="${y}" data-st="${st}" style="padding:6px 4px;border-radius:8px;font-size:.85rem;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;border:2px solid ${inCb ? "var(--accent)" : "var(--line)"};${ftSet.has(y) ? "text-decoration:underline dotted;" : ""}">${ty(y)}<br><small class="lbl"></small></button>`; }).join("")}
        </div>
        <input type="hidden" name="hrp" id="hrpval" value="${esc(JSON.stringify(hm))}">
        ${audit ? `<p class="pill ${audit.kind === "due" ? "good" : audit.kind === "conflict" ? "bad" : ""}" style="justify-self:start">${esc(audit.text)}</p>` : ""}
        <small class="muted">Purple border: Child Benefit year. Dotted underline: client said full time.</small>
        <button>Save HRP years</button>
        <script>(function(){var order=["","present","missing","paid"],lab={"":"",present:"HRP present",missing:"HRP missing",paid:"NI paid"},col={"":"var(--bg)",present:"var(--good-tint)",missing:"var(--bad-tint)",paid:"var(--tint)"};
          var val=JSON.parse(document.getElementById("hrpval").value||"{}");
          document.querySelectorAll("#hrpchips .hy").forEach(function(b){function paint(){var s=b.dataset.st;b.style.background=col[s];b.querySelector(".lbl").textContent=lab[s];}paint();
            b.onclick=function(){var s=order[(order.indexOf(b.dataset.st)+1)%order.length];b.dataset.st=s;if(s)val[b.dataset.y]=s;else delete val[b.dataset.y];document.getElementById("hrpval").value=JSON.stringify(val);paint();};});})();</script>
      </form>
      <div class="panel"><h2>Files</h2>
        ${files.length ? `<table><tbody>${files.map(f => `<tr><td><a href="/file/${f.id}">${esc(f.name)}</a><br><small class="muted">${esc(FILE_KINDS[f.kind] || f.kind)} · ${Math.max(1, Math.round(f.size / 1024))} KB · ${fmtDate(iso(f.at))}</small></td></tr>`).join("")}</tbody></table>` : `<p class="muted" style="margin:0">No files yet.</p>`}
        <form id="upform" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
          <label>Type <select id="upkind">${opt(FILE_KINDS, "")}</select></label>
          <label>File <input type="file" id="upfile" accept=".pdf,.jpg,.jpeg,.png,.heic,.doc,.docx"></label>
          <button type="submit">Upload</button><span id="upmsg" class="muted"></span></form>
        <script>document.getElementById("upform").addEventListener("submit",function(e){e.preventDefault();var f=document.getElementById("upfile").files[0],m=document.getElementById("upmsg");if(!f){m.textContent="Choose a file first";return;}if(f.size>10*1024*1024){m.textContent="Files must be under 10 MB";return;}
          m.textContent="Uploading…";var r=new FileReader();r.onload=function(){fetch("/lead/${L.id}/files",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind:document.getElementById("upkind").value,name:f.name,mime:f.type,data:String(r.result).split(",")[1]})}).then(function(x){return x.json();}).then(function(j){if(j.ok)location.reload();else m.textContent=j.error||"Upload failed";}).catch(function(){m.textContent="Upload failed";});};r.readAsDataURL(f);});</script>
      </div>
      <div class="panel"><h2>Check answers</h2>${L.partial ? `<p class="pill bad" style="justify-self:start">Unfinished check: they stopped part way. A reminder text goes automatically.</p>` : ""}${L.details_done_at ? `<p class="pill good" style="justify-self:start">Completed their details online ${fmtDate(iso(L.details_done_at))}: confirm them on the call</p>` : ""}<dl>
        <dt>Who for</dt><dd>${esc(label("for_whom", L.for_whom))}</dd>
        ${L.helper_name ? `<dt>${L.for_whom === "died" ? "Contact for the estate" : "Helper"}</dt><dd>${esc(L.helper_name)}${L.helper_relation ? ` (${esc(L.helper_relation)})` : ""}${L.helper_phone ? `<br><span class="num">${esc(L.helper_phone)}</span>` : ""}${L.helper_email ? `<br>${esc(L.helper_email)}` : ""}${L.for_whom === "help" ? `<br><small class="${L.helper_ok ? "muted" : ""}" style="${L.helper_ok ? "" : "color:var(--bad)"}">${L.helper_ok ? "Confirmed the client knows and agrees" : "Client's agreement not confirmed"}</small>` : ""}</dd>` : ""}
        ${L.death_date ? `<dt>Died</dt><dd>${esc(L.death_date)}</dd>` : ""}
        ${L.sp_band || L.sp_start_year ? `<dt>State Pension</dt><dd>${esc(label("sp_band", L.sp_band) || "")}${L.sp_start_year ? ` · started ${L.sp_start_year}` : ""}</dd>` : ""}
        ${L.ft_from ? `<dt>Back to full time</dt><dd>${L.ft_from}</dd>` : ""}
        ${L.years_at_address ? `<dt>At address</dt><dd>${L.years_at_address === "lt4" ? "Less than 4 years" : "4 years or more"}${L.prev_address ? `<br><small class="muted">Previous: ${esc(L.prev_address)}</small>` : ""}</dd>` : ""}
        ${L.mobile ? `<dt>Mobile</dt><dd class="num">${esc(L.mobile)}</dd>` : ""}
        <dt>Child Benefit 1978–2010</dt><dd>${esc(label("cb", L.cb))}</dd>
        ${L.care ? `<dt>Carer or foster</dt><dd>${esc(label("care", L.care))}</dd>` : ""}
        <dt>Born</dt><dd>${L.born || ""}</dd><dt>Children born</dt><dd>${L.kid1 ? (L.kid1 === L.kid2 || !L.kid2 ? L.kid1 : `${L.kid1} to ${L.kid2}`) : "Not given"}</dd>
        <dt>Full time</dt><dd>${esc(label("ft", L.ft)) || "Not given"}${ftList.length ? `<br><small class="muted">${esc(yearRanges(ftList))}</small>` : ""}</dd>
        <dt>Marital status</dt><dd>${esc(label("marital", L.marital))}</dd>
        <dt>State Pension</dt><dd>${esc(label("pension", L.pension))}</dd><dt>Pension Credit</dt><dd>${esc(label("credit", L.credit))}</dd></dl></div>
      <form class="panel" method="post" action="/lead/${L.id}/case">
        <h2>Case details</h2>
        <div class="grid2">
          <label>NI number <input name="ni_number" value="${esc(fmtNi(L.ni_number))}" autocapitalize="characters">${L.ni_number && !validNi(L.ni_number) ? `<small style="color:var(--bad)">Doesn't look valid</small>` : ""}</label>
          <label>ID check <select name="kyc">${opt(KYC, L.kyc)}</select></label>
          <label>Sanctions and PEP screening <select name="sanctions">${opt({ "": "Not done", clear: "Clear", possible: "Possible match", confirmed: "Confirmed match" }, L.sanctions || "")}</select></label>
          <label>Someone acts for the client (LPA, deputy, appointee) <input name="attorney" value="${esc(L.attorney)}" placeholder="Leave blank if no one"></label>
          <label>Enhanced checks approved by (second person) <input name="edd_approved_by" value="${esc(L.edd_approved_by)}" placeholder="Name"></label>
          <label>CF411 checked by (second person) <input name="cf411_checked_by" value="${esc(L.cf411_checked_by)}" placeholder="Name"></label>
          <label>Date of birth <input type="date" name="dob" value="${iso(L.dob)}"></label>
          <label>Postcode <input name="postcode" id="pc" value="${esc(L.postcode)}" autocapitalize="characters"><small id="pcmsg" class="muted"></small></label>
          <script>(function(){var i=document.getElementById("pc"),m=document.getElementById("pcmsg");function chk(){var v=i.value.trim();if(!v){m.textContent="";return;}fetch("https://api.postcodes.io/postcodes/"+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(j){if(j.status===200){i.value=j.result.postcode;m.style.color="var(--good)";m.textContent="Valid postcode: "+[j.result.admin_ward,j.result.admin_district].filter(Boolean).join(", ");}else{m.style.color="var(--bad)";m.textContent="Postcode not found. Check it with the client.";}}).catch(function(){m.textContent="";});}i.addEventListener("change",chk);if(i.value)chk();})();</script>
          <label>Child Benefit from (tax year) <input name="cb_from" inputmode="numeric" placeholder="${L.kid1 || "e.g. 1981"}" value="${L.cb_from ?? ""}"></label>
          <label>Child Benefit to (tax year) <input name="cb_to" inputmode="numeric" placeholder="${L.kid2 ? Number(L.kid2) + 15 : "e.g. 1996"}" value="${L.cb_to ?? ""}"></label>
        </div>
        <label>Address (first line, town) <input name="address" value="${esc(L.address)}" style="width:100%" placeholder="e.g. 12 Acacia Avenue, Stockport"></label>
        <label>Full-time tax years (start year, e.g. 1979, 1980, 1995) <input name="ft_years" value="${esc(ftList.join(", "))}" style="width:100%"></label>
        <div class="note" style="background:var(--tint);border-radius:8px;padding:10px 12px">
          <b>Tax years to request from HMRC</b><br>${reqYears ? (reqYears.length ? esc(yearRanges(reqYears)) + ` <small class="muted">(${reqYears.length} years)</small>` : "None: every Child Benefit year was full time") : `<span class="muted">Enter the Child Benefit years (or children's birth years) to work this out.</span>`}
          <br><small class="muted">Request specific years only, never the whole 1978–2010 period. Full-time years are left out.</small>
        </div>
        <h3 style="font-size:1rem">Partner or other parent (if known)</h3>
        <div class="grid2">
          <label>Name <input name="partner_name" value="${esc(L.partner_name)}"></label>
          <label>NI number <input name="partner_ni" value="${esc(fmtNi(L.partner_ni))}" autocapitalize="characters"></label>
        </div>
        <label>If not known, why <input name="partner_unknown" value="${esc(L.partner_unknown)}" placeholder="e.g. divorced 1986, no contact" style="width:100%"></label>
        <button>Save case details</button>
      </form>
      <form class="panel" method="post" action="/lead/${L.id}/claim">
        <h2>Claim and fee</h2>${L.invoice_no ? `<p style="margin:0"><a class="btn ghost" href="/lead/${L.id}/invoice" target="_blank">View or print invoice ${esc(L.invoice_no)}</a>${L.invoice_sent_at ? ` <small class="muted">sent ${fmtDate(iso(L.invoice_sent_at))}</small>` : ""}</p>` : ""}
        <div class="grid2">
          <label>Pack signed on <input type="date" name="signed_at" value="${iso(L.signed_at)}"></label>
          <label>CF411 sent to HMRC <input type="date" name="submitted_at" value="${iso(L.submitted_at)}"></label>
          <label>Outcome received <input type="date" name="decision_at" value="${iso(L.decision_at)}"></label>
          <label>Arrears in DWP letter (£) <input name="arrears" inputmode="decimal" value="${L.arrears ?? ""}"></label>
          <label>DWP deductions, e.g. debt set-off (£) <input name="deductions" inputmode="decimal" value="${L.deductions ?? ""}"></label>
          <label>Invoice date <input type="date" name="invoice_date" value="${iso(L.invoice_date)}"></label>
          <label>Fee paid on <input type="date" name="paid_at" value="${iso(L.paid_at)}"></label>
          <label>Payment method <select name="pay_method"><option value=""></option>${opt({ transfer: "Bank transfer", cheque: "Cheque", phone: "Card by phone", plan: "Payment plan" }, L.pay_method)}</select></label>
        </div>
        <label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="arrears_letter" value="1" ${L.arrears_letter ? "checked" : ""}> DWP arrears breakdown letter received (needed before invoicing)</label>
        <label>Payment plan notes <input name="plan_note" value="${esc(L.plan_note)}" placeholder="e.g. £100 a month on the 1st" style="width:100%"></label>
        ${coolingEnds ? `<small class="${inCooling ? "" : "muted"}" style="${inCooling ? "font-weight:700;color:var(--warn)" : ""}">Cooling-off ${inCooling ? "runs until" : "ended"} ${fmtDate(coolingEnds)}. Cancelling within it costs the client nothing, even if work has started.</small>` : ""}
        ${fee != null ? `<dl><dt>Paid to client</dt><dd class="num">${gbp(net)}${Number(L.deductions || 0) ? ` <small class="muted">(${gbp(L.arrears)} less ${gbp(L.deductions)})</small>` : ""}</dd><dt>Fee (30%)</dt><dd class="num">${gbp(fee)}</dd><dt>VAT (20%)</dt><dd class="num">${gbp(vat)}</dd><dt>Total to invoice</dt><dd class="num">${gbp(fee + vat)}</dd><dt>Client keeps</dt><dd class="num">${gbp(net - fee - vat)}</dd>${L.invoice_due ? `<dt>Payment due</dt><dd>${fmtDate(iso(L.invoice_due))}</dd>` : ""}${L.reminders ? `<dt>Reminders sent</dt><dd>${L.reminders} (last ${fmtDate(iso(L.last_reminder))})</dd>` : ""}</dl>` : `<small class="muted">Enter the arrears from the DWP letter to work out the fee. The fee is charged on what the client actually receives, after any DWP deductions.</small>`}
        <button>Save claim details</button>
      </form>
      ${L.stage === "invoiced" && L.reminders < 3 ? `<form class="panel" method="post" action="/lead/${L.id}/reminder"><h2>Fee reminders</h2><p class="muted">${L.reminders} of 3 sent. After the third, offer a payment plan.</p><button class="btn ghost">Log reminder ${L.reminders + 1} sent</button></form>` : ""}
    </div>
  </div>`, { nav: "board" }));
});

const money = v => { if (v === "" || v == null) return null; const n = Math.round(parseFloat(String(v).replace(/[£,\s]/g, "")) * 100) / 100; return isNaN(n) ? null : n; };
app.post("/lead/:id/stage", async (req, res) => {
  const L = await getLead(req.params.id); const s = STAGE[req.body.stage]; if (!L || !s) return res.redirect("/");
  if (s.id === L.stage) return res.redirect("/lead/" + L.id);
  const block = m => res.redirect(`/lead/${L.id}?err=${encodeURIComponent(m)}`);
  if (NEEDS_ID.includes(s.id) && !L.signed_at) return block("The sign-up pack hasn't been marked as signed yet.");
  if (NEEDS_ID.includes(s.id) && L.kyc !== "passed") return block("The ID check hasn't passed yet. Nothing moves on until identity is verified.");
  const rk = riskOf(L);
  if (NEEDS_ID.includes(s.id) && rk.level !== "low" && !L.edd_approved_by) return block(`This case needs enhanced checks (${rk.reasons.join("; ")}). A second person must approve it under Case details before it moves on.`);
  if (NEEDS_ID.includes(s.id) && rk.level === "high") return block(`High risk (${rk.reasons.join("; ")}). Compliance must decide: hold, STOP or close.`);
  if (s.id === "submitted" && !L.cf411_checked_by) return block("A second person must check the CF411 before it goes to HMRC. Enter their name under Case details.");
  if (L.stage === "fraud_freeze" && !s.id.startsWith("closed") && !s.id.startsWith("hold")) return block("This case is frozen for suspected fraud. Only compliance can release it: move it to a hold or close it.");
  if (["pack_sent", "signed"].includes(s.id) && L.attorney && !L.is_test) return block("Someone else acts for this client. The policy on attorneys isn't decided yet, so don't send documents.");
  if (["invoiced", "payment_plan"].includes(s.id) && (!L.arrears_letter || L.arrears == null)) return block("Invoice only once arrears are confirmed: tick the DWP arrears letter and enter the arrears first.");
  if (s.id === "closed_withdrawn" && L.signed_at && today() > addDays(iso(L.signed_at), 14)) return block("The 14-day cooling-off period has ended. Use \"Closed: not going ahead\" and check the fee agreement for what's owed.");
  const sets = ["stage=$2", "updated_at=now()"], vals = [L.id, s.id];
  if (s.next) { vals.push(s.next[0], s.id === "invoiced" && L.invoice_due ? iso(L.invoice_due) : addDays(today(), s.next[1])); sets.push(`next_action=$${vals.length - 1}`, `next_action_date=$${vals.length}`); }
  else sets.push("next_action=NULL", "next_action_date=NULL");
  if (s.id === "signed" && !L.signed_at) sets.push("signed_at=current_date");
  if (s.id === "submitted" && !L.submitted_at) sets.push("submitted_at=current_date");
  if (s.id === "decision" && !L.decision_at) sets.push("decision_at=current_date");
  if (s.id === "invoiced" && !L.invoice_date) sets.push("invoice_date=current_date", `invoice_due=current_date + ${PAY_DAYS}`);
  if (s.id === "invoiced" && !L.invoice_no) sets.push(`invoice_no='MY-${String(L.id).padStart(5, "0")}'`);
  if (["submitted"].includes(s.id) && await submissionHold()) return block("HMRC submissions are on hold (see Settings). Don't send claims to HMRC until the hold is lifted.");
  if (s.id === "payment_plan") sets.push("pay_method='plan'");
  if (s.id === "paid" && !L.paid_at) sets.push("paid_at=current_date");
  await pool.query(`UPDATE leads SET ${sets.join(",")} WHERE id=$1`, vals);
  await log(L.id, "stage", `Moved from ${STAGE[L.stage]?.label || L.stage} to ${s.label}`);
  if (s.id === "ni_requested") { const y = requestYears(L); await log(L.id, "hmrc", y && y.length ? `NI record requested for ${yearRanges(y)}` : "NI record requested: tax years not worked out yet, record them in a note"); }
  if (s.id === "closed_withdrawn") await log(L.id, "fee", "Cancelled within cooling-off: no fee payable");
  if (s.id === "invoiced") {
    await PAY.ensureToken(L.id);
    const I = await getLead(L.id); const F = await ES.settings();
    await log(L.id, "fee", `Invoice ${I.invoice_no} raised for ${gbp(Number(I.fee) + Number(I.vat))}, due ${fmtDate(iso(I.invoice_due))}`);
    if (I.email && !I.email_bad) sendEmail(I.email, `${BRAND}: invoice ${I.invoice_no}`, invoiceText(I, F)).then(ok => ok && pool.query("UPDATE leads SET invoice_sent_at=current_date WHERE id=$1", [I.id]).then(() => log(I.id, "fee", "Invoice emailed to client")));
  }
  res.redirect("/lead/" + L.id + "?ok=1");
});
app.post("/lead/:id/next", async (req, res) => {
  await pool.query("UPDATE leads SET next_action=$2, next_action_date=$3, updated_at=now() WHERE id=$1", [req.params.id, clip(req.body.next_action, 200), req.body.next_action_date || null]);
  await log(req.params.id, "next", `Next action: ${clip(req.body.next_action, 200)}${req.body.next_action_date ? " by " + fmtDate(req.body.next_action_date) : ""}`);
  res.redirect("/lead/" + req.params.id + "?ok=1");
});
app.post("/lead/:id/client-message", async (req, res) => {
  const m = clip(req.body.client_message, 1000) || null;
  await pool.query("UPDATE leads SET client_message=$2, client_message_at=now(), updated_at=now() WHERE id=$1", [req.params.id, m]);
  await log(req.params.id, "client", m ? "Client update set: " + m : "Client update cleared (standard message shown)");
  res.redirect("/lead/" + req.params.id + "?ok=1");
});
app.post("/lead/:id/note", async (req, res) => {
  const text = clip(req.body.text, 4000); if (text) { await log(req.params.id, clip(req.body.kind, 20) || "note", text); await pool.query("UPDATE leads SET updated_at=now() WHERE id=$1", [req.params.id]); }
  res.redirect("/lead/" + req.params.id + "?ok=1");
});
app.post("/lead/:id/case", async (req, res) => {
  const L = await getLead(req.params.id); if (!L) return res.redirect("/");
  const b = req.body, yr = v => { const n = parseInt(v, 10); return n >= 1978 && n <= 2009 ? n : null; };
  const kyc = KYC[b.kyc] ? b.kyc : L.kyc;
  const ni = normNi(b.ni_number) || null, pni = normNi(b.partner_ni) || null;
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(b.dob || "") ? b.dob : null;
  const extra = { sanctions: ["clear", "possible", "confirmed"].includes(b.sanctions) ? b.sanctions : null, attorney: clip(b.attorney, 200) || null, edd: clip(b.edd_approved_by, 60) || null, cf: clip(b.cf411_checked_by, 60) || null };
  if (extra.cf && L.owner && extra.cf.toLowerCase() === String(L.owner).toLowerCase()) return res.redirect(`/lead/${L.id}?err=${encodeURIComponent("The CF411 must be checked by someone other than the case owner.")}`);
  await pool.query("UPDATE leads SET sanctions=$2, attorney=$3, edd_approved_by=$4, cf411_checked_by=$5 WHERE id=$1", [L.id, extra.sanctions, extra.attorney, extra.edd, extra.cf]);
  if (extra.sanctions !== (L.sanctions || null)) await log(L.id, "kyc", `Sanctions and PEP screening: ${extra.sanctions || "not done"}`);
  if (extra.sanctions === "confirmed") await pool.query("UPDATE leads SET stage='fraud_freeze', next_action='Sanctions or PEP match: compliance to decide, do not proceed', next_action_date=current_date WHERE id=$1", [L.id]);
  if (extra.attorney && extra.attorney !== (L.attorney || "")) await log(L.id, "check", `Someone acts for the client: ${extra.attorney}. Hold until the attorney policy is decided.`);
  if (extra.edd && extra.edd !== (L.edd_approved_by || "")) await log(L.id, "kyc", `Enhanced checks approved by ${extra.edd}`);
  if (extra.cf && extra.cf !== (L.cf411_checked_by || "")) await log(L.id, "hmrc", `CF411 checked by ${extra.cf}`);
  await pool.query(`UPDATE leads SET ni_number=$2, kyc=$3, cb_from=$4, cb_to=$5, ft_years=$6, partner_name=$7, partner_ni=$8, partner_unknown=$9, dob=$10, address=$11, postcode=$12, updated_at=now() WHERE id=$1`,
    [L.id, ni, kyc, yr(b.cb_from), yr(b.cb_to), parseYears(b.ft_years).join(",") || null, clip(b.partner_name, 120) || null, pni, clip(b.partner_unknown, 300) || null, dob, clip(b.address, 300) || null, clip(b.postcode, 10).toUpperCase() || null]);
  if (dob && L.born && Number(dob.slice(0, 4)) !== Number(L.born)) await log(L.id, "check", `Date of birth year (${dob.slice(0, 4)}) doesn't match the year of birth given in the check (${L.born}).`);
  if (kyc !== L.kyc) {
    await log(L.id, "kyc", `ID check: ${KYC[kyc]}`);
    if (kyc === "passed" && L.stage === "signed") await pool.query("UPDATE leads SET next_action=$2, next_action_date=$3 WHERE id=$1", [L.id, "Invite the client to share their NI record (optional), and send the DWP information request", today()]);
    if (kyc === "failed") await pool.query("UPDATE leads SET next_action=$2, next_action_date=$3 WHERE id=$1", [L.id, "ID check failed: ask for documents or close the case", today()]);
    if (kyc === "escalation") { await pool.query("UPDATE leads SET next_action=$2, next_action_date=$3 WHERE id=$1", [L.id, "ID check referred: client asked for photo ID and proof of address; manager to review", nextWorkingDay(today())]); await MSG.queue(await getLeadRow(L.id), "id_docs"); await log(L.id, "kyc", "Asked the client for photo ID and proof of address"); }
  }
  if (ni && !validNi(ni)) await log(L.id, "check", "NI number saved but doesn't look valid");
  if (!clip(b.partner_name, 120) && clip(b.partner_unknown, 300) && clip(b.partner_unknown, 300) !== (L.partner_unknown || "")) await log(L.id, "check", "Partner details not known: " + clip(b.partner_unknown, 300) + ". Review before submitting.");
  await log(L.id, "case", "Case details updated");
  res.redirect("/lead/" + L.id + "?ok=1");
});
app.post("/lead/:id/claim", async (req, res) => {
  const b = req.body, d = v => v || null;
  const arrears = money(b.arrears), deductions = money(b.deductions);
  const net = arrears != null ? Math.max(0, arrears - (deductions || 0)) : null;
  const fee = net != null ? Math.round(net * FEE_RATE * 100) / 100 : null;
  const vat = fee != null ? Math.round(fee * VAT_RATE * 100) / 100 : null;
  const due = b.invoice_date ? addDays(b.invoice_date, PAY_DAYS) : null;
  await pool.query(`UPDATE leads SET signed_at=$2, submitted_at=$3, decision_at=$4, arrears=$5, fee=$6, vat=$7, invoice_date=$8, invoice_due=$9, paid_at=$10, deductions=$11, arrears_letter=$12, plan_note=$13, pay_method=$14, updated_at=now() WHERE id=$1`,
    [req.params.id, d(b.signed_at), d(b.submitted_at), d(b.decision_at), arrears, fee, vat, d(b.invoice_date), due, d(b.paid_at), deductions, b.arrears_letter === "1", clip(b.plan_note, 300) || null, clip(b.pay_method, 20) || null]);
  await log(req.params.id, "claim", "Claim details updated" + (arrears ? `: arrears ${gbp(arrears)}${deductions ? `, less ${gbp(deductions)} deductions` : ""}, fee ${gbp(fee + vat)} inc. VAT` : ""));
  res.redirect("/lead/" + req.params.id + "?ok=1");
});
app.post("/lead/:id/reminder", async (req, res) => {
  const L = await getLead(req.params.id); if (!L || L.reminders >= 3) return res.redirect("/money");
  const n = L.reminders + 1;
  await pool.query("UPDATE leads SET reminders=$2, last_reminder=current_date, next_action=$3, next_action_date=$4, updated_at=now() WHERE id=$1",
    [L.id, n, n < 3 ? `If still unpaid, send reminder ${n + 1}` : "Final reminder sent: call to offer a payment plan", addDays(today(), 7)]);
  await log(L.id, "fee", `Payment reminder ${n} sent`);
  res.redirect(req.body.back === "money" ? "/money?ok=" + encodeURIComponent(`Reminder ${n} logged for ${L.first_name} ${L.last_name}.`) : "/lead/" + L.id + "?ok=1");
});

app.post("/lead/:id/header", async (req, res) => {
  const L = await getLead(req.params.id); if (!L) return res.redirect("/");
  const vul = req.body.vulnerable === "1", owner = clip(req.body.owner, 60) || null, note = clip(req.body.vulnerable_note, 500) || null;
  await pool.query("UPDATE leads SET owner=$2, vulnerable=$3, vulnerable_note=$4, updated_at=now() WHERE id=$1", [L.id, owner, vul, note]);
  if (vul !== L.vulnerable) await log(L.id, "check", vul ? "Marked as a vulnerable client" + (note ? ": " + note : "") : "Vulnerable flag removed");
  if (owner !== (L.owner || null)) await log(L.id, "owner", owner ? `Assigned to ${owner}` : "Owner removed");
  res.redirect("/lead/" + L.id + "?ok=1");
});
app.post("/lead/:id/verify-hmrc", async (req, res) => {
  const v = req.body.v === "1";
  await pool.query("UPDATE leads SET hmrc_verified=$2, updated_at=now() WHERE id=$1", [req.params.id, v]);
  await log(req.params.id, "check", v ? "Client details confirmed as matching HMRC's records" : "HMRC details check cleared");
  res.redirect("/lead/" + req.params.id + "?ok=1");
});
app.post("/lead/:id/contact-flags", async (req, res) => {
  const L = await getLead(req.params.id); if (!L) return res.redirect("/");
  const e = req.body.email_bad === "1", p = req.body.phone_bad === "1";
  await pool.query("UPDATE leads SET email_bad=$2, phone_bad=$3, updated_at=now() WHERE id=$1", [L.id, e, p]);
  if (e !== L.email_bad) await log(L.id, "check", e ? "Email marked as bouncing" : "Email marked as working");
  if (p !== L.phone_bad) await log(L.id, "check", p ? "Phone or texts marked as not working" : "Phone marked as working");
  res.redirect("/lead/" + L.id + "?ok=1");
});
app.post("/lead/:id/details", async (req, res) => {
  const L = await getLead(req.params.id); if (!L) return res.redirect("/");
  const b = req.body, dt = v => /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;
  const children = [];
  for (let i = 0; i < 7; i++) { const c = { name: clip(b[`c${i}_name`], 80), dob: dt(b[`c${i}_dob`]) || "", father: clip(b[`c${i}_father`], 80) }; if (c.name || c.dob) children.push(c); }
  children.sort((a, c) => (a.dob || "9999").localeCompare(c.dob || "9999"));
  const types = Object.keys(CLAIM_TYPES).filter(k => b["ct_" + k] === "1").join(",") || null;
  const spy = parseInt(b.sp_start_year, 10);
  await pool.query(`UPDATE leads SET hmrc_name=$2, prev_names=$3, prev_address=$4, born_uk=$5, outside_uk=$6, other_cb=$7, working_caring=$8, children=$9, marriage_date=$10, partner_death_date=$11, partner_self_employed=$12, claim_types=$13, sp_start_year=$14, updated_at=now() WHERE id=$1`,
    [L.id, clip(b.hmrc_name, 120) || null, clip(b.prev_names, 200) || null, clip(b.prev_address, 300) || null, clip(b.born_uk, 5) || null, clip(b.outside_uk, 200) || null, clip(b.other_cb, 200) || null, clip(b.working_caring, 200) || null,
     children.length ? JSON.stringify(children) : null, dt(b.marriage_date), dt(b.partner_death_date), clip(b.partner_self_employed, 10) || null, types, spy >= 1990 && spy <= 2040 ? spy : null]);
  if (clip(b.other_cb, 200) && clip(b.other_cb, 200) !== (L.other_cb || "")) await log(L.id, "check", "Someone else may have claimed Child Benefit: " + clip(b.other_cb, 200) + ". HRP goes to the person paid the Child Benefit.");
  if (clip(b.outside_uk, 200) && clip(b.outside_uk, 200) !== (L.outside_uk || "")) await log(L.id, "check", "Time outside the UK: " + clip(b.outside_uk, 200) + ". Check those years separately.");
  await log(L.id, "case", "Client details updated");
  res.redirect("/lead/" + L.id + "?ok=1");
});
app.post("/lead/:id/hrp", async (req, res) => {
  const L = await getLead(req.params.id); if (!L) return res.redirect("/");
  let m = {}; try { m = JSON.parse(req.body.hrp || "{}"); } catch { }
  const clean = {}; for (const [y, v] of Object.entries(m)) if (Number(y) >= 1978 && Number(y) <= 2009 && ["present", "missing", "paid"].includes(v)) clean[y] = v;
  await pool.query("UPDATE leads SET hrp_years=$2, updated_at=now() WHERE id=$1", [L.id, Object.keys(clean).length ? JSON.stringify(clean) : null]);
  const a = hrpAudit({ ...L, hrp_years: clean });
  await log(L.id, "hmrc", a ? "HRP years recorded. " + a.text : "HRP years cleared");
  if (a && a.kind === "due" && L.stage === "preparing") await pool.query("UPDATE leads SET next_action='HRP due: prepare the CF411 declaration', next_action_date=current_date WHERE id=$1", [L.id]);
  if (a && a.kind === "notdue" && L.stage === "preparing") await pool.query("UPDATE leads SET next_action='HRP not due: check DWP evidence, then close or look at uplifts', next_action_date=current_date WHERE id=$1", [L.id]);
  res.redirect("/lead/" + L.id + "?ok=1");
});
app.post("/lead/:id/files", express.json({ limit: "15mb" }), async (req, res) => {
  const L = await getLead(req.params.id); if (!L) return res.status(404).json({ ok: false });
  const b = req.body || {}, kind = FILE_KINDS[b.kind] ? b.kind : "other", data = String(b.data || "");
  if (!/^[A-Za-z0-9+/=]+$/.test(data) || !data.length) return res.status(400).json({ ok: false, error: "That file couldn't be read" });
  const size = Math.floor(data.length * 3 / 4);
  if (size > 10 * 1024 * 1024) return res.status(400).json({ ok: false, error: "Files must be under 10 MB" });
  const name = clip(b.name, 160).replace(/[^\w .()-]/g, "_") || "file";
  await pool.query("INSERT INTO files(lead_id,kind,name,mime,size,data) VALUES($1,$2,$3,$4,$5,decode($6,'base64'))", [L.id, kind, name, clip(b.mime, 80) || "application/octet-stream", size, data]);
  await log(L.id, "file", `Uploaded ${FILE_KINDS[kind]}: ${name}`);
  if (kind === "reject648") { await pool.query("UPDATE leads SET stage=CASE WHEN stage = ANY($2) THEN stage ELSE 'resubmit_648' END, next_action='64-8 rejected: fix and resubmit', next_action_date=current_date, updated_at=now() WHERE id=$1", [L.id, DONE]); await log(L.id, "hmrc", "64-8 rejected by HMRC: moved to resubmit"); }
  if (kind === "arrears") await pool.query("UPDATE leads SET next_action='DWP arrears letter uploaded: enter the arrears and tick the letter', next_action_date=current_date WHERE id=$1", [L.id]);
  if (kind === "soa") await pool.query("UPDATE leads SET next_action='NI statement received: record HRP for each tax year', next_action_date=current_date WHERE id=$1", [L.id]);
  res.json({ ok: true });
});
app.get("/file/:fid", async (req, res) => {
  const f = (await pool.query("SELECT lead_id, name, mime, encode(data,'base64') AS b64 FROM files WHERE id=$1", [req.params.fid])).rows[0];
  if (!f) return res.status(404).send("Not found");
  await log(f.lead_id, "file", `Opened file: ${f.name}`);
  res.set("Content-Type", f.mime || "application/octet-stream");
  res.set("Content-Disposition", `inline; filename="${f.name.replace(/"/g, "")}"`);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", "sandbox");
  res.send(Buffer.from(f.b64, "base64"));
});

/* print and post: HMRC and DWP paperwork goes by post, so batch it */
const HMRC_ADDR_DEFAULT = "HM Revenue & Customs\nNational Insurance Contributions and Employers Office\nBX9 1AN";
const BATCHES = {
  soa: { title: "NI record requests (SoA) to HMRC", hint: "Clients invited to share their NI record who haven't after 7 days, and 64-8 resubmissions." },
  dwp: { title: "DWP information requests", hint: "Signed, ID checked, DWP request not yet posted." },
  cf411: { title: "CF411 claims to HMRC", hint: "CF411 declaration signed, claim not yet posted. Attach the official CF411 completed with the same details." },
  paper: { title: "Paper packs to clients", hint: "Clients who asked to sign on paper." },
  invoice: { title: "Invoices to post", hint: "Invoices not yet sent, for clients with no working email or who prefer paper." }
};
async function batchRows(kind) {
  if (kind === "soa") return (await pool.query(`SELECT * FROM leads WHERE stage IN ('ni_wait','resubmit_648') ORDER BY next_action_date NULLS LAST, id`)).rows;
  if (kind === "dwp") return (await pool.query(`SELECT * FROM leads WHERE signed_at IS NOT NULL AND kyc='passed' AND dwp_sent_at IS NULL AND stage <> ALL(${DONE_SQL}) AND stage NOT IN ('new','contacted','qualified','pack_sent','resign','signed') ORDER BY id`)).rows;
  if (kind === "cf411") return (await pool.query(`SELECT l.* FROM leads l WHERE l.submitted_at IS NULL AND l.stage <> ALL(${DONE_SQL}) AND EXISTS (SELECT 1 FROM sign_requests r WHERE r.lead_id=l.id AND r.kind='cf411' AND r.status='signed') ORDER BY l.id`)).rows;
  if (kind === "invoice") return (await pool.query(`SELECT * FROM leads WHERE stage IN ('invoiced','payment_plan') AND invoice_no IS NOT NULL AND invoice_sent_at IS NULL ORDER BY invoice_date, id`)).rows;
  if (kind === "paper") return (await pool.query(`SELECT * FROM leads WHERE paper_requested AND stage <> ALL(${DONE_SQL}) ORDER BY id`)).rows;
  return [];
}
const toIds = v => [].concat(v || []).join(",").split(",").map(Number).filter(n => n > 0);
app.get("/post", async (req, res) => {
  const sections = [];
  for (const [k, B] of Object.entries(BATCHES)) {
    const rows = await batchRows(k);
    const ready = r => k !== "soa" || r.stage === "resubmit_648" || !r.next_action_date || iso(r.next_action_date) <= today();
    sections.push(`<form class="panel" method="get" action="/post/${k}/print" target="_blank"><h2>${esc(B.title)} <span class="pill">${rows.length}</span></h2><p class="muted" style="margin:0">${esc(B.hint)}</p>
      ${rows.length ? `<div class="tablewrap"><table><thead><tr><th></th><th>Client</th><th>Stage</th><th>Details</th></tr></thead><tbody>${rows.map(r => `<tr><td><input type="checkbox" name="id" value="${r.id}" ${ready(r) ? "checked" : ""}></td><td><a href="/lead/${r.id}">${esc(r.first_name)} ${esc(r.last_name)}</a> ${flags(r)}</td><td>${esc(STAGE[r.stage]?.label)}</td>
        <td class="muted">${k === "soa" ? (r.stage === "resubmit_648" ? "64-8 resubmit" : ready(r) ? "Ready: 7 days passed" : "Waiting for client until " + fmtDate(iso(r.next_action_date))) + (requestYears(r) ? ` · ${requestYears(r).length} tax years` : " · tax years not known") : k === "cf411" ? (hrpDue(r).length ? yearRanges(hrpDue(r)) : "HRP years not recorded") : ""}</td></tr>`).join("")}</tbody></table></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button>Print selected</button><button class="btn ghost" formaction="/post/${k}" formmethod="post" formtarget="_self">Mark selected as posted</button></div>` : `<p class="muted">Nothing waiting.</p>`}</form>`);
  }
  const hold = await submissionHold();
  res.send(page("Post", `${req.query.done ? `<div class="flash">${esc(req.query.done)}</div>` : ""}${hold ? `<div class="flash" style="background:var(--bad-tint);color:var(--bad)">HMRC submissions are on hold: ${esc(hold)}. NI requests and CF411s can be printed but not marked as posted. Lift the hold in Settings.</div>` : ""}<h1>Print and post</h1>
  <p class="muted">HMRC and DWP paperwork goes by post. Print a batch, post it, then mark it as posted so each case moves on and the chase dates are set.</p>${sections.join("")}`, { nav: "post" }));
});
app.get("/post/:batch/print", async (req, res) => {
  const k = req.params.batch; if (!BATCHES[k]) return res.redirect("/post");
  const ids = toIds(req.query.id || req.query.ids);
  const F = await ES.settings();
  const hmrcAddr = F.hmrc_address || HMRC_ADDR_DEFAULT, dwpAddr = F.dwp_address || "[Set the DWP postal address in Settings]";
  const firm = `${esc(F.company_name || "[company name]")} trading as ${esc(BRAND)}<br>${esc(F.address || "[address]")}<br>${esc(F.phone || PHONE)} · ${esc(F.email || "[email]")}${F.arn ? `<br>Agent Reference Number (ARN) ${esc(F.arn)}` : ""}${F.agent_code ? `<br>HMRC agent code ${esc(F.agent_code)}` : ""}`;
  const letter = (to, L, body) => `<article class="doc"><p style="text-align:right">${firm}</p><p>${esc(to).replace(/\n/g, "<br>")}</p><p>${fmtDate(today())}</p>
    <p><b>Re: ${esc([L.title, L.first_name, L.last_name].filter(Boolean).join(" "))}, NI number ${esc(fmtNi(L.ni_number) || "[missing]")}, date of birth ${L.dob ? fmtDate(iso(L.dob)) : "[missing]"}</b><br>${esc(L.address || "")} ${esc(L.postcode || "")}${L.hmrc_name ? `<br>Name as held by HMRC: ${esc(L.hmrc_name)}` : ""}${L.prev_names ? `<br>Previous names: ${esc(L.prev_names)}` : ""}</p>${body}<p>Yours faithfully,</p><p>${esc(BRAND)}</p><p class="doc-small">Our reference ${L.id}</p></article>`;
  const parts = [];
  for (const id of ids) {
    const L = await getLead(id); if (!L) continue;
    if (k === "soa") {
      const yrs = requestYears(L) || [];
      parts.push(letter(hmrcAddr, L, `<p><b>Statement of Account request, in support of a CF411 Home Responsibilities Protection claim</b></p><p>We act for the above client as their authorised agent. A valid signed HMRC form 64-8 ${L.stage === "resubmit_648" ? "is enclosed, corrected as you asked," : "has been submitted"} under Agent Reference Number ${esc(F.arn || "[ARN]")}. The client's signed request and consent, which explain how the years were chosen, are enclosed. Please send us a statement of the client's National Insurance contributions and credits, including Home Responsibilities Protection, for <b>these tax years only</b>: ${yrs.length ? esc(yearRanges(yrs)) : "<b>[tax years not known: do not send]</b>"}.</p><p>Years in which the client worked full time have been left out.</p>`));
      const pk = await ES.latest(L.id, "pack", ["signed"]);
      if (pk) parts.push(ES.docsForPrint(pk, ["hmrc", "nirequest"]));
    } else if (k === "dwp") {
      const pk = await ES.latest(L.id, "pack", ["signed"]);
      parts.push(letter(dwpAddr, L, dwpRequestBody(L, pk, BRAND, F.company_name || "[company name]")));
      if (pk) parts.push(ES.docsForPrint(pk, ["dwp"]));
    } else if (k === "cf411") {
      parts.push(letter(hmrcAddr, L, `<p><b>CF411 Home Responsibilities Protection claim</b></p><p>We act for the above client as their authorised agent. A valid signed HMRC form 64-8 has been submitted under Agent Reference Number ${esc(F.arn || "[ARN]")}. Please find enclosed the client's completed CF411 claim form and their signed declaration.</p><p>${esc(claimSummary(L)).replace(/\n/g, "<br>")}</p>`));
      const cf = await ES.latest(L.id, "cf411", ["signed"]); if (cf) parts.push(ES.docsForPrint(cf));
      parts.push(`<article class="doc noprint" style="border:2px dashed var(--bad)"><b>Attach the official CF411 for ${esc(L.first_name)} ${esc(L.last_name)}, completed with the details above.</b></article>`);
    } else if (k === "invoice") {
      parts.push(`<iframe src="/lead/${L.id}/invoice" style="width:100%;height:1100px;border:0" title="Invoice ${esc(L.invoice_no)}"></iframe>`);
    } else if (k === "paper") {
      const open = await ES.latest(L.id, "pack", ["sent", "opened"]);
      parts.push(`<article class="doc"><p style="text-align:right">${firm}</p><p>${esc([L.title, L.first_name, L.last_name].filter(Boolean).join(" "))}<br>${esc(L.address || "[address]")}<br>${esc(L.postcode || "")}</p><p>${fmtDate(today())}</p>
        <p>Dear ${esc(L.title || "")} ${esc(L.last_name)},</p><p>As you asked, here are paper copies of your documents. Please read each one, sign and date where shown, and return them in the prepaid envelope. Everything has been filled in for you; please don't change anything. If something is wrong, call us and we'll send a corrected copy.</p>
        <p>You can cancel within 14 days of signing and pay nothing, even if we've started work. Questions? Call us on ${esc(F.phone || PHONE)}, weekdays 9am to 5pm.</p><p>Yours sincerely,</p><p>${esc(BRAND)}</p></article>`);
      if (open) parts.push(ES.docsForPrint(open, null, true)); else parts.push(`<article class="doc noprint" style="border:2px dashed var(--bad)"><b>No open sign-up pack for ${esc(L.first_name)} ${esc(L.last_name)}. Prepare one on their record first.</b></article>`);
    }
  }
  res.send(page("Print batch", `<style>${ES.DOC_CSS}</style><div class="noprint" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h1>${esc(BATCHES[k].title)}: ${ids.length} client${ids.length === 1 ? "" : "s"}</h1><button onclick="window.print()">Print</button></div>${parts.join("") || "<p>Nothing selected.</p>"}`, { bare: true }));
});
app.post("/post/:batch", async (req, res) => {
  const k = req.params.batch; if (!BATCHES[k]) return res.redirect("/post");
  const ids = toIds(req.body.id || req.body.ids); let n = 0;
  if (["soa", "cf411"].includes(k) && await submissionHold()) return res.redirect("/post?done=" + encodeURIComponent("Not posted: HMRC submissions are on hold (see Settings)."));
  for (const id of ids) {
    const L = await getLead(id); if (!L) continue;
    if (k === "soa") {
      const yrs = requestYears(L) || [];
      await pool.query("UPDATE leads SET soa_sent_at=current_date, stage='ni_requested', next_action='Chase HMRC for the NI record', next_action_date=$2, updated_at=now() WHERE id=$1", [id, addDays(today(), 21)]);
      await log(id, "hmrc", `Posted to HMRC: ${L.stage === "resubmit_648" ? "64-8 resubmitted with " : ""}NI record request for ${yrs.length ? yearRanges(yrs) : "[years not recorded]"}`);
    } else if (k === "dwp") {
      await pool.query("UPDATE leads SET dwp_sent_at=current_date, updated_at=now() WHERE id=$1", [id]);
      await log(id, "dwp", "Posted to DWP: information request with signed letter of authority. Chase in 21 days.");
    } else if (k === "cf411") {
      if (!L.cf411_checked_by) { await log(id, "hmrc", "Not marked as posted: CF411 hasn't been checked by a second person"); continue; }
      await pool.query("UPDATE leads SET submitted_at=current_date, stage='submitted', next_action='Monthly update to client; chase HMRC if past reply date', next_action_date=$2, updated_at=now() WHERE id=$1", [id, addDays(today(), 30)]);
      await log(id, "hmrc", `Posted to HMRC: CF411 claim${hrpDue(L).length ? " for " + yearRanges(hrpDue(L)) : ""}`);
    } else if (k === "invoice") {
      await pool.query("UPDATE leads SET invoice_sent_at=current_date, updated_at=now() WHERE id=$1", [id]);
      await log(id, "fee", "Invoice posted to the client");
    } else if (k === "paper") {
      await pool.query("UPDATE leads SET paper_requested=false, next_action='Chase the signed paper pack', next_action_date=$2, updated_at=now() WHERE id=$1", [id, addDays(today(), 10)]);
      await log(id, "esign", "Paper pack posted to the client");
    }
    n++;
  }
  res.redirect("/post?done=" + encodeURIComponent(`${n} marked as posted.`));
});

/* complaints and data requests */
function workingDays(from, n) { let d = iso(from); let k = 0; while (k < n) { d = addDays(d, 1); const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w !== 0 && w !== 6) k++; } return d; }
app.get("/complaints", async (req, res) => {
  const { rows } = await pool.query("SELECT a.*, l.first_name, l.last_name FROM activity a JOIN leads l ON l.id=a.lead_id WHERE a.kind IN ('complaint','data') ORDER BY (a.resolved_at IS NULL) DESC, a.at DESC LIMIT 500");
  const t = today();
  res.send(page("Complaints", `<h1>Complaints and data requests</h1>
  <p class="muted">Logged from the "Add a note" box on a client's record (choose Complaint or Data request). Complaints: acknowledge within 5 working days, final response within 8 weeks. Data requests: respond within one month.</p>
  <div class="panel tablewrap"><table><thead><tr><th>Received</th><th>Client</th><th>Type</th><th>Details</th><th>Due</th><th></th></tr></thead><tbody>
  ${rows.map(a => { const due = a.kind === "complaint" ? addDays(iso(a.at), 56) : addDays(iso(a.at), 30); const ack = a.kind === "complaint" ? workingDays(a.at, 5) : null;
    return `<tr><td>${fmtDate(iso(a.at))}</td><td><a href="/lead/${a.lead_id}">${esc(a.first_name)} ${esc(a.last_name)}</a></td><td>${a.kind === "complaint" ? "Complaint" : "Data request"}</td><td>${esc(a.text)}</td>
    <td>${a.resolved_at ? `<span class="pill good">Resolved ${fmtDate(iso(a.resolved_at))}</span>` : `${ack ? `<small>Acknowledge by ${fmtDate(ack)}</small><br>` : ""}<span class="due ${due < t ? "over" : ""}">${due < t ? "Overdue: " : "Respond by "}${fmtDate(due)}</span>`}</td>
    <td>${a.resolved_at ? "" : `<form method="post" action="/activity/${a.id}/resolve"><button class="btn ghost" style="padding:4px 10px">Mark resolved</button></form>`}</td></tr>`; }).join("") || `<tr><td colspan="6" class="muted">None logged.</td></tr>`}
  </tbody></table></div>`, { nav: "complaints" }));
});
app.post("/activity/:aid/resolve", async (req, res) => {
  const a = (await pool.query("UPDATE activity SET resolved_at=now() WHERE id=$1 AND resolved_at IS NULL RETURNING lead_id, kind", [req.params.aid])).rows[0];
  if (a) await log(a.lead_id, "note", `${a.kind === "complaint" ? "Complaint" : "Data request"} marked as resolved`);
  res.redirect("/complaints");
});
app.post("/admin/ips", async (req, res) => {
  const list = String(req.body.staff_ips || "").split(/[\s,]+/).filter(Boolean).slice(0, 50);
  if (list.length && !list.includes(clientIp(req))) return res.redirect("/admin?done=" + encodeURIComponent(`Not saved: the list must include your own address (${clientIp(req)}), or you'd lock yourself out.`));
  await pool.query("INSERT INTO settings(key,value) VALUES('staff_ips',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [list.join(", ") || null]);
  ipList.at = 0;
  res.redirect("/admin?done=" + encodeURIComponent(list.length ? `Staff access limited to ${list.length} address${list.length > 1 ? "es" : ""}.` : "Staff access allowed from anywhere."));
});
app.post("/admin/addresses", async (req, res) => {
  for (const k of ["hmrc_address", "dwp_address"]) await pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [k, clip(req.body[k], 400) || null]);
  res.redirect("/admin?done=" + encodeURIComponent("Postal addresses saved."));
});

/* invoices */
function invoiceText(I, F) {
  const net = Number(I.arrears) - Number(I.deductions || 0), tot = Number(I.fee) + Number(I.vat);
  return `Dear ${I.title || ""} ${I.last_name},\n\nInvoice ${I.invoice_no}, dated ${fmtDate(iso(I.invoice_date))}\n\nDWP has confirmed your State Pension arrears. As agreed, our fee is 30% of the arrears paid to you, plus VAT.\n\nArrears paid to you: ${gbp(net)}\nOur fee (30%): ${gbp(I.fee)}\nVAT (20%): ${gbp(I.vat)}\nTotal due: ${gbp(tot)}\n\nPlease pay by ${fmtDate(iso(I.invoice_due))} (14 days from the invoice date).\n${I.pay_token ? `Pay securely online: ${process.env.PUBLIC_URL || ""}/pay/${I.pay_token}\n` : ""}${F.account_no ? `Bank transfer: ${F.account_name || F.company_name}, sort code ${F.sort_code}, account ${F.account_no}. Please use ${I.invoice_no} as the reference.\n` : ""}You can also pay by cheque payable to ${F.company_name || BRAND}, or by card over the phone on ${F.phone || PHONE}.\n\nIf you need more time, call us and we'll agree a payment plan. There is no fee on the increase to your weekly pension.\n\n${BRAND}`;
}
app.get("/lead/:id/invoice", async (req, res) => {
  const I = await getLead(req.params.id); if (!I || !I.invoice_no) return res.redirect("/lead/" + req.params.id);
  const F = await ES.settings(), net = Number(I.arrears) - Number(I.deductions || 0), tot = Number(I.fee) + Number(I.vat);
  const miss = ["company_name", "address", "vat_no"].filter(k => !F[k]);
  res.send(page("Invoice " + I.invoice_no, `<style>${ES.DOC_CSS}</style>
  ${miss.length ? `<div class="flash noprint" style="background:var(--bad-tint);color:var(--bad)">Add these in Settings before sending: ${miss.map(k => ({ company_name: "company name", address: "registered address", vat_no: "VAT number (a VAT invoice must show it)" })[k]).join(", ")}.</div>` : ""}
  <div class="noprint" style="display:flex;gap:10px;flex-wrap:wrap"><button onclick="window.print()">Print</button>
    <form method="post" action="/lead/${I.id}/invoice-sent"><button class="btn ghost">Mark as sent to client</button></form><a class="btn ghost" href="/lead/${I.id}">Back</a></div>
  <article class="doc"><div style="display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap"><div><div class="doc-brand">${esc(BRAND)}</div><p class="doc-small">${esc(F.company_name || "[company name]")}<br>${esc(F.address || "[address]")}<br>${esc(F.phone || PHONE)} · ${esc(F.email || "")}${F.vat_no ? `<br>VAT number ${esc(F.vat_no)}` : ""}${F.company_no ? `<br>Company number ${esc(F.company_no)}` : ""}</p></div>
    <div style="text-align:right"><h2>Invoice</h2><p class="doc-small">Invoice ${esc(I.invoice_no)}<br>Date ${fmtDate(iso(I.invoice_date))}<br>Due ${fmtDate(iso(I.invoice_due))}<br>Your reference ${I.id}</p></div></div>
  <p>${esc([I.title, I.first_name, I.last_name].filter(Boolean).join(" "))}<br>${esc(I.address || "")}<br>${esc(I.postcode || "")}</p>
  <table class="doc-fields"><tbody>
    <tr><th>State Pension arrears in the DWP letter</th><td>${gbp(I.arrears)}</td></tr>
    ${Number(I.deductions || 0) ? `<tr><th>Kept back by DWP</th><td>−${gbp(I.deductions)}</td></tr>` : ""}
    <tr><th>Arrears paid to you</th><td>${gbp(net)}</td></tr>
    <tr><th>Our fee: 30% of arrears paid to you</th><td>${gbp(I.fee)}</td></tr>
    <tr><th>VAT at 20%</th><td>${gbp(I.vat)}</td></tr>
    <tr><th><b>Total due</b></th><td><b>${gbp(tot)}</b></td></tr></tbody></table>
  <p>There is no fee on the increase to your weekly State Pension. This fee is set out in the client agreement you signed.</p>
  <h3>How to pay by ${fmtDate(iso(I.invoice_due))}</h3>
  <ul>${F.account_no ? `<li>Bank transfer to ${esc(F.account_name || F.company_name)}, ${esc(F.bank_name || "")}, sort code ${esc(F.sort_code)}, account ${esc(F.account_no)}, reference <b>${esc(I.invoice_no)}</b></li>` : `<li>Bank transfer: [add bank details in Settings]</li>`}
  <li>Cheque payable to ${esc(F.company_name || BRAND)}, posted to ${esc(F.address || "[address]")}, with ${esc(I.invoice_no)} on the back</li>
  <li>Card, by calling ${esc(F.phone || PHONE)}, weekdays 9am to 5pm</li></ul>
  <p>If you need more time, please call us and we'll agree a payment plan with you.</p></article>`, { bare: true }));
});
app.post("/lead/:id/invoice-sent", async (req, res) => {
  await pool.query("UPDATE leads SET invoice_sent_at=current_date WHERE id=$1", [req.params.id]);
  await log(req.params.id, "fee", "Invoice sent to client");
  res.redirect("/lead/" + req.params.id + "?ok=1");
});

/* call quality */
async function qaPanel(L) {
  const rows = (await pool.query("SELECT * FROM qa_scores WHERE lead_id=$1 ORDER BY at DESC LIMIT 5", [L.id])).rows;
  return `<details class="panel"><summary style="cursor:pointer"><b>Call quality check</b>${rows.length ? ` <span class="pill ${rows[0].critical_fail ? "bad" : rows[0].score >= 80 ? "good" : ""}">Last: ${rows[0].score}%</span>` : ""}</summary>
    <form method="post" action="/lead/${L.id}/qa" style="display:grid;gap:8px;margin-top:10px">
      <div class="grid2"><label>Agent on the call <input name="agent" value="${esc(L.owner)}"></label><label>Call <select name="call_type"><option value="sales">First call</option><option value="inbound">Inbound</option><option value="followup">Follow-up</option></select></label></div>
      ${QA_ITEMS.map(([k, t, crit]) => `<label style="display:flex;gap:8px;align-items:flex-start;font-weight:500"><input type="checkbox" name="q_${k}" value="1"> ${esc(t)}${crit ? ` <span class="pill bad">Must</span>` : ""}</label>`).join("")}
      <label>Notes <input name="notes" style="width:100%"></label><button>Save score</button></form>
    ${rows.length ? `<table><tbody>${rows.map(r => `<tr><td>${fmtDate(iso(r.at))}</td><td>${esc(r.agent)}</td><td>${r.score}%${r.critical_fail ? ` <span class="pill bad">Critical miss</span>` : ""}</td><td class="muted">${esc(r.notes)}</td></tr>`).join("")}</tbody></table>` : ""}</details>`;
}
app.post("/lead/:id/qa", async (req, res) => {
  const items = Object.fromEntries(QA_ITEMS.map(([k]) => [k, req.body["q_" + k] === "1"]));
  const score = Math.round(Object.values(items).filter(Boolean).length / QA_ITEMS.length * 100);
  const crit = QA_ITEMS.some(([k, , c]) => c && !items[k]);
  await pool.query("INSERT INTO qa_scores(lead_id,agent,call_type,items,score,critical_fail,notes) VALUES($1,$2,$3,$4,$5,$6,$7)", [req.params.id, clip(req.body.agent, 60) || null, clip(req.body.call_type, 20), JSON.stringify(items), score, crit, clip(req.body.notes, 500) || null]);
  await log(req.params.id, "qa", `Call quality: ${score}%${crit ? " with a critical miss: " + QA_ITEMS.filter(([k, , c]) => c && !items[k]).map(x => x[1].split(":")[0]).join("; ") : ""}`);
  res.redirect("/lead/" + req.params.id + "?ok=1");
});
app.get("/qa", async (req, res) => {
  const by = (await pool.query(`SELECT coalesce(agent,'(no name)') AS agent, count(*) AS n, round(avg(score)) AS avg, count(*) FILTER (WHERE critical_fail) AS crit FROM qa_scores WHERE at > now() - interval '30 days' GROUP BY 1 ORDER BY 3`)).rows;
  const misses = (await pool.query(`SELECT items FROM qa_scores WHERE at > now() - interval '30 days'`)).rows;
  const miss = QA_ITEMS.map(([k, t]) => [t, misses.filter(m => m.items && m.items[k] === false).length]).filter(x => x[1]).sort((a, b) => b[1] - a[1]);
  const recent = (await pool.query(`SELECT q.*, l.first_name, l.last_name FROM qa_scores q JOIN leads l ON l.id=q.lead_id WHERE q.critical_fail ORDER BY q.at DESC LIMIT 20`)).rows;
  res.send(page("Call quality", `<h1>Call quality</h1><p class="muted">Scores from the "Call quality check" on each client record, last 30 days. "Must" items are the ones HMRC and consumer law care about most.</p>
  <div class="panel tablewrap"><h2>By agent</h2><table><thead><tr><th>Agent</th><th>Calls scored</th><th>Average</th><th>Critical misses</th></tr></thead><tbody>${by.map(b => `<tr><td>${esc(b.agent)}</td><td>${b.n}</td><td>${b.avg}%</td><td>${Number(b.crit) ? `<span class="pill bad">${b.crit}</span>` : "0"}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No calls scored yet.</td></tr>`}</tbody></table></div>
  <div class="panel"><h2>Most missed</h2>${miss.length ? `<ol>${miss.map(([t, n]) => `<li>${esc(t)}: ${n}</li>`).join("")}</ol>` : `<p class="muted">Nothing missed.</p>`}</div>
  <div class="panel tablewrap"><h2>Recent critical misses</h2><table><tbody>${recent.map(r => `<tr><td>${fmtDate(iso(r.at))}</td><td><a href="/lead/${r.lead_id}">${esc(r.first_name)} ${esc(r.last_name)}</a></td><td>${esc(r.agent)}</td><td>${r.score}%</td><td class="muted">${esc(r.notes)}</td></tr>`).join("") || `<tr><td class="muted">None.</td></tr>`}</tbody></table></div>`, { nav: "qa" }));
});
app.post("/admin/hold", async (req, res) => {
  const v = req.body.on === "1" ? (clip(req.body.reason, 300) || "Waiting for HMRC guidance to HRP agents") : null;
  await pool.query("INSERT INTO settings(key,value) VALUES('hmrc_hold',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [v]);
  res.redirect("/admin?done=" + encodeURIComponent(v ? "HMRC submissions are now on hold." : "HMRC submission hold lifted."));
});

/* management information */
app.get("/reports", async (req, res) => {
  await loadRates();
  const q = async s => (await pool.query(s)).rows;
  const real = "NOT is_test";
  const f = (await q(`SELECT count(*) AS enquiries, count(*) FILTER (WHERE signed_at IS NOT NULL) AS signed, count(*) FILTER (WHERE submitted_at IS NOT NULL) AS submitted,
     count(*) FILTER (WHERE decision_at IS NOT NULL) AS outcome, count(*) FILTER (WHERE invoice_no IS NOT NULL) AS invoiced, count(*) FILTER (WHERE stage='paid') AS paid,
     count(*) FILTER (WHERE kyc='failed') AS kyc_failed, count(*) FILTER (WHERE kyc='escalation') AS kyc_esc, count(*) FILTER (WHERE cb='partner') AS wrong_claimant,
     count(*) FILTER (WHERE stage IN ('resubmit_648','hmrc_invalid','hmrc_agent')) AS hmrc_issues
     FROM leads WHERE ${req.query.test ? "true" : real}`))[0];
  const cyc = (await q(`SELECT round(avg(signed_at - created_at::date)) AS to_sign, round(avg(submitted_at - signed_at)) AS to_submit, round(avg(decision_at - submitted_at)) AS hmrc_wait, round(avg(paid_at - invoice_date)) AS to_pay FROM leads WHERE ${req.query.test ? "true" : real}`))[0];
  const resign = (await q(`SELECT count(DISTINCT lead_id) FILTER (WHERE version > 1) AS resigned, count(DISTINCT lead_id) AS packs FROM sign_requests WHERE kind='pack'`))[0];
  const src = await q(`SELECT coalesce(nullif(split_part(split_part(utm,'utm_source=',2),'&',1),''), source, 'unknown') AS src, count(*) AS n, count(*) FILTER (WHERE signed_at IS NOT NULL) AS signed, count(*) FILTER (WHERE stage='paid') AS paid FROM leads WHERE ${req.query.test ? "true" : real} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
  const money = (await q(`SELECT coalesce(sum(fee+vat) FILTER (WHERE stage IN ('invoiced','payment_plan','fee_review')),0) AS owed, coalesce(sum(fee+vat) FILTER (WHERE stage='paid'),0) AS paid FROM leads WHERE ${req.query.test ? "true" : real}`))[0];
  const pipe = (await q(`SELECT * FROM leads WHERE ${req.query.test ? "true" : real} AND stage <> ALL(${DONE_SQL}) AND invoice_no IS NULL`)).map(estimate).filter(Boolean);
  const forecast = pipe.reduce((a, e) => a + e.amount, 0) * 0.36;
  const comp = (await q(`SELECT kind, count(*) AS n, count(*) FILTER (WHERE resolved_at IS NULL) AS open FROM activity WHERE kind IN ('complaint','data') GROUP BY kind`));
  const pct = (a, b) => Number(b) ? Math.round(Number(a) / Number(b) * 100) + "%" : "–";
  res.send(page("Reports", `<h1>Reports</h1><p class="muted">${req.query.test ? `Including test data. <a href="/reports">Real clients only</a>` : `Real clients only. <a href="/reports?test=1">Include test data</a>`}</p>
  <div class="stats">
    <div class="stat"><b>${f.enquiries}</b><small>Enquiries</small></div><div class="stat"><b>${pct(f.signed, f.enquiries)}</b><small>Enquiry to signed</small></div>
    <div class="stat"><b>${pct(f.paid, f.invoiced)}</b><small>Invoiced to paid</small></div><div class="stat"><b>${gbp(money.owed)}</b><small>Fees owed</small></div>
    <div class="stat"><b>${gbp(money.paid)}</b><small>Fees received</small></div><div class="stat"><b>${gbp(forecast).replace(/\.\d\d$/, "")}</b><small>Fee value of open cases, if every missing year counts (upper limit)</small></div></div>
  <div class="grid2">
  <div class="panel"><h2>Funnel</h2><table><tbody>${[["Enquiries", f.enquiries], ["Signed", f.signed], ["CF411 sent to HMRC", f.submitted], ["Outcome received", f.outcome], ["Invoiced", f.invoiced], ["Paid", f.paid]].map(([k, v], i, a) => `<tr><td>${k}</td><td class="num">${v}</td><td class="muted">${i ? pct(v, a[i - 1][1]) + " of previous" : ""}</td></tr>`).join("")}</tbody></table></div>
  <div class="panel"><h2>Average days</h2><table><tbody><tr><td>Enquiry to signed</td><td class="num">${cyc.to_sign ?? "–"}</td></tr><tr><td>Signed to CF411 sent</td><td class="num">${cyc.to_submit ?? "–"}</td></tr><tr><td>CF411 sent to outcome</td><td class="num">${cyc.hmrc_wait ?? "–"}</td></tr><tr><td>Invoice to paid</td><td class="num">${cyc.to_pay ?? "–"}</td></tr></tbody></table></div>
  <div class="panel"><h2>Quality and risk</h2><table><tbody><tr><td>ID checks failed / escalated</td><td class="num">${f.kyc_failed} / ${f.kyc_esc}</td></tr><tr><td>Packs needing a re-sign</td><td class="num">${resign.resigned} of ${resign.packs}</td></tr>
    <tr><td>HMRC rejections or other-agent issues</td><td class="num">${f.hmrc_issues}</td></tr><tr><td>Wrong claimant (partner got Child Benefit)</td><td class="num">${f.wrong_claimant}</td></tr>
    ${comp.map(c => `<tr><td>${c.kind === "complaint" ? "Complaints" : "Data requests"} (open)</td><td class="num">${c.n} (${c.open})</td></tr>`).join("")}</tbody></table></div>
  ${await (async () => { const fr = await q(`SELECT step, count(DISTINCT sid) AS n FROM funnel_events WHERE at > now() - interval '30 days' GROUP BY step`); const m = Object.fromEntries(fr.map(r => [r.step, Number(r.n)]));
    const order = [["cb", "Child Benefit question"], ["for", "Who it's for"], ["early", "Name and phone"], ["pension", "State Pension"], ["spinfo", "Pension amount and start"], ["born", "Year of birth"], ["kids", "Children"], ["ft", "Work history"], ["status", "Marital status"], ["credit", "Pension Credit"], ["contact", "Contact details"], ["result", "Saw the result"], ["details", "Started 'finish details'"], ["details_done", "Finished details"]];
    const top = m.cb || 0; const stops = fr.filter(r => r.step.startsWith("stop:"));
    return `<div class="panel tablewrap"><h2>Website check: where people stop (last 30 days)</h2><table><thead><tr><th>Step</th><th>People</th><th>Of those who started</th></tr></thead><tbody>${order.filter(([k]) => m[k] !== undefined).map(([k, l]) => `<tr><td>${l}</td><td class="num">${m[k]}</td><td class="num">${top ? Math.round(m[k] / top * 100) + "%" : "–"}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No visits recorded yet.</td></tr>`}
      ${stops.map(r => `<tr><td class="muted">Stopped: ${esc(r.step.slice(5))}</td><td class="num">${r.n}</td><td></td></tr>`).join("")}</tbody></table></div>`; })()}
  <div class="panel tablewrap"><h2>By source</h2><table><thead><tr><th>Source</th><th>Enquiries</th><th>Signed</th><th>Paid</th></tr></thead><tbody>${src.map(r => `<tr><td>${esc(r.src)}</td><td class="num">${r.n}</td><td class="num">${r.signed} (${pct(r.signed, r.n)})</td><td class="num">${r.paid}</td></tr>`).join("")}</tbody></table></div>
  </div>`, { nav: "reports" }));
});
app.post("/admin/rates", async (req, res) => {
  for (const k of ["rate_basic", "rate_nsp"]) { const v = parseFloat(req.body[k]); await pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [k, v > 50 && v < 1000 ? String(v) : null]); }
  RATES.at = 0; res.redirect("/admin?done=" + encodeURIComponent("State Pension rates saved."));
});

/* no-answer cadence: 6 tries over about 10 working days at different times, a text after the second */
const CADENCE = [[0, "Try again this afternoon"], [1, "Try again in the morning"], [2, "Try again in the afternoon"], [4, "Try again early evening, before 5pm"], [7, "Last tries: morning"], [10, "Final try, then close as no contact if no answer"]];
app.post("/lead/:id/call", async (req, res) => {
  const L = await getLeadRow(req.params.id); if (!L) return res.redirect("/");
  const outcome = ["no_answer", "voicemail", "wrong_number", "spoke", "callback"].includes(req.body.outcome) ? req.body.outcome : "no_answer";
  if (outcome === "spoke") {
    await pool.query("UPDATE leads SET last_call_at=now(), stage=CASE WHEN stage='new' THEN 'contacted' ELSE stage END, updated_at=now() WHERE id=$1", [L.id]);
    await log(L.id, "call", "Spoke to the client" + (req.body.note ? ": " + clip(req.body.note, 500) : ""));
    return res.redirect("/lead/" + L.id + "?ok=1");
  }
  if (outcome === "wrong_number") {
    await pool.query("UPDATE leads SET phone_bad=true, last_call_at=now(), next_action='Wrong number: try email, text or the helper; post a letter if nothing else', next_action_date=current_date, updated_at=now() WHERE id=$1", [L.id]);
    await log(L.id, "call", "Wrong number"); return res.redirect("/lead/" + L.id + "?ok=1");
  }
  const n = L.call_attempts + 1, step = CADENCE[Math.min(n, CADENCE.length) - 1];
  let bt = L.book_token; if (!bt) { bt = crypto.randomBytes(18).toString("base64url"); }
  const nextDate = n >= CADENCE.length ? today() : (step[0] === 0 ? today() : (() => { let d = today(); for (let i = 0; i < step[0]; i++) d = nextWorkingDay(d); return d; })());
  await pool.query("UPDATE leads SET call_attempts=$2, last_call_at=now(), book_token=$3, next_action=$4, next_action_date=$5, updated_at=now() WHERE id=$1",
    [L.id, n, bt, n >= CADENCE.length ? "6 calls with no answer: close as no contact, or post a letter" : `Call attempt ${n + 1}: ${(CADENCE[n] || CADENCE[CADENCE.length - 1])[1]}`, nextDate]);
  await log(L.id, "call", `Call attempt ${n}: ${outcome === "voicemail" ? "left a voicemail" : "no answer"}`);
  if (n === 2 || n === 4) await MSG.queue({ ...(await getLeadRow(L.id)) }, "missed_call_" + n, { body: MSG.T.missed_call({ ...(await getLeadRow(L.id)) }) });
  res.redirect("/lead/" + L.id + "?ok=1");
});
/* cases with no activity for longer than their stage normally takes */
const STUCK_DAYS = { Intake: 3, Documents: 7, "ID check": 3, HMRC: 35, DWP: 35, Review: 7, CF411: 10, Outcome: 21, Fees: 21, Hold: 14 };
async function stuckCases() {
  const { rows } = await pool.query(`SELECT l.*, (SELECT max(at) FROM activity a WHERE a.lead_id=l.id) AS last_act FROM leads l WHERE stage <> ALL(${DONE_SQL}) AND NOT partial`);
  return rows.map(r => { const g = STAGE[r.stage]?.group || "Intake", lim = STUCK_DAYS[g] || 14, days = Math.floor((Date.now() - new Date(r.last_act || r.updated_at)) / 86400e3); return { ...r, days, lim, group: g }; })
    .filter(r => r.days > r.lim).sort((a, b) => (b.days - b.lim) - (a.days - a.lim));
}

/* settings: test data */
const FIRST = ["Margaret","Patricia","Susan","Linda","Christine","Janet","Elaine","Carol","Pauline","Barbara","Jean","Sandra","Maureen","Valerie","Brenda","Kathleen","Shirley","Anne","Gillian","Hilary","Lesley","Wendy","Doreen","Rita","Joan","Sheila","Eileen","Marion","Diane","Irene"];
const LAST = ["Thompson","Hughes","Roberts","Walker","Wright","Robinson","Clarke","Wood","Hall","Green","Lewis","Harrison","Baker","Turner","Hill","Cooper","Ward","Morris","Moore","Jackson","Allen","Kelly","Bennett","Holmes","Shaw","Lloyd","Mason","Marshall","Fletcher","Bailey"];
const MAIDEN = ["Price","Kerr","Doyle","Hunt","Pearson","Barker","Gray","Fox","Lane","Webb"];
const NOTES = {
  contacted: ["Spoke to client. Child Benefit paid to her for two children from 1979. Happy to proceed.", "Daughter on the call too. Mum stayed at home 1981 to 1992."],
  qualified: ["Explained the fee, the free GOV.UK route and the 14-day cooling-off. Client wants us to go ahead."],
  pack_sent: ["Fee agreement, 64-8 and DWP authority sent for e-signature. Client asked for a paper copy too, posted."],
  resign: ["Client spotted her maiden name misspelt. New version issued for a fresh signature."],
  signed: ["Pack signed. Electronic ID check started."],
  ni_wait: ["ID check passed. Invited client to share her NI record from her HMRC account (optional)."],
  ni_requested: ["Nothing shared by client after 7 days. Targeted NI request sent to HMRC for the Child Benefit years only."],
  dwp_requested: ["DWP information request sent under the signed letter of authority."],
  preparing: ["HMRC record shows no HRP for 1983 to 1991. DWP confirms pension calculated without it. Claim supported."],
  cf411_sent: ["CF411 prepared and sent to client to check and sign."],
  submitted: ["Signed CF411 sent to HMRC.", "Monthly update texted to client."],
  decision: ["HMRC letter received: 9 HRP years added. Waiting for the DWP arrears breakdown letter."],
  invoiced: ["DWP arrears letter received. Invoice sent, due in 14 days."],
  payment_plan: ["Client asked to spread the fee. Plan agreed: £150 a month by standing order."],
  on_hold: ["Client in hospital. Daughter asked us to pause for a month."],
  paid: ["Fee received in full. Review request sent."],
  closed_none: ["HMRC record already includes HRP for all Child Benefit years. Nothing owed. Client thanked us."],
  closed_withdrawn: ["Client cancelled 6 days after signing. No fee payable."],
  closed_lost: ["Client decided to claim directly with HMRC."],
  resubmit_648: ["HMRC rejected the 64-8: signature date missing. Corrected version signed."],
  uplift_dwp: ["Widowed uplift claim sent to DWP with death certificate details."],
  closed_ineligible: ["Child Benefit was paid to her husband, not her. Explained the partner would need to claim."],
  closed_duplicate: ["Same person as an earlier enquiry from her son. Closed this one."]
};
const PLAN = [["new",4],["contacted",2],["qualified",2],["pack_sent",2],["resign",1],["signed",2],["ni_wait",2],["ni_requested",2],["dwp_requested",2],["preparing",2],["cf411_sent",1],["submitted",4],["decision",2],["invoiced",2],["payment_plan",1],["on_hold",1],["paid",2],["resubmit_648",1],["uplift_dwp",1],["closed_none",1],["closed_withdrawn",1],["closed_lost",1],["closed_ineligible",1],["closed_duplicate",1]];
async function seedTestData() {
  let n = 0; const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1)); const pick = a => a[rnd(0, a.length - 1)];
  const at = id => ORDER.indexOf(id);
  for (const [stage, count] of PLAN) {
    for (let k = 0; k < count; k++) {
      const si = at(stage), closed = stage.startsWith("closed");
      const pos = stage === "on_hold" ? at("dwp_requested") : stage === "paid" ? at("payment_plan") + 1 : stage === "closed_withdrawn" ? at("signed") : closed ? at("qualified") : si;
      const ageDays = stage === "new" ? rnd(0, 2) : stage === "closed_withdrawn" ? rnd(8, 12) : pos <= at("signed") ? rnd(2, 20) : pos <= at("preparing") ? rnd(25, 80) : pos <= at("submitted") ? rnd(60, 240) : rnd(240, 330);
      const created = addDays(today(), -ageDays);
      const fn = FIRST[(n * 7) % FIRST.length], ln = LAST[(n * 11 + 3) % LAST.length];
      const born = rnd(1938, 1958), pension = stage === "closed_none" ? "less" : pick(["less", "less", "less", "unsure"]);
      const kid1 = Math.max(born + rnd(20, 30), rnd(1974, 1982)), kid2 = kid1 + rnd(0, 7);
      const ftc = pick(["no", "no", "some", "unsure"]);
      const fty = ftc === "some" ? [kid1 - 2, kid1 - 1, kid2 + 12, kid2 + 13].filter(y => y >= 1978 && y <= 2009).join(",") || null : null;
      const signed = pos >= at("signed") ? (stage === "closed_withdrawn" ? addDays(today(), -rnd(4, 7)) : addDays(created, rnd(3, 8))) : null;
      const kyc = pos > at("signed") ? "passed" : stage === "signed" ? pick(["pending", "escalation"]) : "pending";
      const submitted = pos >= at("submitted") ? addDays(signed, rnd(30, 60)) : null;
      const decision = pos >= at("decision") ? addDays(submitted, rnd(150, 240)) : null;
      const arrears = decision ? rnd(3200, 24500) + rnd(0, 99) / 100 : null;
      const deductions = arrears && Math.random() < 0.25 ? rnd(150, 900) : null;
      const net = arrears ? arrears - (deductions || 0) : null;
      const fee = net ? Math.round(net * FEE_RATE * 100) / 100 : null, vat = fee ? Math.round(fee * VAT_RATE * 100) / 100 : null;
      const letter = pos >= at("invoiced") || (stage === "decision" && k === 0);
      const invDate = pos >= at("invoiced") ? addDays(decision, rnd(10, 25)) : null;
      const reminders = stage === "invoiced" && invDate && addDays(invDate, PAY_DAYS) < today() ? rnd(1, 2) : 0;
      const paid = stage === "paid" ? addDays(invDate, rnd(5, 13)) : null;
      const sdef = STAGE[stage].next;
      const nextDate = !sdef ? null : stage === "new" ? nextWorkingDay(created) : stage === "invoiced" ? addDays(invDate, PAY_DAYS) : addDays(today(), rnd(-3, 10));
      const partnerUnknown = pos >= at("signed") && Math.random() < 0.2;
      const r = await pool.query(`INSERT INTO leads(created_at,updated_at,stage,source,cb,for_whom,pension,born,marital,credit,title,first_name,last_name,maiden_name,email,phone,best_time,consent,consent_text,next_action,next_action_date,signed_at,submitted_at,decision_at,arrears,fee,vat,invoice_date,invoice_due,paid_at,is_test,
          kid1,kid2,ft,ft_years,kyc,deductions,arrears_letter,reminders,last_reminder,pay_method,plan_note,partner_name,partner_unknown)
        VALUES($1,$1,$2,'test',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,'Test data',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,true,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39) RETURNING id`,
        [created + "T10:" + String(rnd(10, 59)) + ":00Z", stage, pick(["yes", "yes", "yes", "unsure"]), pick(["me", "me", "me", "help", "died"]), pension, born,
         pick(["married", "widowed", "widowed", "divorced", "single"]), pick(["no", "no", "yes", "unsure"]), pick(["Mrs", "Mrs", "Ms", "Miss"]), fn, ln, pick(MAIDEN),
         `${fn.toLowerCase()}.${ln.toLowerCase()}@example.com`, "07700 900" + String(100 + n).slice(-3), pick(["Morning, 9am to 12pm", "Afternoon, 12pm to 5pm", "Any time, 9am to 5pm"]),
         sdef ? sdef[0] : null, nextDate, signed, submitted, decision, arrears, fee, vat, invDate, invDate ? addDays(invDate, PAY_DAYS) : null, paid,
         kid1, kid2, ftc, fty, kyc, deductions, letter, reminders, reminders ? addDays(today(), -rnd(1, 6)) : null,
         stage === "payment_plan" ? "plan" : stage === "paid" ? pick(["transfer", "cheque", "phone"]) : null, stage === "payment_plan" ? "£150 a month by standing order" : null,
         pos >= at("signed") && !partnerUnknown ? pick(["Mr ", "Mr ", "Mr "]) + pick(["John", "David", "Michael", "Peter", "Brian", "Alan"]) + " " + ln : null,
         partnerUnknown ? "Separated in the 1980s, no contact" : null]);
      const id = r.rows[0].id;
      const kidNames = ["Sarah", "James", "Emma", "Daniel", "Claire", "Mark", "Louise", "Paul"];
      const children = [{ name: pick(kidNames) + " " + ln, dob: `${kid1}-03-14`, father: "John " + ln }];
      if (kid2 !== kid1) children.push({ name: pick(kidNames) + " " + ln, dob: `${kid2}-09-02`, father: "John " + ln });
      let hrp = null;
      if (pos >= at("preparing") || stage === "closed_none") {
        hrp = {}; const ftS = new Set(String(fty || "").split(",").map(Number));
        for (let y = Math.max(1978, kid1); y <= Math.min(2009, kid2 + 15); y++) hrp[y] = ftS.has(y) ? "paid" : stage === "closed_none" ? "present" : (y >= Math.max(1978, kid1) + 1 && y <= Math.max(1978, kid1) + 8 ? "missing" : "present");
      }
      const types = ["hrp"].concat(stage === "uplift_dwp" ? ["widowed"] : Math.random() < 0.25 ? ["married"] : []).join(",");
      await pool.query(`UPDATE leads SET children=$2, hrp_years=$3, owner=$4, vulnerable=$5, vulnerable_note=$6, dob=$7, address=$8, postcode=$9, ip=$10, claim_types=$11,
          hmrc_verified=$12, soa_sent_at=$13, dwp_sent_at=$14, utm=$15, partner_death_date=$16 WHERE id=$1`,
        [id, JSON.stringify(children), hrp ? JSON.stringify(hrp) : null, pick(["Sarah", "Tom", "Priya", null]), n % 8 === 3, n % 8 === 3 ? "Hard of hearing: post everything, speak to daughter first" : null,
         `${born}-${String(rnd(1, 12)).padStart(2, "0")}-${String(rnd(1, 28)).padStart(2, "0")}`, `${rnd(2, 98)} ${pick(["Acacia Avenue", "Church Lane", "Park Road", "Mill Street"])}, ${pick(["Stockport", "Cheadle", "Sale", "Bolton"])}`, pick(["SK1 1AA", "SK8 2BB", "M33 3CC", "BL1 4DD"]),
         "203.0.113." + (10 + n), types, pos > at("signed"), pos >= at("ni_requested") && stage !== "dwp_requested" ? addDays(signed, rnd(8, 12)) : null, pos >= at("dwp_requested") ? addDays(signed, rnd(3, 9)) : null,
         pick(["utm_source=facebook&utm_campaign=hrp_women67", "utm_source=google&utm_campaign=hrp_search", null]), stage === "uplift_dwp" ? addDays(today(), -rnd(400, 2000)) : null]);
      await pool.query("INSERT INTO activity(lead_id,at,kind,text) VALUES($1,$2,'created','Test enquiry created')", [id, created + "T10:00:00Z"]);
      if (invDate) await pool.query("UPDATE leads SET invoice_no=$2, invoice_sent_at=$3, pay_token=$4 WHERE id=$1", [id, "MY-" + String(id).padStart(5, "0"), stage === "paid" || k === 0 ? invDate : null, crypto.randomBytes(18).toString("base64url")]);
      if (stage === "paid") await pool.query("INSERT INTO payments(lead_id,at,amount,method,note) VALUES($1,$2,$3,$4,'Test payment')", [id, paid + "T12:00:00Z", Math.round((fee + vat) * 100) / 100, pick(["transfer", "stripe", "gocardless", "cheque"])]);
      if (stage === "payment_plan") await pool.query("UPDATE leads SET plan_amount=150 WHERE id=$1", [id]);
      await pool.query("UPDATE leads SET contact_pref=$2, sanctions=$3, edd_approved_by=$4, sp_start_year=$5 WHERE id=$1", [id, pick(["sms", "whatsapp", "whatsapp", "email", "post"]), pos > at("signed") ? "clear" : null, n % 8 === 3 && pos > at("signed") ? "Priya" : null, born + (born < 1950 ? 60 : 63)]);
      if (n % 3 === 0 && pos >= at("contacted")) { const items = Object.fromEntries(QA_ITEMS.map(([q]) => [q, Math.random() > (q === "benefits" ? 0.5 : 0.12)])); const sc = Math.round(Object.values(items).filter(Boolean).length / QA_ITEMS.length * 100);
        await pool.query("INSERT INTO qa_scores(lead_id,at,agent,call_type,items,score,critical_fail,notes) VALUES($1,$2,$3,'sales',$4,$5,$6,$7)", [id, addDays(created, 1) + "T11:00:00Z", pick(["Sarah", "Tom", "Priya"]), JSON.stringify(items), sc, QA_ITEMS.some(([q, , c]) => c && !items[q]), sc < 80 ? "Rushed the fee explanation" : null]); }
      if (n === 6) await pool.query("INSERT INTO activity(lead_id,at,kind,text) VALUES($1,now() - interval '10 days','complaint','Unhappy about how long HMRC is taking. Wants a call from a manager.')", [id]);
      if (n === 14) await pool.query("INSERT INTO activity(lead_id,at,kind,text) VALUES($1,now() - interval '3 days','data','Daughter asked for a copy of all information we hold on her mother.')", [id]);
      for (const note of (NOTES[stage] || [])) await pool.query("INSERT INTO activity(lead_id,at,kind,text) VALUES($1,$2,'note',$3)", [id, addDays(created, rnd(1, Math.max(1, ageDays))) + "T12:00:00Z", note]);
      n++;
    }
  }
  return n;
}
app.get("/admin", async (req, res) => {
  const c = (await pool.query("SELECT count(*) FILTER (WHERE is_test) AS test, count(*) FILTER (WHERE NOT is_test) AS real FROM leads")).rows[0];
  const host = req.headers.host;
  res.send(page("Settings", `<h1>Settings</h1>
  ${req.query.done ? `<div class="flash">${esc(req.query.done)}</div>` : ""}
  <div class="panel"><h2>Test data</h2>
  <p>There are <b>${c.test}</b> test records and <b>${c.real}</b> real records. Test records are marked "Test" and use example.com emails and 07700 900 phone numbers, which are reserved for fiction.</p>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
  <form method="post" action="/admin/seed"><button>Add ${PLAN.reduce((a, p) => a + p[1], 0)} test clients</button></form>
  <form method="post" action="/admin/clear-test"><button class="btn ghost" style="border-color:var(--bad);color:var(--bad)">Delete all test data</button></form></div></div>
  ${await ES.firmForm()}
  ${await (async () => { const F = await ES.settings(); return `<form class="panel" method="post" action="/admin/addresses"><h2>Postal addresses for HMRC and DWP</h2>
    <p class="muted">Used on cover letters in Post. Check these against GOV.UK before posting.</p>
    <div class="grid2"><label>HMRC (NI records and CF411) <textarea name="hmrc_address" rows="3">${esc(F.hmrc_address || HMRC_ADDR_DEFAULT)}</textarea></label>
    <label>DWP (State Pension information) <textarea name="dwp_address" rows="3">${esc(F.dwp_address || "")}</textarea></label></div><button>Save addresses</button></form>
    <form class="panel" method="post" action="/admin/rates"><h2>State Pension rates for estimates</h2><p class="muted">Used only for the rough value estimates. Check GOV.UK each April.</p>
    <div class="grid2"><label>Full basic State Pension (£ a week) <input name="rate_basic" value="${esc(F.rate_basic || "184.90")}"></label><label>Full new State Pension (£ a week) <input name="rate_nsp" value="${esc(F.rate_nsp || "241.30")}"></label></div><button>Save rates</button></form>
    ${await MSG.waForm()}
    <div class="panel"><h2>Connections</h2><p class="muted">Set these in Render, under this service's Environment tab. Status now:</p><ul>
      <li>Twilio texts: ${process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_SMS_FROM ? "connected" : "<b>not connected</b> (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM)"}</li>
      <li>Twilio WhatsApp: ${process.env.TWILIO_WHATSAPP_FROM ? "connected" : "<b>not connected</b> (TWILIO_WHATSAPP_FROM)"}. Incoming messages webhook: <b>https://${esc(req.headers.host)}/twilio/inbound</b></li>
      <li>Stripe card payments: ${PAY.stripeReady() ? "connected" : "<b>not connected</b> (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)"}. Webhook: <b>https://${esc(req.headers.host)}/stripe/webhook</b> (event checkout.session.completed)</li>
      <li>GoCardless pay by bank: ${PAY.gcReady() ? "connected" : "<b>not connected</b> (GOCARDLESS_ACCESS_TOKEN, GOCARDLESS_WEBHOOK_SECRET, GOCARDLESS_ENV)"}. Webhook: <b>https://${esc(req.headers.host)}/gocardless/webhook</b></li>
      <li>Email (Resend): ${process.env.RESEND_API_KEY ? "connected" : "<b>not connected</b> (RESEND_API_KEY, FROM_EMAIL)"}</li>
      <li>Public address for links in messages: ${process.env.PUBLIC_URL ? esc(process.env.PUBLIC_URL) : "<b>not set</b> (PUBLIC_URL, e.g. https://crm.yourdomain.co.uk)"}</li></ul></div>
    <form class="panel" method="post" action="/admin/hold" style="${F.hmrc_hold ? "border-color:var(--bad)" : ""}"><h2>HMRC submission hold</h2>
    <p class="muted">HMRC told at least one HRP agent not to submit claims until it issues guidance to HRP agents. While the hold is on, NI requests and CF411s can't be marked as posted and cases can't move to "CF411 with HMRC".</p>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="on" value="1" ${F.hmrc_hold ? "checked" : ""}> Hold HMRC submissions</label>
    <label>Reason <input name="reason" value="${esc(F.hmrc_hold || "Waiting for HMRC guidance to HRP agents")}" style="width:100%"></label><button>Save</button></form>
    <form class="panel" method="post" action="/admin/ips"><h2>Staff access by internet address</h2>
    <p class="muted">Leave blank to allow logins from anywhere. Otherwise list the approved addresses, separated by commas. Your address now is <b>${esc(clientIp(req))}</b>; it must be on the list.</p>
    <input name="staff_ips" value="${esc(F.staff_ips || "")}" style="width:100%" placeholder="e.g. 81.2.69.160, 203.0.113.7"><button>Save</button></form>`; })()}
  <div class="panel"><h2>Client progress page</h2>
  <p>Clients can check their claim at <b>https://${esc(host)}/status</b> using their reference number, surname and the last 4 digits of their phone number. Set a custom update for each client on their record; otherwise they see the standard message for their stage.</p></div>`, { nav: "admin" }));
});
app.post("/admin/seed", async (req, res) => { const n = await seedTestData(); res.redirect("/admin?done=" + encodeURIComponent(`Added ${n} test clients.`)); });
app.post("/admin/clear-test", async (req, res) => { const r = await pool.query("DELETE FROM leads WHERE is_test"); res.redirect("/admin?done=" + encodeURIComponent(`Deleted ${r.rowCount} test records.`)); });

/* export */
app.get("/export.csv", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM leads ORDER BY id");
  const cols = ["id", "created_at", "stage", "source", "title", "first_name", "last_name", "maiden_name", "phone", "email", "best_time", "born", "cb", "care", "for_whom", "pension", "marital", "credit", "consent", "next_action", "next_action_date", "signed_at", "submitted_at", "decision_at", "arrears", "fee", "vat", "invoice_date", "invoice_due", "paid_at", "ni_number", "kid1", "kid2", "cb_from", "cb_to", "ft", "ft_years", "kyc", "partner_name", "partner_ni", "partner_unknown", "deductions", "arrears_letter", "reminders", "last_reminder", "pay_method", "plan_note", "dup_of", "is_test", "dob", "address", "postcode"];
  const cell = v => { let s = v instanceof Date ? v.toISOString() : String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="crm-export-${today()}.csv"`);
  res.send([cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n"));
});

app.use((err, req, res, next) => { console.error(err); res.status(500).send(page("Error", `<div class="panel"><h1>Something went wrong</h1><p>${esc(err.message)}</p><a href="/">Back to pipeline</a></div>`)); });
}

(async () => {
  if (pool) { try { await initDb(); console.log("Database ready"); if (ADMIN_PASSWORD) MSG.start(); } catch (e) { console.error("Database setup failed:", e.message); } }
  app.listen(PORT, () => console.log("CRM listening on " + PORT));
})();
