// KS_CLIENT_LANGUAGES_v1 - the client's language (English, French or Spanish).
// The client app sends the chosen language; it is kept on the contact (contacts.preferred_language) so sign-in codes,
// consent wording and client messages can use it. The brokerage chooses which languages it offers its clients
// (licensee setting client_languages, e.g. "en,fr"); English is always offered.

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type ClientLang = "en" | "fr" | "es";
export const CLIENT_LANGS: readonly ClientLang[] = ["en", "fr", "es"];

export function asLang(v: unknown): ClientLang | null {
  const s = String(v ?? "").trim().toLowerCase().slice(0, 2);
  return (CLIENT_LANGS as readonly string[]).includes(s) ? (s as ClientLang) : null;
}

/** "fr, es, xx" -> "en,fr,es" (English first, known languages only, no repeats). */
export function normaliseLanguages(raw: unknown): string {
  const list = (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map(asLang).filter((x): x is ClientLang => Boolean(x));
  return ["en", ...CLIENT_LANGS.filter((l) => l !== "en" && list.includes(l))].join(",");
}

export function offers(clientLanguages: string, l: ClientLang): boolean {
  return normaliseLanguages(clientLanguages).split(",").includes(l);
}

const last10 = (phone: string) => String(phone ?? "").replace(/\D/g, "").slice(-10);

/** Saves the language on every live contact with this mobile number. Returns how many were updated. */
export async function setLanguageForPhone(db: Q, phone: string, l: ClientLang): Promise<number> {
  const p = last10(phone);
  if (p.length !== 10) return 0;
  const r = await db.query(
    `UPDATE contacts SET preferred_language = $2, updated_at = now()
      WHERE merged_into_id IS NULL AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1
        AND coalesce(preferred_language, '') <> $2`,
    [p, l],
  );
  return r.rowCount ?? 0;
}

/** The language saved for this mobile number, else null. */
export async function languageForPhone(db: Q, phone: string): Promise<ClientLang | null> {
  const p = last10(phone);
  if (p.length !== 10) return null;
  const { rows } = await db.query(
    `SELECT preferred_language FROM contacts
      WHERE merged_into_id IS NULL AND preferred_language IS NOT NULL
        AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1
      ORDER BY updated_at DESC LIMIT 1`,
    [p],
  );
  return asLang(rows[0]?.preferred_language);
}

/** Twilio Verify's locale for the sign-in code text (English needs none). */
export function verifyLocale(l: ClientLang | null): string | undefined {
  return l === "fr" ? "fr" : l === "es" ? "es" : undefined;
}

/**
 * The optional "Text me news, tips and offers" wording, in the language the client saw (it is stored with the
 * consent, so it must be the words they agreed to). Keep in step with the client app's Step 6 and its dictionaries.
 */
export function marketingSmsOptinTextIn(l: ClientLang | null, b: string): string {
  if (l === "fr") return `Facultatif : m'envoyer par texto des nouvelles, des conseils et des offres de ${b}. Jusqu'à 4 messages par mois. Des frais de messagerie et de données peuvent s'appliquer. Répondez STOP pour vous désabonner en tout temps. Non requis pour présenter une demande.`;
  if (l === "es") return `Opcional: Envíenme por mensaje de texto noticias, consejos y ofertas de ${b}. Hasta 4 mensajes al mes. Pueden aplicarse tarifas de mensajes y datos. Responda STOP para cancelar en cualquier momento. No es obligatorio para solicitar.`;
  return `Optional: Text me news, tips and offers from ${b}. Up to 4 messages per month. Message and data rates may apply. Reply STOP to opt out at any time. Not required to apply.`;
}

/** The "Text me updates about my application" wording in the language the client saw (stored with the choice). */
export function smsUpdatesConsentTextIn(l: ClientLang | null, english: string): string {
  if (l === "fr") return "M'envoyer des textos sur ma demande : mises à jour de l'état, demandes de documents et rappels de signature. La fréquence des messages varie. Des frais de messagerie et de données peuvent s'appliquer. Répondez STOP pour vous désabonner, HELP pour obtenir de l'aide. Non requis pour présenter une demande.";
  if (l === "es") return "Enviarme mensajes de texto sobre mi solicitud: actualizaciones de estado, solicitudes de documentos y recordatorios de firma. La frecuencia de los mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responda STOP para cancelar, HELP para obtener ayuda. No es obligatorio para solicitar.";
  return english;
}
