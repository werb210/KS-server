// KS_SERVER_v10_DEMO - the borrower's assistant in the demo. With OPENAI_API_KEY set it answers with the model, told
// about the sample file only; without it (or when the model fails) it gives a scripted answer chosen by keywords.
// Questions are capped per session (DEMO_ASSISTANT_LIMIT) and limited to 500 characters.
import { SAMPLE_BUSINESS, SAMPLE_CONTACT, SAMPLE_REQUEST, SAMPLE_DOCS } from "./fixture.js";

export const MAX_QUESTION_CHARS = 500;

const SCRIPTED: Array<{ match: RegExp; answer: string }> = [
  { match: /how long|when|timeline|how soon|fast|quick/i, answer: "Most equipment files like yours get a lender answer in 2 to 4 business days once every document is in. Your broker sends the package as soon as the review is done, and you will get a text when a lender replies." },
  { match: /rate|interest|cost|payment|monthly/i, answer: "For a $250,000 equipment loan over 60 months, the lenders on your file quote roughly 7.2% to 11.5%, which is about $5,000 to $5,500 a month. Your broker will show you each offer side by side before you choose." },
  { match: /document|statement|upload|need|missing|send/i, answer: `Lenders need: ${SAMPLE_DOCS.map((d) => d.label.toLowerCase()).join(", ")}. Bank statements must be the originals downloaded from your bank - an edited or re-typed copy will be flagged.` },
  { match: /credit|score|check|bureau/i, answer: "Your broker does a soft check first, which does not affect your score. A lender only runs a full check after you approve their offer." },
  { match: /safe|secure|privacy|data/i, answer: "Your documents are encrypted and only your broker's team can see them. Lenders receive them only when you agree to send your file." },
  { match: /approve|approval|qualif|chance/i, answer: "With seven years in business, revenue of $2.1M and cash flow that covers the new payment well over two times, your file is a strong fit for equipment lenders." },
];

export function scriptedAnswer(question: string): string {
  const hit = SCRIPTED.find((s) => s.match.test(question));
  return hit?.answer ?? "Good question - your broker will follow up on that. In the meantime, upload any documents still missing so your file can go to lenders.";
}

const SYSTEM_PROMPT = [
  "You are the client assistant in a software DEMO for a commercial lending brokerage.",
  "The person chatting is playing a sample borrower. Everything about the file is fictional sample data:",
  `Business: ${SAMPLE_BUSINESS.legal_name}, ${SAMPLE_BUSINESS.industry}, ${SAMPLE_BUSINESS.years_in_business} years in business, revenue $${SAMPLE_BUSINESS.annual_revenue.toLocaleString("en-CA")}, ${SAMPLE_BUSINESS.city}, ${SAMPLE_BUSINESS.province}.`,
  `Owner: ${SAMPLE_CONTACT.name}. Request: $${SAMPLE_REQUEST.amount.toLocaleString("en-CA")} ${SAMPLE_REQUEST.product.toLowerCase()} over ${SAMPLE_REQUEST.term_months} months for ${SAMPLE_REQUEST.purpose}`,
  `Documents lenders need: ${SAMPLE_DOCS.map((d) => d.label).join(", ")}.`,
  "Answer in two or three short, friendly sentences, as the brokerage's assistant would to a borrower.",
  "Never promise an approval or a specific rate. Never ask for real personal or banking information. Do not discuss anything unrelated to business financing.",
].join("\n");

export type AskModel = (question: string) => Promise<string | null>;

export const askOpenAi: AskModel = async (question) => {
  const key = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return null;
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: key, timeout: 15_000, maxRetries: 0 });
    const r = await client.chat.completions.create({
      model: String(process.env.DEMO_ASSISTANT_MODEL ?? "gpt-4o-mini"),
      max_tokens: 220,
      temperature: 0.3,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: question }],
    });
    const text = r.choices?.[0]?.message?.content?.trim();
    return text ? text.slice(0, 1200) : null;
  } catch (err) {
    console.warn("[demo] assistant model failed; using the scripted answer", err instanceof Error ? err.message : String(err));
    return null;
  }
};

export async function answerQuestion(question: string, ask: AskModel = askOpenAi): Promise<{ answer: string; source: "model" | "scripted" }> {
  const fromModel = await ask(question);
  return fromModel ? { answer: fromModel, source: "model" } : { answer: scriptedAnswer(question), source: "scripted" };
}
