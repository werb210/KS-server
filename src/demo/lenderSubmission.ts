// KS_SERVER_v12_DEMO_REAL_PACKAGE - what a lender receives for the demo's sample file, built by the REAL lender
// submission code, so the prospect gets exactly what their lender would:
//
//   the package    buildApplicationPackage() (src/services/lenders/buildApplicationPackage.ts): one .zip holding
//                  signed-application.pdf, [credit-summary.pdf], application-fields.json, application-fields.pdf and
//                  the accepted documents filed in one folder per document category.
//   the email      lenderEmailSubject() + lenderEmail() (src/services/lenders/lenderEmail.ts), the body Graph sends
//                  (graphMessageBody: the HTML, then the deal owner's signature), and the zip attached as
//                  application-<id>.zip, exactly as dispatchToSelected() + prepareEmailDelivery() send it.
//
// The inputs come from the sample file in the shape loadPackageInputs() reads from a real application: the wizard
// metadata (business / applicant / kyc), the accepted documents named and filed as staff accept them, the application
// PDF the applicant signs (src/signnow/pdfBuilder.ts) with the signature and signing date applied, and the credit summary
// only when the real rule would include it (deals of $500k or more). The fraud pre-screen page is off by default for a
// licensee, so it is not in the package either. The broker in this story is the prospect's own company.
//
// SAMPLE labelling sits only where the real templates have room: a footer line on the signed application's pages. The
// sample documents are themselves watermarked SAMPLE.
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { buildApplicationPackage, type CategoryGroup } from "../services/lenders/buildApplicationPackage.js";
import { lenderEmail, lenderEmailSubject, type LenderEmailDetails } from "../services/lenders/lenderEmail.js";
import { creditSummaryGoesToLenders, packageFields } from "../services/lenders/loadPackageInputs.js";
import { renderPdf as renderCreditSummaryPdf, type ExportDoc } from "../services/credit/creditSummaryExport.js";
import { graphMessageBody } from "../services/email/graphSendService.js";
import { sanitizeDisplayName, suggestedNameParts } from "../services/documents/documentNaming.js";
import { buildApplicationPdf, type ApplicationPdfInputs, type DateAnchor } from "../signnow/pdfBuilder.js";
import { stampSignDate } from "../signnow/stampSignDate.js";
import type { CreditSummary } from "./creditSummary.js";
import type { ApplicationRow } from "./repo.js";

export const SAMPLE_FOOTER = "SAMPLE - fictional business and lenders, made in the Keystone demo. Not a real application.";

/** The real document category each sample is filed under (the folder name in the package). */
export const REAL_CATEGORY: Record<string, string> = {
  bank_statement: "bank_statements_6_months",
  accountant_financials: "financial_statements",
  void_cheque: "void_cheque",
  photo_id: "government_id",
};

export type DemoAcceptedFile = { category: string; label: string; filename: string; content: Buffer; mime_type: string };
export type DemoBroker = { name: string; company: string; email: string };

export type LenderSubmission = {
  /** The package zip, as attached to the lender email. */
  zip: Buffer;
  zipFilename: string;
  entries: string[];
  signedApplicationPdf: Buffer;
  email: { lenderName: string; subject: string; html: string; text: string };
};

