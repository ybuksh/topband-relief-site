"use strict";
/* Signing documents. Each is completed in full from the client record and firm settings
   before it can be sent: a missing detail blocks sending (except on test records). */

const FEE_RATE = 0.30, VAT_RATE = 0.20, PAY_DAYS = 14, COOLING_DAYS = 14;

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ukDate = d => d ? new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
const fmtNi = n => n && n.length === 9 ? `${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)} ${n[8]}` : n || "";
const ty = y => `${y}–${String(y + 1).slice(2)}`;

const FIRM_FIELDS = [
  ["company_name", "Company name (the legal entity)"],
  ["company_no", "Company number"],
  ["address", "Registered office address"],
  ["agent_code", "HMRC agent code"],
  ["email", "Contact email"],
  ["phone", "Contact phone"],
  ["vat_no", "VAT registration number (needed on invoices)"],
  ["bank_name", "Bank name (for fee payments)"],
  ["account_name", "Bank account name"],
  ["sort_code", "Sort code"],
  ["account_no", "Account number"]
];

const DOC_TYPES = {
  pack: [
    { key: "agreement", title: "Client agreement and fees", required: true },
    { key: "hmrc", title: "HMRC authority (form 64-8 details)", required: true },
    { key: "dwp", title: "DWP letter of authority", required: true },
    { key: "nirequest", title: "National Insurance record request", required: false }
  ],
  cf411: [{ key: "cf411", title: "Home Responsibilities Protection claim (CF411) declaration", required: true }]
};

