"use strict";
/* Builds the customer-facing policy pages (terms, privacy, fees, FAQ) into public/.
   Company details live here only; change them and run: node scripts/build-pages.js */
const fs = require("fs"), path = require("path");

const FIRM = {
  brand: "Every Penny Back",
  company: "Tax Magpie Ltd",
  number: "14851288",
  office: "56 Thornbury Road, Stretford, Manchester M32 0QE",
  arn: "WARN0051407",
  ico: "registration number ZC294690",
  aml: "application XBML00000226112 being processed",
  vat: "GB 445 9515 68",
  email: "hello@everypennyback.co.uk",
  complaints: "complaints@everypennyback.co.uk",
  privacy: "privacy@everypennyback.co.uk",
  phone: "0161 399 2916",
  updated: "November 2026",
  version: "v1.0"
};
const F = FIRM;

const css = `:root{--bg:#FBFAFC;--paper:#fff;--ink:#221A26;--muted:#4A4150;--line:#DDD5E1;--accent:#6B3E75;--tint:#F0E7F3;--display:"Literata",Georgia,serif;--body:"Source Sans 3","Segoe UI",Verdana,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151018;--paper:#1E1722;--ink:#F1EBF3;--muted:#B7AABD;--line:#3A2F40;--accent:#C99BD4;--tint:#33243A;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#151018;--paper:#1E1722;--ink:#F1EBF3;--muted:#B7AABD;--line:#3A2F40;--accent:#C99BD4;--tint:#33243A;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:19px/1.6 var(--body);padding:0 16px}
.wrap{max-width:760px;margin:0 auto}header{border-bottom:1px solid var(--line);padding:14px 0;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}
.logo{font:700 1.2rem var(--display);color:var(--ink);text-decoration:none}nav a{margin-left:14px;font-size:.95rem}
h1{font:700 clamp(1.9rem,4vw,2.6rem)/1.15 var(--display);margin:32px 0 8px}h2{font:700 1.35rem/1.2 var(--display);margin:30px 0 8px}
p,li{max-width:66ch}a{color:var(--accent)}.meta{color:var(--muted);font-size:.95rem}
.box{background:var(--tint);border-radius:12px;padding:14px 18px;margin:18px 0}
table{border-collapse:collapse;width:100%;margin:10px 0}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--tint)}
footer{border-top:1px solid var(--line);margin-top:40px;padding:24px 0 48px;color:var(--muted);font-size:.9rem}
@media (max-width:560px){nav a{margin:0 12px 0 0}}`;

const firmLine = `${F.brand} is a trading name of ${F.company}, registered in England and Wales, company number ${F.number}, registered office ${F.office}. Registered with HMRC as a tax agent (Agent Reference Number ${F.arn}). Anti-money laundering supervision by HMRC (${F.aml}). Registered with the Information Commissioner's Office (${F.ico}). VAT number ${F.vat}. We are not part of, or endorsed by, HMRC, DWP or the government.`;

const page = (file, title, intro, body) => `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${title} | ${F.brand}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&family=Literata:opsz,wght@7..72,700&display=swap">
<style>${css}</style></head><body><div class="wrap">
<header><a class="logo" href="/">${F.brand}</a><nav><a href="/fees.html">Fees</a><a href="/faq.html">FAQ</a><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a></nav></header>
<main><h1>${title}</h1><p class="meta">${F.version} · Last updated ${F.updated}</p>${intro}${body}</main>
<footer><p>${firmLine}</p><p>Contact us: ${F.phone} · <a href="mailto:${F.email}">${F.email}</a></p></footer>
</div></body></html>`;

const free = `<div class="box"><p><b>You can do this yourself for free.</b> You can apply to HMRC yourself through GOV.UK and keep all of any money you're owed. You can also contact HMRC or DWP yourself at any time. Our service is optional.</p></div>`;

