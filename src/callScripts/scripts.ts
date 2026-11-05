// KS_HUBSPOT_GAPS_1_CALL_SCRIPTS - call scripts (playbooks): sections of talking points and questions with answer
// fields, built by an Admin, shown beside the dialler and on a contact or application (Growth and Pro: call_scripts).
//
// A run is one filled-in script for one contact and/or application (and the call, when one is live). Saving keeps the
// answers; finishing puts a readable summary on the contact's timeline and writes the answers of mapped questions to
// their custom fields (each field on its own, so one bad value never loses the others). The run keeps a copy of the
// script as it was, so editing a script later never changes what an old run says.
import { randomUUID } from "node:crypto";
import { listDefinitions, writeRecordValues } from "../customFields/service.js";
import { intakeCallScript } from "./intakeCall.js";
import type { ObjectType } from "../customFields/definitions.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const QUESTION_TYPES = ["text", "long_text", "number", "money", "date", "yes_no", "single_select", "multi_select"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  text: "Short answer", long_text: "Long answer", number: "Number", money: "Money", date: "Date", yes_no: "Yes / no",
  single_select: "Pick one", multi_select: "Pick any",
};
export const USE_FOR = ["any", "calls", "contacts", "applications"] as const;
export type UseFor = (typeof USE_FOR)[number];
export const LIMITS = { sections: 20, questionsPerSection: 30, options: 30, text: 4000 };

export type Question = {
  id: string; label: string; type: QuestionType; options: string[]; required: boolean; help: string;
  /** Write the answer to this custom field when the run is finished. */
  maps_to: { object: "contact" | "application"; field: string } | null;
};
export type Section = { id: string; title: string; body: string; questions: Question[] };
export type Script = {
  id: string; name: string; description: string | null; use_for: UseFor; sections: Section[]; position: number; archived_at: string | null;
  /** KS_ONE_CALL_SCRIPT - the script the dialler opens first (at most one active). */
  dialer_default: boolean;
};

const str = (v: unknown) => String(v ?? "").trim();
const idOf = (v: unknown) => (/^[A-Za-z0-9_-]{1,40}$/.test(str(v)) ? str(v) : randomUUID().slice(0, 8));

/** Checks an edited script. Custom field mappings are checked against the brokerage's fields. */
export async function validateScript(db: Q, raw: any): Promise<{ ok: true; value: Omit<Script, "id" | "position" | "archived_at"> } | { ok: false; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const name = str(raw?.name);
  if (!name) errors.name = "Give the script a name (for example: Intake - term loan).";
  if (name.length > 120) errors.name = "Keep the name under 120 characters.";
  const description = str(raw?.description).slice(0, 500) || null;
  const use_for = (USE_FOR as readonly string[]).includes(str(raw?.use_for)) ? (str(raw?.use_for) as UseFor) : "any";
  const rawSections = Array.isArray(raw?.sections) ? raw.sections : [];
  if (!rawSections.length) errors.sections = "Add at least one section.";
  if (rawSections.length > LIMITS.sections) errors.sections = `A script can have at most ${LIMITS.sections} sections.`;
  const fields: Record<string, Map<string, string>> = {};
  for (const o of ["contact", "application"] as const) {
    fields[o] = new Map((await listDefinitions(db, o as ObjectType)).filter((d) => !d.archived_at).map((d) => [d.name, d.field_type]));
  }
  const seenIds = new Set<string>();
  const sections: Section[] = rawSections.slice(0, LIMITS.sections).map((s: any, si: number) => {
    const title = str(s?.title).slice(0, 120);
    if (!title) errors[`sections.${si}.title`] = "Give the section a title (for example: Opening).";
    const qs = Array.isArray(s?.questions) ? s.questions : [];
    if (qs.length > LIMITS.questionsPerSection) errors[`sections.${si}.questions`] = `A section can have at most ${LIMITS.questionsPerSection} questions.`;
    const questions: Question[] = qs.slice(0, LIMITS.questionsPerSection).map((q: any, qi: number) => {
      const key = `sections.${si}.questions.${qi}`;
      let id = idOf(q?.id);
      while (seenIds.has(id)) id = randomUUID().slice(0, 8);
      seenIds.add(id);
      const label = str(q?.label).slice(0, 300);
      if (!label) errors[`${key}.label`] = "Write the question.";
      const type = (QUESTION_TYPES as readonly string[]).includes(str(q?.type)) ? (str(q?.type) as QuestionType) : "text";
      const options = Array.from(new Set((Array.isArray(q?.options) ? q.options : String(q?.options ?? "").split("\n")).map(str).filter(Boolean))).slice(0, LIMITS.options) as string[];
      if ((type === "single_select" || type === "multi_select") && options.length < 2) errors[`${key}.options`] = "Give at least two choices.";
      let maps_to: Question["maps_to"] = null;
      const m = q?.maps_to;
      if (m && str(m.field)) {
        const object = m.object === "application" ? "application" : "contact";
        if (!fields[object]!.has(str(m.field))) errors[`${key}.maps_to`] = `There is no active ${object} custom field called "${str(m.field)}".`;
        maps_to = { object, field: str(m.field) };
      }
      return { id, label, type, options: type === "single_select" || type === "multi_select" ? options : [], required: q?.required === true, help: str(q?.help).slice(0, 500), maps_to };
    });
    return { id: idOf(s?.id), title, body: str(s?.body).slice(0, LIMITS.text), questions };
  });
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, description, use_for, dialer_default: raw?.dialer_default === true, sections } };
}

