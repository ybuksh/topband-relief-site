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
  ["arn", "HMRC Agent Reference Number (ARN)"],
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
    { key: "nirequest", title: "Statement of Account request in support of a CF411 HRP claim", required: false }
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
    email: need(F.email, "Firm: contact email"), phone: need(F.phone, "Firm: contact phone"),
    arn: kind === "pack" ? need(F.arn, "Firm: HMRC Agent Reference Number (ARN)") : (F.arn || "")
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
  const firmLine = `${esc(brand)} is a trading name of ${esc(firm.name)}, registered in England and Wales, company number ${esc(firm.no)}, registered office ${esc(firm.address)}. Registered with HMRC as a tax agent (ARN ${esc(firm.arn)}); not part of, or endorsed by, HMRC or DWP.`;
  const docs = [];
  const want = DOC_TYPES[kind].filter(d => d.required || (opts.include || []).includes(d.key));

  for (const d of want) {
    if (d.key === "agreement") {
      const ex = 2000, ded = 300, net = ex - ded, fee = net * FEE_RATE, vat = fee * VAT_RATE;
      const g = n => "£" + n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      docs.push({ key: d.key, title: d.title, html: `${head(d.title)}
<p>This agreement is between you and ${esc(firm.name)} (trading as ${esc(brand)}, "we" or "us"). Please read it carefully before you sign. If anything is unclear, call us on ${esc(firm.phone)}. We can also post you a paper copy and go through it with you on the phone.</p>
<h3>Your details</h3>${clientBox}
<h3>1. You can do this yourself for free</h3>
<p>You don't have to use us. You can apply to HMRC yourself through GOV.UK, for free, and keep all of any money you're owed. You can also contact HMRC or DWP yourself at any time. We offer an optional service for people who would rather we did the work.</p>
<h3>2. Who we are</h3>
<p>We are an independent company registered with HMRC as a tax agent. We are not part of HMRC, DWP or the government, and we are not endorsed by them. We are not a law firm. We do not act as your attorney, appointee or deputy, and we can never receive your State Pension or arrears: HMRC and DWP do not pay agents, and your authority to HMRC (form 64-8) does not let us receive any payment.</p>
<h3>3. What we will do</h3>
<ul><li>Look at whether your State Pension may have been underpaid because Home Responsibilities Protection (HRP) is missing from your National Insurance record. HRP could apply for tax years between 6 April 1978 and 5 April 2010 when you received Child Benefit for a child under 16, or cared for someone, and were not working full time for the whole tax year.</li>
<li>Check for other State Pension underpayments: National Insurance credit errors; increases based on a husband's, wife's or civil partner's record (including Category BL); widow's, widower's or inherited State Pension; deferred State Pension; and any linked Pension Credit.</li>
<li>Use your answers about your Child Benefit years, children, partner and work history to choose <strong>only the tax years that need checking</strong>. We ask HMRC about those years only, never your whole record from 1978 to 2010. HMRC may contact you directly to confirm you authorised this request.</li>
<li>Ask DWP for information about your State Pension, using the authority you sign with this agreement.</li>
<li>Review the HMRC and DWP evidence together. Only if it supports a claim will we prepare the HRP claim form (CF411). You will see the final completed form and sign it then, not now.</li>
<li>Send the claim, chase HMRC and DWP, and keep you updated until there is a decision.</li></ul>
<h3>4. What we can't promise</h3>
<p>Receiving Child Benefit does not automatically mean you are owed anything, and it does not guarantee that a claim will be made or approved. Only HMRC and DWP can decide whether your record is corrected and what you are owed. We cannot guarantee any outcome or how long it will take; HMRC and DWP currently take several months. HRP was given to the person the Child Benefit was paid to.</p>
<h3>5. Our fee</h3>
<ul><li>Our fee is <strong>30% of the backdated arrears paid to you, plus VAT at 20%</strong>. In total you pay <strong>36% of the arrears you actually receive</strong>.</li>
<li>If DWP keeps back part of your arrears, for example to repay a benefit overpayment or other debt, we only charge on the amount actually paid to you.</li>
<li>There is <strong>no fee on any increase to your weekly State Pension</strong> or Pension Credit.</li>
<li>If no arrears are paid, you pay nothing, even if your National Insurance record is corrected. There is nothing to pay upfront.</li></ul>
<table class="doc-fields"><caption>Example</caption><tbody>
<tr><th>Arrears in the DWP letter</th><td>${g(ex)}</td></tr><tr><th>Kept back by DWP to repay a debt</th><td>−${g(ded)}</td></tr>
<tr><th>Paid to you</th><td>${g(net)}</td></tr><tr><th>Our fee (30%)</th><td>${g(fee)}</td></tr><tr><th>VAT (20%)</th><td>${g(vat)}</td></tr>
<tr><th>You keep</th><td><strong>${g(net - fee - vat)}</strong></td></tr></tbody></table>
<h3>6. When and how you pay</h3>
<p>DWP pays any arrears straight to you. Please tell us within 14 days of receiving arrears and send us the DWP letter showing the amount; a photo is fine. We will only invoice you once the arrears have been confirmed, and the invoice will show the DWP figures and how our fee is worked out. Payment is due ${PAY_DAYS} days from the date of the invoice.</p>
<p>You can pay through a secure online payment link, by bank transfer, by cheque, or by card over the phone. If you can't use email or the internet, we will post everything to you and help by phone. If you need more time, tell us and we will agree a payment plan.</p>
<p>If an invoice isn't paid, we will send reminders and talk to you about options such as a payment plan. Only after that would we send a final written notice, and we would take formal recovery steps only as a last resort, taking account of your circumstances. If you disagree with an invoice, please tell us in writing within 28 days of the invoice date.</p>
<h3>7. Your right to cancel</h3>
<p>Under the Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013 you can cancel this agreement within <strong>${COOLING_DAYS} days</strong> of signing it, for any reason, and you will pay nothing, <strong>even if we have already started work</strong>. We will only start work in those 14 days if you ask us to, and that work never affects our fee. To cancel, call us on ${esc(firm.phone)}, email ${esc(firm.email)}, write to us, reply to any of our messages, or use the cancellation form at the end of this agreement.</p>
<p>After the ${COOLING_DAYS} days you can still end this agreement at any time by telling us. If you do, we will only charge our fee if arrears are later paid to you as a result of a claim we had already sent to HMRC for you before you told us. When this agreement ends, we will confirm in writing where your claim stands.</p>
<h3>8. What we need from you</h3>
<ul><li>Give us accurate information, don't guess anything you're unsure of, and tell us if anything changes, including your address, phone number or email.</li>
<li>Send us, or tell us about, any letter from HMRC or DWP about your National Insurance record or State Pension, especially the DWP letter showing any arrears.</li>
<li>Tell us if anyone else, such as another adviser or company, is already helping you with this, and if you decide to claim yourself.</li></ul>
<p>We may end this agreement if information you give us is untrue or withheld, or if we're asked to do something improper or unlawful. We will tell you in writing and confirm where your claim stands.</p>
<h3>9. Tax and benefits</h3>
<p>Arrears of State Pension count as taxable income. A higher State Pension can reduce means-tested benefits such as Pension Credit or Housing Benefit. We will explain this, and Citizens Advice or Age UK can give free benefits advice.</p>
<h3>10. If you are signing for someone who has died</h3>
<p>If you are signing as the personal representative of someone who has died, "you" in this agreement means their estate, and you confirm you have the authority to sign. We will ask for the death certificate and the grant of probate or letters of administration. If someone holds a power of attorney for you, please tell us before you sign.</p>
<h3>11. Identity checks, contact and your information</h3>
<p>We must confirm who you are before we do any work, using an electronic identity check. This may leave a "soft search" on your credit file, which other lenders can't see and which doesn't affect your credit score. We may contact you about your claim by phone, text, WhatsApp, email and post.</p>
<p>We use your information, including your children's and partner's details and your work history, to provide this service and to meet our legal duties, including anti-money laundering checks. We share it with HMRC and DWP for your claim and with our identity checking, messaging, signing and payment providers. We keep your signed documents, the electronic signing record, identity check results and our case file for six years from the later of the date your claim closes and the date your arrears are paid. You can ask for a copy of your information, or ask us to correct it, at any time. Our privacy notice explains this in full.</p>
<h3>12. Complaints</h3>
<p>If you are unhappy, contact us on ${esc(firm.phone)} or ${esc(firm.email)}. We will acknowledge your complaint within 5 working days and give you our full response within 8 weeks. We won't chase payment while a complaint is open.</p>
<h3>13. Our responsibility</h3>
<p>We will carry out our service with reasonable care and skill. We are not responsible for decisions, mistakes or delays by HMRC or DWP. Nothing in this agreement limits our responsibility where the law does not allow it to be limited. This agreement is governed by the law of England and Wales.</p>
<h3>14. Signing</h3>
<p>You can sign this agreement electronically or on paper. An electronic signature has the same legal effect as a handwritten one. We fill in every part before you sign, and we never change a document after it has been signed. If anything needs correcting, we will send you a new version to sign.</p>
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
<tr><th>Agent address</th><td>${esc(firm.address)}</td></tr><tr><th>Agent Reference Number (ARN)</th><td>${esc(firm.arn)}</td></tr><tr><th>HMRC agent code</th><td>${esc(firm.agent)}</td></tr>
<tr><th>Phone</th><td>${esc(firm.phone)}</td></tr></tbody></table>
<h3>What this authority covers</h3>
<p>Your National Insurance contributions and credits, including Home Responsibilities Protection (HRP), requests for your National Insurance record for specific tax years, and any HRP claim (CF411) you later sign. It does not cover any other tax.</p>
<h3>Declaration</h3>
<p>I authorise HMRC to deal with the agent named above about the matters described, and to give the agent information about those matters. I understand that this authority stays in place until I cancel it, which I can do at any time by telling HMRC or the agent. I understand that the agent acts for me, not for HMRC, that HMRC will continue to send some letters to me, and that this authority does not allow anyone to receive payments on my behalf.</p>
<p class="doc-small">${firmLine}</p>` });
    }
    if (d.key === "dwp") {
      docs.push({ key: d.key, title: d.title, html: `${head(d.title)}
<p>To the Department for Work and Pensions, including the Pension Service and the Future Pension Centre.</p>
<h3>Your details</h3>${clientBox}
<h3>Authority</h3>
<p>I authorise the Department for Work and Pensions to discuss my State Pension with ${esc(firm.name)} (trading as ${esc(brand)}), ${esc(firm.address)}, and to give them information, <strong>only about these matters</strong>:</p>
<ul><li>whether my State Pension was checked or recalculated for missing or wrongly recorded Home Responsibilities Protection, and how many qualifying years and credits were used;</li>
<li>National Insurance credit or qualifying-year corrections affecting my State Pension;</li>
<li>widow's, widower's, surviving spouse's or inherited State Pension;</li>
<li>increases based on a husband's, wife's or civil partner's record, including Category BL;</li>
<li>deferred State Pension, including any extra pension or lump sum;</li>
<li>any Pension Credit award that is affected by the above.</li></ul>
<p>For these matters, DWP may confirm to ${esc(brand)} the outcome, the decision date, the exact arrears or lump sum, the period covered, the revised weekly rate and the payment date, and may deal with ${esc(brand)} on any mandatory reconsideration or appeal about the same matters only.</p>
<h3>What this authority does not do</h3>
<ul><li>It does not allow ${esc(brand)} to receive or redirect any payment, or to change who is paid or the bank account it is paid into. DWP will continue to pay any money due to me directly to me.</li>
<li>It does not make ${esc(brand)} my appointee, attorney or deputy.</li>
<li>It does not allow ${esc(brand)} to ask for information about anything else.</li></ul>
<p>${esc(brand)} may use this information only to deal with these matters, including working out its fee. This authority lasts until ${esc(brand)}'s work on these matters is finished, and no longer than 24 months from the date I sign it. I can cancel it at any time by telling DWP or ${esc(brand)} in writing or by phone.</p>
<p class="doc-small">${firmLine}</p>` });
    }
    if (d.key === "nirequest") {
      const years = opts.years || [], ftY = (opts.ftYears || []);
      if (!years.length) missing.push("NI request: tax years to request");
      docs.push({ key: d.key, title: "Statement of Account request in support of a CF411 HRP claim", html: `${head("Statement of Account request in support of a CF411 Home Responsibilities Protection claim")}
<p>To HM Revenue and Customs, National Insurance Contributions and Employers Office, BX9 1AN.</p>
<h3>Client details</h3>${clientBox}
<h3>Why we are asking</h3>
<p>We act for the client under a signed authority (form 64-8), Agent Reference Number ${esc(firm.arn)}. Before making this request we:</p>
<ul><li>invited the client to share their National Insurance record from their online account; it has not given enough detail for the years below${opts.ptaShared ? " (the client shared their record, but HRP entries for these years are not clear)" : ""};</li>
<li>confirmed the years the client received Child Benefit for a child under 16, or was caring;</li>
<li>confirmed the tax years in which the client worked full time${ftY.length ? ` (${esc(ftY.map(ty).join(", "))})` : ""}, and left those years out;</li>
<li>confirmed the client's marital status and children's details${opts.spYear ? `, and that the client's State Pension started in ${esc(opts.spYear)}` : ""}.</li></ul>
<p><strong>This is not a request for the client's full National Insurance record</strong> or for the whole period from 1978 to 2010.</p>
<h3>Tax years requested</h3>
${years.length ? `<table class="doc-fields"><thead><tr><th>Tax year</th><td><b>Why this year is included</b></td></tr></thead><tbody>${years.map(y => `<tr><th>${ty(y)}</th><td>Child Benefit received for a child under 16; not working full time for the whole tax year</td></tr>`).join("")}</tbody></table>` : `<p class="doc-years">${esc(test ? "[TEST: tax years not set]" : "[tax years missing]")}</p>`}
<h3>Information requested for these years only</h3>
<ul><li>Any Home Responsibilities Protection recorded.</li><li>National Insurance contributions and credits, and whether each year is a qualifying year.</li><li>Where nothing is recorded, confirmation of that, so that we can decide whether a CF411 claim is appropriate.</li></ul>
<p>Please send the statement to ${esc(firm.name)} (trading as ${esc(brand)}), ${esc(firm.address)}.</p>
<h3>Client's consent</h3>
<p>I confirm that I have asked ${esc(brand)} to request this information for the tax years listed above only. I understand it will be used only to decide whether a claim for Home Responsibilities Protection (CF411) should be made for me, and I consent to HMRC sending it to ${esc(brand)}. I understand HMRC may contact me to confirm that I authorised this request.</p>
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