const pdfText = (s: unknown) => String(s ?? "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The client wizard's metadata for the sample file (the keys the real application form and package read). */
export function sampleMetadata(app: Pick<ApplicationRow, "business" | "contact" | "request" | "financials">): Record<string, unknown> {
  const b = app.business ?? {}, c = app.contact ?? {}, r = app.request ?? {};
  const [first, ...rest] = String(c.name ?? "").trim().split(/\s+/);
  const street = String(b.address ?? "").split(",")[0]?.trim() || null;
  const postal = String(b.address ?? "").match(/[A-Z]\d[A-Z] ?\d[A-Z]\d/)?.[0] ?? null;
  const revenue = Number(b.annual_revenue ?? app.financials?.years?.[0]?.revenue ?? 0);
  return {
    kyc: {
      lookingFor: "EQUIPMENT",
      businessLocation: "Canada",
      equipmentAmount: Number(r.equipment_cost ?? r.amount),
      fundingAmount: Number(r.amount),
      purposeOfFunds: "Buy New Equipment",
      industry: "Manufacturing",
      yearsInBusiness: Number(b.years_in_business) > 3 ? "Over 3 Years" : "1 to 3 Years",
      annualRevenue: revenue > 3_000_000 ? "Over $3,000,000" : revenue > 1_000_000 ? "$1,000,001 to $3,000,000" : "$500,001 to $1,000,000",
      monthlyRevenue: "$100,000 to $250,000",
      accountsReceivable: "$100,000 to $250,000",
      fixedAssets: "Over $500,000",
      availableCollateral: "The financed equipment",
    },
    business: {
      legalName: b.legal_name ?? null,
      businessName: b.operating_name ?? null,
      businessStructure: "Corporation",
      startDate: b.started ?? null,
      employees: b.employees == null ? null : String(b.employees),
      estimatedRevenue: revenue || null,
      phone: c.phone ?? null,
      website: b.website ?? null,
      address: street,
      city: b.city ?? null,
      state: b.province ?? null,
      zip: postal,
    },
    applicant: {
      firstName: first ?? null,
      lastName: rest.join(" ") || null,
      ownership: c.ownership_pct == null ? null : String(c.ownership_pct),
      email: c.email ?? null,
      phone: c.phone ?? null,
      street,
      city: b.city ?? null,
      state: b.province ?? null,
      zip: postal,
    },
  };
}

/** The application form inputs, read from the metadata the same way loadApplicationForPdf() reads a real application. */
export function sampleApplicationPdfInputs(applicationId: string, app: Pick<ApplicationRow, "business" | "contact" | "request" | "financials">): ApplicationPdfInputs {
  const md = sampleMetadata(app) as { kyc: Record<string, any>; business: Record<string, any>; applicant: Record<string, any> };
  const { kyc, business, applicant } = md;
  const owner = {
    label: "Owner 1", firstName: applicant.firstName, lastName: applicant.lastName, ownership: Number(applicant.ownership ?? 0) || null,
    email: applicant.email, phone: applicant.phone, street: applicant.street, city: applicant.city, province: applicant.state,
    postal: applicant.zip, dob: null, sin: null, creditScore: null,
  };
  return {
    applicationId,
    product: { lookingFor: kyc.lookingFor, category: "EQUIPMENT", amountRequested: kyc.fundingAmount, equipmentValue: kyc.equipmentAmount, location: kyc.businessLocation },
    funding: {
      purposeOfFunds: kyc.purposeOfFunds, industry: kyc.industry, yearsInBusiness: kyc.yearsInBusiness, annualRevenue: kyc.annualRevenue,
      monthlyRevenue: kyc.monthlyRevenue, accountsReceivable: kyc.accountsReceivable, fixedAssets: kyc.fixedAssets, availableCollateral: kyc.availableCollateral,
    },
    business: {
      legalName: business.legalName, dba: business.businessName, structure: business.businessStructure, inBusinessSince: business.startDate,
      employees: business.employees, estimatedRevenue: business.estimatedRevenue, phone: business.phone, website: business.website,
      address: business.address, city: business.city, province: business.state, postal: business.zip,
    },
    owners: [owner],
    applicantEmail: owner.email,
    applicantName: [owner.firstName, owner.lastName].filter(Boolean).join(" ") || null,
  };
}

/**
 * The application the applicant signed: the real application form, with the signature and the signing date where SignNow
 * and stampSignDate() put them, and the SAMPLE footer line.
 */
export async function sampleSignedApplicationPdf(inputs: ApplicationPdfInputs, broker: DemoBroker, signedAt: Date): Promise<Buffer> {
  const out = { dateAnchors: [] as DateAnchor[] };
  const built = await buildApplicationPdf(inputs, out, { brand: { name: broker.company, supportEmail: broker.email } });
  // The signing date, exactly as the package loader stamps it (en-CA, Toronto time).
  const date = signedAt.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  const stamped = await stampSignDate(built, out.dateAnchors, date);
  const doc = await PDFDocument.load(stamped);
  const sig = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  // pdfBuilder's signature box: the date anchor sits 96 pt in from the box's right edge (box width 260) and 26 pt
  // below its top; the SignNow signature field is 4 pt in from the left and 30 pt below the top.
  for (const a of out.dateAnchors) {
    const owner = inputs.owners.find((o) => o.label === a.role) ?? inputs.owners[0];
    const name = [owner?.firstName, owner?.lastName].filter(Boolean).join(" ");
    const page = pages[a.page];
    if (page && name) page.drawText(pdfText(name), { x: a.x - 164 + 4, y: a.y - 4, size: 15, font: sig, color: rgb(0.05, 0.1, 0.3) });
  }
  for (const page of pages) page.drawText(SAMPLE_FOOTER, { x: 42, y: 18, size: 7, font: reg, color: rgb(0.6, 0.08, 0.08) });
  return Buffer.from(await doc.save());
}

/** The credit summary as the real export renders it (only used when the real rule would include it). */
function creditSummaryExport(s: CreditSummary, app: Pick<ApplicationRow, "business" | "contact" | "request" | "financials">): ExportDoc {
  const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const years = (app.financials?.years ?? []) as Array<Record<string, number>>;
  const row = (item: string, pick: (y: Record<string, number>) => number | null) => ({ item, values: years.map(pick) });
  return {
    overview: {
      applicant_name: s.borrower.legal_name, address: app.business?.address ?? null, principals: s.borrower.owner,
      transaction: `${money(s.request.amount)} ${s.request.product}`, facility_request: money(s.request.amount),
      term: `${s.request.term_months} months`, industry: s.borrower.industry, website: app.business?.website ?? null,
    },
    financials: {
      periods: years.map((y) => ({ label: `FY${y.year}` })),
      rows: [
        row("revenue", (y) => y.revenue), row("ebitda", (y) => y.ebitda), row("net_income", (y) => y.net_income),
        row("current_assets", (y) => y.current_assets), row("current_liabilities", (y) => y.current_liabilities),
        row("current_ratio", (y) => (y.current_liabilities ? y.current_assets / y.current_liabilities : null)),
        row("equity", (y) => y.equity), row("debt_to_equity", (y) => (y.equity ? y.total_liabilities / y.equity : null)),
      ],
    },
    equipment: null,
    sections: [
      { key: "transaction", title: "Transaction", text: s.request.purpose },
      { key: "overview", title: "Overview", text: `${s.borrower.legal_name}, ${s.borrower.industry}. ${s.borrower.years_in_business} years in business, ${s.borrower.location}.` },
      { key: "financial_commentary", title: "Financial commentary", text: s.banking.revenue_check },
      { key: "rationale", title: "Rationale", text: "", bullets: s.strengths },
      { key: "risks", title: "Risks", text: "", risks: s.risks.map((risk, i) => ({ risk, mitigant: s.conditions[i] ?? "" })) },
    ],
  };
}

/**
 * Builds what the first selected lender receives for the sample file: the package zip and the email (subject, HTML and
 * text bodies with the broker's signature). The real dispatch sends one such email per selected lender.
 */
export async function buildDemoLenderSubmission(input: {
  applicationId: string;
  app: Pick<ApplicationRow, "business" | "contact" | "request" | "financials">;
  summary: CreditSummary;
  broker: DemoBroker;
  lenderName: string;
  accepted: DemoAcceptedFile[];
  submittedAt: Date;
}): Promise<LenderSubmission> {
  const { applicationId, app, broker } = input;
  const metadata = sampleMetadata(app);
  const fields = packageFields(applicationId, {
    metadata, name: app.business?.legal_name ?? null, requested_amount: Number(app.request?.amount ?? 0) || null,
    product_category: "EQUIPMENT", product_type: app.request?.product ?? null,
  });

  const signedApplicationPdf = await sampleSignedApplicationPdf(sampleApplicationPdfInputs(applicationId, app), broker, input.submittedAt);

  // The credit summary is submitted in the demo; the real rule then decides by amount.
  const creditSummaryPdf = creditSummaryGoesToLenders(Number(app.request?.amount ?? 0), true)
    ? await renderCreditSummaryPdf(creditSummaryExport(input.summary, app), { signedBy: broker.name, phone: null, date: input.submittedAt })
    : null;

  // Accepted documents, named the way staff accept them and filed by category, in the loader's order.
  const groups = new Map<string, Array<{ filename: string; content: Buffer }>>();
  for (const f of input.accepted) {
    const category = REAL_CATEGORY[f.category] ?? f.category;
    // The accept box's "Business - Document type - Period" name, with the period staff type (taken from the label).
    const parts = suggestedNameParts({ businessName: app.business?.legal_name ?? null, category, filename: f.filename });
    const period = f.label.split(" - ")[1]?.trim() || parts.period;
    const filename = sanitizeDisplayName([parts.businessName, parts.documentType, period].filter(Boolean).join(" - "), f.filename) ?? f.filename;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push({ filename, content: f.content });
  }
  const documents: CategoryGroup[] = [...groups.keys()].sort().map((category) => ({
    category,
    files: groups.get(category)!.sort((a, b) => a.filename.localeCompare(b.filename)),
  }));

  const pkg = await buildApplicationPackage({ applicationId, signedApplicationPdf, additionalSignedDocs: [], creditSummaryPdf, fields, documents });

  const field = (label: string) => fields.find((f) => f.label === label)?.value ?? null;
  const amount = Number(field("Requested Amount"));
  const details: Omit<LenderEmailDetails, "lenderName" | "applicationId"> = {
    businessName: field("Application Name") == null ? null : String(field("Application Name")),
    requestedAmount: Number.isFinite(amount) && amount > 0 ? amount : null,
    productCategory: field("Product Category") == null ? null : String(field("Product Category")),
    contents: ["Signed application", ...(creditSummaryPdf ? ["Credit summary"] : []), ...documents.filter((g) => g.files.length > 0).map((g) => g.category)],
  };
  const opts = { brand: broker.company, logoUrl: null };
  const full = { ...details, lenderName: input.lenderName, applicationId };
  const subject = lenderEmailSubject(full, opts);
  const body = lenderEmail(full, { mode: "attached", sizeBytes: pkg.zipBuffer.length }, opts);
  // The deal owner's signature goes after the body (they have not saved one in the demo, so their name and company).
  const signatureHtml = `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px">${escHtml(broker.name)}<br/>${escHtml(broker.company)}</p>`;
  const html = graphMessageBody({ bodyText: body.bodyText, bodyHtml: body.bodyHtml, signatureHtml }).content;
  const text = `${body.bodyText}\n\n${broker.name}\n${broker.company}`;

  return {
    zip: pkg.zipBuffer,
    zipFilename: `application-${applicationId}.zip`,
    entries: pkg.manifest.entries,
    signedApplicationPdf,
    email: { lenderName: input.lenderName, subject, html, text },
  };
}