/** Starter scripts an Admin can add with one click and then edit (generic intake scripts by product). */
export function starterScripts(): Array<Omit<Script, "id" | "position" | "archived_at">> {
  const q = (label: string, type: QuestionType, options: string[] = [], required = false, help = ""): Question =>
    ({ id: randomUUID().slice(0, 8), label, type, options, required, help, maps_to: null });
  const opening: Section = { id: "opening", title: "Opening", body: "Introduce yourself and the company. Confirm you are speaking with the business owner or someone who can make the decision. Mention that the call may be recorded.", questions: [
    q("Is this a good time to talk for ten minutes?", "yes_no"),
    q("Your role in the business", "single_select", ["Owner", "Partner", "Executive", "Bookkeeper / accountant", "Other"]),
  ] };
  const business: Section = { id: "business", title: "The business", body: "Get the basics lenders ask about first.", questions: [
    q("Months in business", "number", [], true),
    q("Average monthly revenue", "money", [], true, "Ask for the last 3 to 6 months on average."),
    q("Industry", "text"),
    q("Has the business been profitable in the last year?", "yes_no"),
    q("Any open loans, advances or tax arrears?", "long_text", [], false, "List lender, balance and payment if they know them."),
  ] };
  const close: Section = { id: "close", title: "Next steps", body: "Explain the documents needed and how the fee works. Agree on a time to follow up.", questions: [
    q("Owner's estimated credit score", "single_select", ["Under 600", "600-649", "650-699", "700-749", "750 or more", "Not sure"]),
    q("Best time to follow up", "text"),
    q("Notes", "long_text"),
  ] };
  return [
    { ...intakeCallScript(), dialer_default: false }, // KS_ONE_CALL_SCRIPT
    { name: "Intake - term loan", description: "First call with a term loan or working capital lead.", use_for: "any", dialer_default: false, sections: [opening, business,
      { id: "need", title: "The need", body: "Find out how much, what for and how soon.", questions: [
        q("Amount requested", "money", [], true), q("Use of funds", "single_select", ["Working capital", "Expansion", "Inventory", "Refinance debt", "Other"], true),
        q("How soon do they need the money?", "single_select", ["This week", "Within a month", "1-3 months", "Just exploring"]),
      ] }, close] },
    { name: "Intake - line of credit", description: "First call with a line of credit lead.", use_for: "any", dialer_default: false, sections: [opening, business,
      { id: "need", title: "The need", body: "A line is for ongoing needs; confirm it fits better than a term loan.", questions: [
        q("Limit requested", "money", [], true), q("How will they draw on it?", "long_text"),
        q("Do they have receivables lenders could look at?", "yes_no"),
      ] }, close] },
    { name: "Intake - equipment", description: "First call with an equipment financing lead.", use_for: "any", dialer_default: false, sections: [opening, business,
      { id: "equipment", title: "The equipment", body: "Lenders price on the asset: get the details.", questions: [
        q("What is the equipment?", "text", [], true), q("New or used", "single_select", ["New", "Used"], true),
        q("Purchase price", "money", [], true), q("Do they have a quote or invoice from the vendor?", "yes_no"),
        q("Down payment available", "money"),
      ] }, close] },
  ];
}

