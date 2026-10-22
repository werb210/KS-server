// KS_SERVER_v10_DEMO - the sample file every demo session starts from. Everything here is fictional: the business,
// the borrower, the bank, the lenders. Phone numbers use the 555-01xx range set aside for fiction.

export const DEMO_STEPS = [
  "welcome",
  "borrower",
  "application",
  "documents",
  "call",
  "financials",
  "credit_summary",
  "lenders",
  "submit",
] as const;
export type DemoStep = (typeof DEMO_STEPS)[number];

export const STEP_LABELS: Record<DemoStep, string> = {
  welcome: "Welcome",
  borrower: "Be the borrower (phone)",
  application: "Application arrives live",
  documents: "Review documents and the fraud check",
  call: "Take the borrower's call",
  financials: "Review the financials",
  credit_summary: "Build the credit summary",
  lenders: "Pick lenders from the match list",
  submit: "Submit to lenders",
};

export function isDemoStep(v: unknown): v is DemoStep {
  return typeof v === "string" && (DEMO_STEPS as readonly string[]).includes(v);
}

export const SAMPLE_BUSINESS = {
  legal_name: "Juniper Hollow Millwork Ltd.",
  operating_name: "Juniper Hollow Millwork",
  industry: "Manufacturing - custom millwork and cabinetry",
  naics: "337110",
  years_in_business: 7,
  started: "2019-04",
  employees: 18,
  province: "AB",
  city: "Edmonton",
  address: "123 Example Street, Edmonton, AB T5J 0A1",
  website: "juniperhollow.example",
  annual_revenue: 2_140_000,
  is_sample: true,
};

export const SAMPLE_CONTACT = {
  name: "Sam Carter",
  title: "Owner and President",
  email: "sam@juniperhollow.example",
  phone: "(780) 555-0142",
  ownership_pct: 100,
  is_sample: true,
};

export const SAMPLE_REQUEST = {
  amount: 250_000,
  product: "Equipment financing",
  purpose: "A new 5x10 CNC router and dust collection, to bring cabinet-door work in-house.",
  term_months: 60,
  equipment_cost: 268_000,
  down_payment: 18_000,
};

export type FinancialYear = {
  year: number; revenue: number; cogs: number; gross_profit: number; operating_expenses: number; ebitda: number;
  depreciation: number; interest: number; net_income: number; total_assets: number; total_liabilities: number;
  equity: number; current_assets: number; current_liabilities: number; existing_debt_service: number;
};

export const SAMPLE_FINANCIALS: { years: FinancialYear[]; prepared_by: string; basis: string } = {
  prepared_by: "Sample accounting firm (fictional)",
  basis: "Review engagement",
  years: [
    {
      year: 2025, revenue: 2_140_000, cogs: 1_305_000, gross_profit: 835_000, operating_expenses: 523_000, ebitda: 312_000,
      depreciation: 61_000, interest: 22_000, net_income: 168_000, total_assets: 1_180_000, total_liabilities: 610_000,
      equity: 570_000, current_assets: 520_000, current_liabilities: 290_000, existing_debt_service: 64_800,
    },
    {
      year: 2024, revenue: 1_860_000, cogs: 1_150_000, gross_profit: 710_000, operating_expenses: 459_000, ebitda: 251_000,
      depreciation: 57_000, interest: 25_000, net_income: 121_000, total_assets: 1_040_000, total_liabilities: 590_000,
      equity: 450_000, current_assets: 455_000, current_liabilities: 275_000, existing_debt_service: 64_800,
    },
  ],
};

/** Monthly payment on an amortising loan. */
export function monthlyPayment(principal: number, annualRatePct: number, months: number): number {
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - (1 + r) ** -months);
}

export const DEMO_BANK = "Prairie Hollow Credit Union";

export type SampleTx = { date: string; description: string; amount: number };
export type SampleStatement = { month: string; label: string; opening: number; tx: SampleTx[] };

const tx = (date: string, description: string, amount: number): SampleTx => ({ date, description, amount });

