// KS_SERVER_v10_DEMO - the lender match list for the sample file: every fictional lender scored 0-100 against the
// request, with the reasons in plain words (what fits, what does not).
import { DEMO_LENDERS, type DemoLender } from "./fixture.js";

export type LenderMatch = {
  id: string; name: string; product: string; rate: string; term: string; note: string;
  score: number; fit: "strong" | "possible" | "poor"; reasons: string[]; blockers: string[];
};

export type MatchInput = {
  amount: number; years_in_business: number; annual_revenue: number; province: string; industry: string;
  equipment: boolean; dscr: number | null;
};

const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-CA")}`;

export function scoreLender(l: DemoLender, i: MatchInput): LenderMatch {
  const reasons: string[] = [];
  const blockers: string[] = [];
  let score = 50;
  if (i.amount < l.min_amount || i.amount > l.max_amount) blockers.push(`Lends ${fmt(l.min_amount)} to ${fmt(l.max_amount)}; the request is ${fmt(i.amount)}.`);
  else { score += 10; reasons.push(`The ${fmt(i.amount)} request is inside their ${fmt(l.min_amount)} - ${fmt(l.max_amount)} range.`); }
  if (i.years_in_business < l.min_years) blockers.push(`Needs ${l.min_years}+ years in business; the borrower has ${i.years_in_business}.`);
  else { score += 8; reasons.push(`${i.years_in_business} years in business meets their ${l.min_years}-year minimum.`); }
  if (i.annual_revenue < l.min_revenue) blockers.push(`Needs ${fmt(l.min_revenue)}+ annual revenue; the borrower has ${fmt(i.annual_revenue)}.`);
  else { score += 8; reasons.push(`Revenue of ${fmt(i.annual_revenue)} clears their ${fmt(l.min_revenue)} minimum.`); }
  if (l.provinces !== "all" && !l.provinces.includes(i.province)) blockers.push(`Lends only in ${l.provinces.join(", ")}.`);
  else if (l.provinces !== "all") { score += 4; reasons.push(`Lends in ${i.province}.`); }
  if (i.equipment && l.equipment) { score += 10; reasons.push("Finances equipment, and the request is for equipment."); }
  else if (i.equipment && !l.equipment) { score -= 15; reasons.push("Prefers general-purpose lending, not equipment."); }
  const ind = i.industry.toLowerCase();
  if (l.preferred_industries.some((p) => ind.includes(p))) { score += 8; reasons.push("Likes this industry."); }
  if (l.id === "silverline" && i.dscr != null) {
    if (i.dscr >= 1.25) { score += 4; reasons.push(`Debt service coverage of ${i.dscr.toFixed(2)} meets their 1.25 minimum.`); }
    else blockers.push(`Wants debt service coverage of 1.25; the file shows ${i.dscr.toFixed(2)}.`);
  }
  if (blockers.length) score = Math.min(score, 35) - 5 * (blockers.length - 1);
  score = Math.max(5, Math.min(98, score));
  const fit = blockers.length ? "poor" : score >= 80 ? "strong" : "possible";
  return { id: l.id, name: l.name, product: l.product, rate: l.rate, term: l.term, note: l.note, score, fit, reasons, blockers };
}

export function matchLenders(i: MatchInput): LenderMatch[] {
  return DEMO_LENDERS.map((l) => scoreLender(l, i)).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function lenderIds(): Set<string> {
  return new Set(DEMO_LENDERS.map((l) => l.id));
}