// ------------------------------------------------------------------ answers
export type Answers = Record<string, unknown>;

/** Keeps answers to questions in the script only, trimmed to sensible sizes. */
export function cleanAnswers(sections: Section[], raw: unknown): Answers {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Answers = {};
  for (const q of sections.flatMap((s) => s.questions)) {
    if (!(q.id in src)) continue;
    const v = src[q.id];
    if (v === null || v === undefined || v === "") continue;
    if (q.type === "multi_select") out[q.id] = (Array.isArray(v) ? v : [v]).map(str).filter((x) => q.options.includes(x));
    else if (q.type === "yes_no") out[q.id] = v === true || v === "true" || v === "yes";
    else if (q.type === "number" || q.type === "money") { const n = Number(String(v).replace(/[$,\s]/g, "")); if (Number.isFinite(n)) out[q.id] = n; }
    else out[q.id] = str(v).slice(0, LIMITS.text);
  }
  return out;
}

/** Required questions without an answer (labels). */
export function missingRequired(sections: Section[], answers: Answers): string[] {
  return sections.flatMap((s) => s.questions).filter((q) => q.required && (answers[q.id] === undefined || (Array.isArray(answers[q.id]) && !(answers[q.id] as unknown[]).length))).map((q) => q.label);
}

export function answerText(q: Question, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (q.type === "yes_no") return v ? "Yes" : "No";
  if (q.type === "money") return Number(v).toLocaleString("en-CA", { style: "currency", currency: "CAD" });
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** The timeline text: each section with its answered questions. */
export function summaryText(sections: Section[], answers: Answers): string {
  const parts: string[] = [];
  for (const s of sections) {
    const lines = s.questions.filter((q) => answers[q.id] !== undefined).map((q) => `${q.label}: ${answerText(q, answers[q.id])}`);
    if (lines.length) parts.push(`${s.title}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n") || "No answers recorded.";
}

/** Writes mapped answers to their custom fields, one field at a time. */
export async function applyMappings(db: Q, sections: Section[], answers: Answers, records: { contactId: string | null; applicationId: string | null }):
  Promise<{ updates: Array<{ object: string; field: string }>; errors: Array<{ object: string; field: string; error: string }> }> {
  const updates: Array<{ object: string; field: string }> = [];
  const errors: Array<{ object: string; field: string; error: string }> = [];
  for (const q of sections.flatMap((s) => s.questions)) {
    if (!q.maps_to || answers[q.id] === undefined) continue;
    const recordId = q.maps_to.object === "contact" ? records.contactId : records.applicationId;
    if (!recordId) { errors.push({ ...q.maps_to, error: `This run has no ${q.maps_to.object} to save "${q.label}" to.` }); continue; }
    const r = await writeRecordValues(db, q.maps_to.object as ObjectType, recordId, { [q.maps_to.field]: answers[q.id] });
    if (r.ok) updates.push({ ...q.maps_to });
    else errors.push({ ...q.maps_to, error: r.errors.map((e) => e.error).join(" ") });
  }
  return { updates, errors };
}

export function rowToScript(r: any): Script {
  return { id: String(r.id), name: r.name, description: r.description ?? null, use_for: r.use_for, sections: Array.isArray(r.sections) ? r.sections : [], position: Number(r.position ?? 0), archived_at: r.archived_at ? new Date(r.archived_at).toISOString() : null, dialer_default: r.dialer_default === true };
}