/* Build the documents. Returns { docs: [{key,title,html}], missing: [..] } */
function buildDocs(kind, L, F, opts = {}) {
  const missing = [];
  const test = !!L.is_test;
  const need = (v, what) => { if (v == null || String(v).trim() === "") { missing.push(what); return test ? `[TEST: ${what} not set]` : `[${what} missing]`; } return v; };
  const brand = F.trading_name || "Missing Years";
  const firm = {
    name: need(F.company_name, "Firm: company name"), no: need(F.company_no, "Firm: company number"),
    address: need(F.address, "Firm: registered office address"), agent: need(F.agent_code, "Firm: HMRC agent code"),
    email: need(F.email, "Firm: contact email"), phone: need(F.phone, "Firm: contact phone")
  };
  const c = {
    name: need([L.title, L.first_name, L.last_name].filter(Boolean).join(" "), "Client: full name"),
    first: L.first_name || "", last: L.last_name || "",
    dob: need(L.dob ? ukDate(L.dob) : "", "Client: date of birth"),
    address: need(L.address, "Client: address"), postcode: need(L.postcode, "Client: postcode"),
    ni: need(L.ni_number && opts.validNi(L.ni_number) ? fmtNi(L.ni_number) : "", "Client: valid NI number"),
    maiden: L.maiden_name || ""
  };
  if (!L.title || !L.first_name || !L.last_name) missing.includes("Client: full name") || missing.push("Client: full name");
  const prepared = ukDate(new Date().toISOString());
  const head = (title) => `<header class="doc-head"><div class="doc-brand">${esc(brand)}</div><h2>${esc(title)}</h2>
    <p class="doc-meta">Prepared ${esc(prepared)} for ${esc(c.name)} · Client reference ${esc(L.id)}</p>${test ? `<p class="doc-test">TEST DOCUMENT: not for real use</p>` : ""}</header>`;
  const clientBox = `<table class="doc-fields"><tbody>
    <tr><th>Full name</th><td>${esc(c.name)}</td></tr>${c.maiden ? `<tr><th>Previous surname</th><td>${esc(c.maiden)}</td></tr>` : ""}
    <tr><th>Date of birth</th><td>${esc(c.dob)}</td></tr>
    <tr><th>Address</th><td>${esc(c.address)}<br>${esc(c.postcode)}</td></tr>
    <tr><th>National Insurance number</th><td>${esc(c.ni)}</td></tr></tbody></table>`;
  const firmLine = `${esc(brand)} is a trading name of ${esc(firm.name)}, registered in England and Wales, company number ${esc(firm.no)}, registered office ${esc(firm.address)}. HMRC agent code ${esc(firm.agent)}.`;
  const docs = [];
  const want = DOC_TYPES[kind].filter(d => d.required || (opts.include || []).includes(d.key));

  for (const d of want) {
    if (d.key === "agreement") {
      const ex = 2000, ded = 300, net = ex - ded, fee = net * FEE_RATE, vat = fee * VAT_RATE;
      const g = n => "£" + n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      docs.push({ key: d.key, title: d.title, html: `${head(d.title)}
<p>This agreement is between you and ${esc(firm.name)} (trading as ${esc(brand)}, "we" or "us"). Please read it carefully before you sign. If anything is unclear, call us on ${esc(firm.phone)}.</p>
<h3>Your details</h3>${clientBox}
<h3>1. You can do this yourself for free</h3>
<p>You don't have to use us. You can apply to HMRC yourself through GOV.UK, for free, and keep all of any money you're owed. We offer an optional service for people who would rather we did the work.</p>
<h3>2. What we will do</h3>
<ul><li>Look at whether your State Pension may have been underpaid because Home Responsibilities Protection (HRP) is missing from your National Insurance record, and check for other State Pension underpayments, such as increases based on a husband's, wife's or civil partner's record, inherited State Pension, deferred State Pension, National Insurance credit errors and linked Pension Credit.</li>
<li>Ask HMRC for your National Insurance record for the specific tax years that matter, and ask DWP for information about your State Pension, using the authorities you sign with this agreement.</li>
<li>Review that evidence. Only if your HMRC and DWP records together support a claim will we prepare the HRP claim form (CF411). We will send it to you to check and sign before it goes to HMRC.</li>
<li>Send the claim, chase HMRC and DWP, and keep you updated until there is a decision.</li></ul>
<h3>3. What we can't promise</h3>
<p>Receiving Child Benefit does not automatically mean you are owed anything, and it does not mean a claim will be made. Only HMRC and DWP can decide whether your record is corrected and what you are owed. We cannot guarantee any outcome or how long it will take. HRP was given to the person the Child Benefit was paid to.</p>
<h3>4. Our fee</h3>
<ul><li>Our fee is <strong>30% of the backdated arrears paid to you, plus VAT at 20%</strong>, which is 36% in total.</li>
<li>If DWP keeps back part of your arrears, for example to repay a benefit overpayment or other debt, we only charge on the amount actually paid to you.</li>
<li>There is <strong>no fee on any increase to your weekly State Pension</strong>.</li>
<li>If no arrears are paid, you pay nothing. There is nothing to pay upfront.</li></ul>
<table class="doc-fields"><caption>Example</caption><tbody>
<tr><th>Arrears in the DWP letter</th><td>${g(ex)}</td></tr><tr><th>Kept back by DWP to repay a debt</th><td>−${g(ded)}</td></tr>
<tr><th>Paid to you</th><td>${g(net)}</td></tr><tr><th>Our fee (30%)</th><td>${g(fee)}</td></tr><tr><th>VAT (20%)</th><td>${g(vat)}</td></tr>
<tr><th>You keep</th><td><strong>${g(net - fee - vat)}</strong></td></tr></tbody></table>
<h3>5. When and how you pay</h3>
<p>DWP pays any arrears straight to you. We never receive your money. We will only invoice you once DWP has confirmed your arrears, and our invoice will show the DWP figures. Payment is due ${PAY_DAYS} days from the date of the invoice. You can pay by bank transfer, by cheque, or by card over the phone. If you need more time, tell us and we will agree a payment plan with you.</p>
<h3>6. Your right to cancel</h3>
<p>You can cancel this agreement within <strong>${COOLING_DAYS} days</strong> of signing it, for any reason, and you will pay nothing, <strong>even if we have already started work</strong>. To cancel, call us on ${esc(firm.phone)}, email ${esc(firm.email)}, write to us, or use the cancellation form at the end of this agreement.</p>
<p>After the ${COOLING_DAYS} days you can still end this agreement at any time by telling us. If you do, we will only charge our fee if arrears are later paid to you as a result of a claim we had already sent to HMRC for you before you told us.</p>
<h3>7. What we need from you</h3>
<ul><li>Give us accurate information and tell us if anything changes.</li>
<li>Send us, or tell us about, any letter from HMRC or DWP about your National Insurance record or State Pension, especially the DWP letter showing any arrears.</li>
<li>Tell us if you have already claimed, or decide to claim, yourself or through someone else.</li></ul>
<h3>8. Tax and benefits</h3>
<p>Arrears of State Pension count as taxable income. A higher State Pension can reduce means-tested benefits such as Pension Credit or Housing Benefit. We will explain this, and Citizens Advice or Age UK can give free benefits advice.</p>
<h3>9. If you are signing for someone else</h3>
<p>If you are signing as the personal representative of someone who has died, or under a power of attorney, "you" in this agreement means the person or estate you represent, and you confirm you have authority to sign.</p>
<h3>10. Your information</h3>
<p>We use your information to provide this service and to meet our legal duties, including anti-money laundering checks. We share it with HMRC and DWP for your claim, and with an identity checking service to confirm who you are. We keep it for six years after our work ends. You can ask for a copy of your information, or ask us to correct it, at any time. Our privacy notice explains this in full.</p>
<h3>11. Complaints</h3>
<p>If you are unhappy, contact us on ${esc(firm.phone)} or ${esc(firm.email)}. We will acknowledge your complaint within 5 working days and give you our full response within 8 weeks.</p>
<h3>12. Signing</h3>
<p>You can sign this agreement electronically or on paper. Both are equally binding. We fill in every part before you sign and we never change a document after it has been signed. If anything needs correcting, we will send you a new version to sign.</p>
<p class="doc-small">${firmLine}</p>
<div class="doc-cancel"><h3>Cancellation form</h3><p>Complete and return this only if you want to cancel within ${COOLING_DAYS} days of signing.</p>
<p>To ${esc(firm.name)}, ${esc(firm.address)}, ${esc(firm.email)}</p>
<p>I wish to cancel my agreement with ${esc(brand)} (client reference ${esc(L.id)}).</p>
<p>Name: ______________________ Signed: ______________________ Date: __________</p></div>` });
    }
    if (d.key === "hmrc") {
      docs.push({ key: d.key, title: d.title, html: `${head(d.title)}
<p>This gives HMRC your permission to deal with ${esc(firm.name)} (trading as ${esc(brand)}) as your agent. It contains the details asked for on HMRC form 64-8, "Authorising your agent".</p>
<h3>Your details</h3>${clientBox}
<h3>Your agent</h3>
<table class="doc-fields"><tbody><tr><th>Agent name</th><td>${esc(firm.name)} (trading as ${esc(brand)})</td></tr>
<tr><th>Agent address</th><td>${esc(firm.address)}</td></tr><tr><th>HMRC agent code</th><td>${esc(firm.agent)}</td></tr>
<tr><th>Phone</th><td>${esc(firm.phone)}</td></tr></tbody></table>
<h3>What this authority covers</h3>
<p>Your National Insurance contributions and credits, including Home Responsibilities Protection (HRP), and requests for your National Insurance record. It does not cover any other tax.</p>
<h3>Declaration</h3>
<p>I authorise HMRC to deal with the agent named above about the matters described, and to give the agent information about those matters. I understand that this authority stays in place until I cancel it, which I can do at any time by telling HMRC or the agent. I understand that the agent acts for me, not for HMRC, and that HMRC will continue to send some letters to me.</p>
<p class="doc-small">${firmLine}</p>` });
    }
    if (d.key === "dwp") {
      docs.push({ key: d.key, title: d.title, html: `${head(d.title)}
<p>To the Department for Work and Pensions, including the Pension Service and the Future Pension Centre.</p>
<h3>Your details</h3>${clientBox}
<h3>Authority</h3>
<p>I authorise the Department for Work and Pensions to give ${esc(firm.name)} (trading as ${esc(brand)}), ${esc(firm.address)}, information about my State Pension. This includes how my State Pension was worked out; any underpayment and arrears; any amount kept back from arrears and why; increases based on a husband's, wife's or civil partner's National Insurance record, including Category BL; widow's, widower's or inherited State Pension; deferred State Pension; National Insurance credits; and any linked Pension Credit.</p>
<p>I authorise ${esc(brand)} to ask for this information and to discuss my State Pension with you on my behalf.</p>
<p>I understand that DWP will continue to pay any money due to me directly to me, and not to ${esc(brand)}.</p>
<p>This authority lasts for 24 months from the date I sign it, unless I cancel it sooner by telling DWP or ${esc(brand)}.</p>
<p class="doc-small">${firmLine}</p>` });
    }
    if (d.key === "nirequest") {
      const years = opts.years || [];
      if (!years.length) missing.push("NI request: tax years to request");
      docs.push({ key: d.key, title: d.title, html: `${head(d.title)}
<p>To HM Revenue and Customs, National Insurance Contributions and Employer Office.</p>
<h3>Your details</h3>${clientBox}
<h3>Request</h3>
<p>Please provide a statement of my National Insurance contributions and credits, including any Home Responsibilities Protection, for <strong>these tax years only</strong>:</p>
<p class="doc-years">${years.length ? esc(years.map(ty).join(", ")) : esc(test ? "[TEST: tax years not set]" : "[tax years missing]")}</p>
<p>Years in which I worked full time are deliberately left out. Please send the statement to my agent, ${esc(firm.name)} (trading as ${esc(brand)}), ${esc(firm.address)}, agent code ${esc(firm.agent)}, who acts for me under the authority I have signed.</p>
<p class="doc-small">${firmLine}</p>` });
    }
    if (d.key === "cf411") {
      const details = String(opts.claimDetails || "").trim();
      if (!details) missing.push("CF411: claim details (tax years and children)");
      docs.push({ key: d.key, title: d.title, html: `${head(d.title)}
<p>Your HMRC and DWP records show that a claim for Home Responsibilities Protection is supported. These are the details we will put on your claim form (CF411) and send to HMRC. Please check them carefully. If anything is wrong, don't sign: call us on ${esc(firm.phone)} and we will send you a corrected version.</p>
<h3>Your details</h3>${clientBox}
<h3>Details of your claim</h3>
<div class="doc-claim">${details ? esc(details).replace(/\n/g, "<br>") : esc(test ? "[TEST: claim details not set]" : "[claim details missing]")}</div>
<h3>Declaration</h3>
<p>I declare that the information given for this claim is correct and complete to the best of my knowledge and belief. I understand that if I knowingly give false information I may be prosecuted. I ask HMRC to add Home Responsibilities Protection to my National Insurance record for the years shown, and I authorise ${esc(brand)} to send this claim to HMRC for me.</p>
<p class="doc-small">${firmLine}</p>` });
    }
  }
  return { docs, missing: [...new Set(missing)] };
}