export const SAMPLE_STATEMENTS: SampleStatement[] = [
  {
    month: "2026-07", label: "July 2026", opening: 84_216.42,
    tx: [
      tx("2026-07-02", "Customer payment - Westfield Homes", 42_300.0),
      tx("2026-07-03", "Payroll", -31_884.12),
      tx("2026-07-07", "Lumber supplier - Aurora Wood Supply", -24_610.55),
      tx("2026-07-09", "Customer payment - Lakeside Builders", 27_950.0),
      tx("2026-07-12", "Equipment loan payment", -5_400.0),
      tx("2026-07-15", "Customer payment - Riverbend Interiors", 36_480.0),
      tx("2026-07-17", "Payroll", -31_902.4),
      tx("2026-07-21", "Hardware and finishes - Northline Supply", -12_288.3),
      tx("2026-07-24", "Customer payment - Westfield Homes", 39_125.0),
      tx("2026-07-28", "Shop rent", -9_500.0),
      tx("2026-07-30", "Customer payment - Kestrel Developments", 31_770.0),
      tx("2026-07-31", "Payroll", -15_960.2),
    ],
  },
  {
    month: "2026-08", label: "August 2026", opening: 0, // filled from July's closing below
    tx: [
      tx("2026-08-04", "Customer payment - Lakeside Builders", 33_640.0),
      tx("2026-08-05", "Payroll", -31_745.18),
      tx("2026-08-08", "Lumber supplier - Aurora Wood Supply", -27_104.9),
      tx("2026-08-11", "Customer payment - Riverbend Interiors", 41_215.0),
      tx("2026-08-12", "Equipment loan payment", -5_400.0),
      tx("2026-08-14", "Customer payment - Westfield Homes", 28_860.0),
      tx("2026-08-19", "Payroll", -31_990.06),
      tx("2026-08-21", "Utilities", -3_412.77),
      tx("2026-08-25", "Customer payment - Kestrel Developments", 44_380.0),
      tx("2026-08-27", "Shop rent", -9_500.0),
      tx("2026-08-29", "Customer payment - Lakeside Builders", 22_910.0),
      tx("2026-08-31", "Payroll", -16_022.5),
    ],
  },
  {
    month: "2026-09", label: "September 2026", opening: 0,
    tx: [
      tx("2026-09-02", "Customer payment - Westfield Homes", 37_420.0),
      tx("2026-09-03", "Payroll", -31_812.33),
      tx("2026-09-08", "Lumber supplier - Aurora Wood Supply", -25_870.12),
      tx("2026-09-10", "Customer payment - Lakeside Builders", 18_450.0),
      tx("2026-09-12", "Equipment loan payment", -5_400.0),
      tx("2026-09-15", "Customer payment - Riverbend Interiors", 39_905.0),
      tx("2026-09-16", "Payroll", -31_876.9),
      tx("2026-09-22", "Hardware and finishes - Northline Supply", -11_940.48),
      tx("2026-09-24", "Customer payment - Kestrel Developments", 35_660.0),
      tx("2026-09-28", "Shop rent", -9_500.0),
      tx("2026-09-29", "Customer payment - Westfield Homes", 29_315.0),
      tx("2026-09-30", "Payroll", -16_011.75),
    ],
  },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

// Openings chain from the previous month's closing.
for (let i = 1; i < SAMPLE_STATEMENTS.length; i++) {
  const prev = SAMPLE_STATEMENTS[i - 1]!;
  SAMPLE_STATEMENTS[i]!.opening = round2(prev.opening + prev.tx.reduce((a, t) => a + t.amount, 0));
}

/** The edit on the doctored statement: September's Lakeside Builders deposit is printed as 48,450.00 (it was 18,450.00). */
export const DOCTORED = { month: "2026-09", date: "2026-09-10", real: 18_450.0, shown: 48_450.0 };

export type SampleDoc = {
  key: string;
  label: string;
  category: string;
  filename: string;
  /** What the borrower sees next to it on the phone. */
  hint: string;
};

export const SAMPLE_DOCS: SampleDoc[] = [
  { key: "bank_2026_07", label: "Bank statement - July 2026", category: "bank_statement", filename: "Bank-Statement-2026-07-SAMPLE.pdf", hint: "Business chequing" },
  { key: "bank_2026_08", label: "Bank statement - August 2026", category: "bank_statement", filename: "Bank-Statement-2026-08-SAMPLE.pdf", hint: "Business chequing" },
  { key: "bank_2026_09", label: "Bank statement - September 2026", category: "bank_statement", filename: "Bank-Statement-2026-09-SAMPLE.pdf", hint: "Business chequing" },
  { key: "financials_2025", label: "Financial statements - FY2025", category: "accountant_financials", filename: "Financials-FY2025-SAMPLE.pdf", hint: "Prepared by the accountant" },
  { key: "void_cheque", label: "Void cheque", category: "void_cheque", filename: "Void-Cheque-SAMPLE.pdf", hint: "For the lender's payments" },
  { key: "photo_id", label: "Photo ID (placeholder)", category: "photo_id", filename: "Photo-ID-PLACEHOLDER-SAMPLE.pdf", hint: "A placeholder - not a real ID" },
];

export function sampleDoc(key: unknown): SampleDoc | null {
  return SAMPLE_DOCS.find((d) => d.key === key) ?? null;
}

export type DemoLender = {
  id: string; name: string; product: string; min_amount: number; max_amount: number; min_years: number;
  min_revenue: number; provinces: string[] | "all"; equipment: boolean; rate: string; term: string;
  preferred_industries: string[]; note: string;
};

/** Fictional lenders. None of these is a real company. */
export const DEMO_LENDERS: DemoLender[] = [
  { id: "aspen-ridge", name: "Aspen Ridge Capital", product: "Equipment finance", min_amount: 50_000, max_amount: 1_500_000, min_years: 2, min_revenue: 500_000, provinces: "all", equipment: true, rate: "7.9% - 11.5%", term: "24 - 72 months", preferred_industries: ["manufacturing", "construction", "transportation"], note: "Fast credit decisions on new equipment." },
  { id: "northgate", name: "Northgate Equipment Finance", product: "Equipment lease", min_amount: 25_000, max_amount: 500_000, min_years: 1, min_revenue: 250_000, provinces: "all", equipment: true, rate: "8.5% - 13.0%", term: "24 - 60 months", preferred_industries: ["manufacturing", "woodworking"], note: "Specialises in shop machinery." },
  { id: "granite-peak", name: "Granite Peak Credit Union", product: "Term and equipment loans", min_amount: 50_000, max_amount: 750_000, min_years: 2, min_revenue: 750_000, provinces: ["AB", "BC", "SK"], equipment: true, rate: "7.2% - 9.9%", term: "36 - 84 months", preferred_industries: [], note: "Western Canada only; likes owner-operated firms." },
  { id: "silverline", name: "Silverline Commercial Lending", product: "Senior term loan", min_amount: 100_000, max_amount: 5_000_000, min_years: 3, min_revenue: 1_000_000, provinces: "all", equipment: false, rate: "6.9% - 9.5%", term: "36 - 120 months", preferred_industries: [], note: "Wants a debt service coverage of 1.25 or better." },
  { id: "cobalt-bay", name: "Cobalt Bay Funding", product: "Revenue-based advance", min_amount: 10_000, max_amount: 300_000, min_years: 0.5, min_revenue: 120_000, provinces: "all", equipment: false, rate: "Factor 1.25 - 1.45", term: "6 - 18 months", preferred_industries: [], note: "Short-term working capital, not equipment." },
  { id: "harbourline", name: "Harbourline Asset Finance", product: "Large-ticket equipment", min_amount: 250_000, max_amount: 10_000_000, min_years: 5, min_revenue: 5_000_000, provinces: "all", equipment: true, rate: "6.5% - 8.9%", term: "36 - 96 months", preferred_industries: [], note: "Mid-market and larger companies." },
];

export type CallLine = { at: number; speaker: "borrower" | "broker"; text: string };

/** The scripted call: the borrower phones the broker mid-way through the file. About 40 seconds. */
export const CALL_SCRIPT: CallLine[] = [
  { at: 0, speaker: "broker", text: "Hi Sam, thanks for calling. I have your file open in front of me." },
  { at: 4, speaker: "borrower", text: "Great. I just sent the bank statements and the financials from my phone. Did they come through?" },
  { at: 10, speaker: "broker", text: "They did. One thing - the September statement doesn't add up on our end. Where did that copy come from?" },
  { at: 17, speaker: "borrower", text: "Oh, my bookkeeper put that one together for me. I can download it straight from the credit union instead." },
  { at: 24, speaker: "broker", text: "Please do - lenders only take the original from the bank. How soon do you need the router?" },
  { at: 30, speaker: "borrower", text: "The supplier is holding it until the end of next month, so a few weeks is fine." },
  { at: 35, speaker: "broker", text: "Perfect. Send the original September statement and I'll get the file to lenders this week." },
];

export const CALL_SUMMARY = {
  headline: "Borrower called about document status; September statement to be replaced with the bank original.",
  points: [
    "Sam confirmed the bank statements and FY2025 financials were sent from the phone.",
    "The September 2026 statement was put together by the bookkeeper, not downloaded from the bank. The fraud check flagged it.",
    "Sam will download the original September statement from the credit union.",
    "Timing: the equipment supplier is holding the CNC router until the end of next month.",
  ],
  follow_up: "Task: request the original September 2026 statement from Sam (due in 2 days).",
  sentiment: "Cooperative",
};

export const DEMO_DURATION_SECONDS = 42;