const pages = {
"fees.html": ["Our fees", free, `
<h2>What we charge</h2>
<ul><li>Our fee is <b>30% of the backdated arrears actually paid to you, plus VAT at 20%</b>. In total you pay <b>36%</b> of the arrears you receive.</li>
<li>There is <b>no fee on any increase to your weekly State Pension</b> or Pension Credit.</li>
<li>If DWP keeps back part of your arrears, for example to repay a benefit overpayment, we only charge on the amount actually paid to you.</li>
<li>If no arrears are paid, you pay nothing, even if your National Insurance record is corrected. There is nothing to pay upfront.</li></ul>
<table><caption style="text-align:left;font-weight:600;padding:4px 0">Example</caption><tbody>
<tr><th>Arrears in the DWP letter</th><td>£2,000.00</td></tr><tr><th>Kept back by DWP to repay a debt</th><td>−£300.00</td></tr>
<tr><th>Paid to you</th><td>£1,700.00</td></tr><tr><th>Our fee (30%)</th><td>£510.00</td></tr><tr><th>VAT (20% of our fee)</th><td>£102.00</td></tr>
<tr><th>You keep</th><td><b>£1,088.00</b></td></tr></tbody></table>
<h2>When you pay</h2>
<p>DWP pays any arrears straight to you; we never receive your pension or arrears. Please tell us within 14 days of receiving arrears and send us the DWP letter showing the amount (a photo is fine). We only invoice you once the arrears have been confirmed. The invoice shows the DWP figures and how the fee is worked out, and <b>payment is due 14 days from the invoice date</b>.</p>
<h2>How you can pay</h2>
<ul><li>Secure online payment link (card or bank)</li><li>Bank transfer</li><li>Card over the phone</li><li>Cheque by post</li><li>A payment plan if you need more time: just ask</li></ul>
<p>If you don't use email or the internet, we post everything to you and help by phone.</p>
<h2>Cancelling</h2>
<p>You can cancel within <b>14 days</b> of signing for any reason and pay nothing, even if we have already started work. After that you can still end the agreement at any time; we only charge if arrears are later paid as a result of a claim we had already sent to HMRC before you told us.</p>
<h2>If you can't pay or disagree</h2>
<p>If an invoice isn't paid we send reminders and talk to you about options such as a payment plan. Formal recovery is only ever a last resort, taking your circumstances into account. If you disagree with an invoice, tell us within 28 days; we won't chase payment while a complaint is open.</p>`],

"terms.html": ["Terms and conditions", `<p>These terms summarise the agreement you sign with ${F.company} (trading as ${F.brand}). The signed client agreement is the full contract; if anything here differs, the signed agreement applies.</p>${free}`, `
<h2>1. Who we are</h2>
<p>${F.company} is an independent company registered with HMRC as a tax agent. We are not part of HMRC, DWP or the government, and we are not endorsed by them. We are not a law firm. We do not act as your attorney, appointee or deputy and we never sign anything for you.</p>
<h2>2. What we do</h2>
<ul><li>Check whether your State Pension may have been underpaid because Home Responsibilities Protection (HRP) is missing from your National Insurance record, and check for other State Pension underpayments (NI credit errors; increases based on a spouse's or civil partner's record, including Category BL; widow's, widower's or inherited pension; deferred pension; linked Pension Credit).</li>
<li>Use your answers about the years you received Child Benefit, and the years you worked full time, to choose <b>only the tax years that need checking</b>. We ask HMRC about those years only, never your whole record from 1978 to 2010.</li>
<li>Ask DWP for information about your State Pension, using the letter of authority you sign.</li>
<li>Review the HMRC and DWP evidence together. Only if it supports a claim do we prepare the HRP claim form (CF411), which you see in full and sign then, not at the start.</li>
<li>Send the claim, chase HMRC and DWP, and keep you updated until there is a decision.</li></ul>
<h2>3. What we can't promise</h2>
<p>Receiving Child Benefit does not automatically mean you are owed anything, and does not mean a claim will be made. Only HMRC and DWP decide whether your record is corrected and what you are owed. We cannot guarantee an outcome or timescale.</p>
<h2>4. The documents you sign</h2>
<table><thead><tr><th>Document</th><th>When</th></tr></thead><tbody>
<tr><td>Client agreement (these terms and our fees)</td><td>At the start</td></tr>
<tr><td>HMRC form 64-8, authorising us as your agent</td><td>At the start</td></tr>
<tr><td>DWP letter of authority (limited to State Pension matters; does not let us receive any payment)</td><td>At the start</td></tr>
<tr><td>Statement of Account request, listing only the tax years being checked and why</td><td>At the start, where needed</td></tr>
<tr><td>HRP claim (CF411)</td><td>Only later, if the evidence supports a claim</td></tr></tbody></table>
<p>Every document is fully completed before you sign it, and you sign it yourself, electronically or on paper. We never change a signed document; if something needs correcting we send a new version to sign.</p>
<h2>5. Identity checks</h2>
<p>We confirm who you are before any substantive work, using an electronic identity check. This may leave a "soft search" on your credit file, which lenders can't see and which doesn't affect your score.</p>
<h2>6. Fees and payment</h2>
<p>See <a href="/fees.html">our fees</a>: 30% plus VAT (36% in total) of arrears actually paid to you, invoiced only after the arrears are confirmed, payable 14 days from the invoice date. No fee on weekly increases. Nothing to pay if no arrears are paid.</p>
<h2>7. Cancelling</h2>
<p>Under the Consumer Contracts Regulations 2013 you can cancel within 14 days of signing and pay nothing, even if work has started. Call ${F.phone}, email ${F.email}, write to us, or reply to any of our messages.</p>
<h2>8. What we need from you</h2>
<p>Accurate information, letters you receive from HMRC or DWP about your record or pension (especially any arrears letter), and telling us if anyone else is already helping you.</p>
<h2>9. Tax and benefits</h2>
<p>State Pension arrears are taxable income, and a higher State Pension can affect means-tested benefits such as Pension Credit or Housing Benefit. Citizens Advice and Age UK give free benefits advice.</p>
<h2>10. People who have died, and powers of attorney</h2>
<p>A personal representative can claim arrears owed to someone who has died, with the death certificate and grant of probate or letters of administration. If someone holds a power of attorney for you, tell us before you sign.</p>
<h2>11. Complaints</h2>
<p>Contact ${F.phone} or <a href="mailto:${F.complaints}">${F.complaints}</a>. We acknowledge within 5 working days and give a full response within 8 weeks.</p>
<h2>12. Our responsibility and law</h2>
<p>We act with reasonable care and skill. We are not responsible for decisions or delays by HMRC or DWP. Nothing limits our responsibility where the law does not allow it. These terms are governed by the law of England and Wales.</p>`],

"privacy.html": ["Privacy notice", `<p>This explains how ${F.company} (trading as ${F.brand}) uses your personal information. We are the data controller. Contact: <a href="mailto:${F.privacy}">${F.privacy}</a>, ${F.office}.</p>`, `
<h2>What we collect</h2>
<ul><li>Your name, previous names, date of birth, address, phone, email and National Insurance number.</li>
<li>The years you received Child Benefit, your children's names and dates of birth, your caring and work history, and details of your partner or the other parent where you know them.</li>
<li>Identity check results, signed documents and the electronic signing record (signer name, date, time, IP address, device and document fingerprint).</li>
<li>Letters and records from HMRC and DWP about your National Insurance record and State Pension, and payment records for our fee.</li>
<li>If you are helping someone, or acting for someone who has died, your details and your relationship to them.</li></ul>
<h2>Why we use it, and our lawful basis</h2>
<table><thead><tr><th>Purpose</th><th>Lawful basis</th></tr></thead><tbody>
<tr><td>Checking eligibility, requesting evidence from HMRC and DWP, preparing and sending your claim</td><td>Contract with you</td></tr>
<tr><td>Identity, anti-money laundering and fraud checks; keeping records HMRC requires</td><td>Legal obligation</td></tr>
<tr><td>Invoicing and collecting our fee</td><td>Contract with you</td></tr>
<tr><td>Contacting you about your claim by phone, text, WhatsApp, email and post</td><td>Contract with you</td></tr>
<tr><td>Information about your partner, children or someone you are helping</td><td>Our legitimate interest in handling the claim you asked for; we use only what the claim needs</td></tr>
<tr><td>Marketing</td><td>Only with your consent, which you can withdraw at any time</td></tr></tbody></table>
<h2>Who we share it with</h2>
<p>HMRC and DWP, for your claim only; our identity-checking, e-signature, messaging, hosting and payment providers, under contracts that protect your information. We never sell your information or pass it to other companies for their marketing.</p>
<h2>How long we keep it</h2>
<p>Six years from the later of the date your claim closes and the date any arrears are paid, then it is securely deleted. If you only use our online check and don't go ahead, we delete your answers within 12 months.</p>
<h2>Your rights</h2>
<p>You can ask for a copy of your information, ask us to correct or delete it, object to or restrict how we use it, and withdraw consent for marketing. Email <a href="mailto:${F.privacy}">${F.privacy}</a>. If you are unhappy, you can complain to the Information Commissioner's Office at ico.org.uk or on 0303 123 1113.</p>
<h2>Security</h2>
<p>Your information is stored encrypted on UK or EU servers with access limited to staff who need it. Signed documents are sealed so that any change can be detected.</p>`],

"faq.html": ["Questions and answers", free, `
<h2>What is Home Responsibilities Protection (HRP)?</h2>
<p>Between 6 April 1978 and 5 April 2010, HRP protected the State Pension of people who stayed at home to look after a child under 16 or care for someone. It was meant to be added automatically for the person Child Benefit was paid to, but it was sometimes missed.</p>
<h2>Does receiving Child Benefit mean I'm owed money?</h2>
<p>No, not automatically. Many people already have the right HRP, and years you worked full time don't need it. We look at your Child Benefit years, your work history, your National Insurance record and your DWP pension details before deciding whether a claim is supported. If it isn't, we tell you and close the case at no cost.</p>
<h2>Which years do you ask HMRC about?</h2>
<p>Only the tax years in which you received Child Benefit for a child under 16 and did not work full time for the whole year. We list each year and the reason on the request you sign. We never ask for your whole record.</p>
<h2>What about my partner or the other parent?</h2>
<p>We ask for their name, date of birth and National Insurance number if you know them. If you don't, for example after a divorce, separation, bereavement or loss of contact, just say so; we record the reason and review it before any claim is prepared.</p>
<h2>When do I sign the claim form (CF411)?</h2>
<p>Only after we've seen the HMRC and DWP evidence and it supports a claim. You'll see the completed form and sign it yourself before it's sent.</p>
<h2>Do I need to log into my HMRC account?</h2>
<p>No. You can share your National Insurance record from your online account if you want to, which can speed things up, but it's optional.</p>
<h2>Who pays me?</h2>
<p>DWP pays any arrears and increase straight to you. We can never receive your pension or arrears.</p>
<h2>How much does it cost?</h2>
<p>30% plus VAT (36% in total) of the arrears paid to you, invoiced after the arrears are confirmed, with 14 days to pay. No fee on weekly increases, and nothing to pay if no arrears are paid. See <a href="/fees.html">our fees</a>.</p>
<h2>Can I cancel?</h2>
<p>Yes. Within 14 days of signing you pay nothing, even if we've started. After that you can still stop at any time.</p>
<h2>How long does it take?</h2>
<p>HMRC and DWP currently take several months. We chase them and keep you updated.</p>
<h2>Can I claim for a parent who has died?</h2>
<p>Yes, if you are dealing with their estate. We'll ask for the death certificate and the grant of probate or letters of administration.</p>
<h2>Will this affect my benefits or tax?</h2>
<p>Arrears are taxable, and a higher State Pension can reduce means-tested benefits such as Pension Credit. Citizens Advice and Age UK can give free advice.</p>`]
};

const out = path.join(__dirname, "..", "public");
for (const [file, [title, intro, body]] of Object.entries(pages)) fs.writeFileSync(path.join(out, file), page(file, title, intro, body));

/* keep the home page footer in step with the same details */
const idx = path.join(out, "index.html");
let html = fs.readFileSync(idx, "utf8");
html = html.replace(/<!--firm-->[\s\S]*?<!--\/firm-->/, `<!--firm--><p>${firmLine}</p><p><a href="/fees.html">Fees</a> · <a href="/faq.html">FAQ</a> · <a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a></p><!--/firm-->`);
fs.writeFileSync(idx, html);
console.log("built", Object.keys(pages).join(", "));