/* styles used wherever a document is shown */
const DOC_CSS = `.doc{background:#fff;color:#1b1420;border:1px solid var(--line);border-radius:12px;padding:22px clamp(16px,4vw,32px);font:17px/1.6 Georgia,"Times New Roman",serif}
.doc h2{font-size:1.45rem;margin:.2em 0}.doc h3{font-size:1.1rem;margin:1.2em 0 .3em;font-family:system-ui,sans-serif}
.doc p,.doc ul{margin:.4em 0}.doc li{margin:.25em 0}
.doc-brand{font:700 .85rem system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6B3E75}
.doc-meta,.doc-small{color:#5a5060;font-size:.88rem}.doc-test{background:#FBE6E4;color:#A3302A;font:700 .9rem system-ui,sans-serif;padding:6px 10px;border-radius:6px;display:inline-block}
.doc-fields{border-collapse:collapse;width:100%;margin:.4em 0;font-size:.97rem}.doc-fields th,.doc-fields td{border:1px solid #ddd5e1;padding:7px 10px;text-align:left;vertical-align:top}
.doc-fields th{width:40%;background:#f6f2f7;font-weight:600}.doc-fields caption{text-align:left;font:600 .9rem system-ui,sans-serif;padding:4px 0}
.doc-cancel{border:2px dashed #ddd5e1;border-radius:10px;padding:10px 16px;margin-top:1.2em}
.doc-years,.doc-claim{background:#f6f2f7;border-radius:8px;padding:10px 14px;font-weight:600}
@media print{.noprint{display:none!important}.doc{border:0;padding:0;page-break-after:always}body{background:#fff}}`;

module.exports = { buildDocs, DOC_TYPES, DOC_CSS, FIRM_FIELDS, COOLING_DAYS, ukDate, esc };
