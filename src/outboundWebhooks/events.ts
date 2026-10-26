// KS_SERVER_v20_WEBHOOKS - the events an endpoint can subscribe to, and the JSON each delivery carries.
//
// Every delivery is a POST with Content-Type application/json and this body:
//   { "id": "<event id, the same for every endpoint and every retry>", "type": "contact.created",
//     "created_at": "<ISO time of the change>", "data": { "object": { ...the record... }, ...extra } }
// Headers: X-Webhook-Event (type), X-Webhook-Id (event id), X-Webhook-Delivery (this delivery), X-Webhook-Attempt,
// X-Webhook-Timestamp and X-Webhook-Signature (src/outboundWebhooks/signing.ts).
// Receivers should treat the event id as an idempotency key: a delivery can arrive more than once.

export const EVENT_TYPES = [
  "contact.created", "contact.updated", "company.created", "company.updated", "application.created",
  "application.stage_changed", "document.uploaded", "application.signed", "deal.funded", "note.added",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}

type ObjectKind = "contact" | "company" | "application" | "document" | "note";

/** Fields sent for each record type (anything else on the row stays private). Custom fields always go with them. */
export const OBJECT_FIELDS: Record<ObjectKind, readonly string[]> = {
  contact: ["id", "first_name", "last_name", "name", "email", "phone", "secondary_email", "secondary_phone", "job_title",
    "company_id", "company_name", "lead_status", "lifecycle_stage", "status", "role", "tags", "owner_id",
    "address_street", "address_city", "address_state", "address_zip", "address_country", "marketing_opt_out",
    "sms_opt_out", "created_at", "updated_at", "custom_fields"],
  company: ["id", "name", "legal_name", "dba_name", "website", "domain", "email", "phone", "industry", "city", "province",
    "region", "country", "address_street", "address_city", "address_state", "address_zip", "address_country",
    "annual_revenue", "estimated_annual_revenue", "employee_count", "number_of_employees", "types_of_financing", "tags",
    "owner_id", "status", "created_at", "updated_at", "custom_fields"],
  application: ["id", "name", "business_legal_name", "product_type", "product_category", "pipeline_state", "status",
    "requested_amount", "funded_amount", "funded_currency", "funded_at", "lender_id", "lender_product_id", "contact_id",
    "company_id", "owner_user_id", "source", "submitted_at", "signnow_app_signed_at", "created_at", "updated_at", "custom_fields"],
  document: ["id", "application_id", "document_type", "category", "filename", "display_name", "status", "uploaded_by",
    "size_bytes", "created_at"],
  note: ["id", "body", "contact_id", "company_id", "application_id", "owner_id", "created_at"],
};

/** Renamed on the way out so the payload reads plainly. */
const RENAME: Record<string, string> = { pipeline_state: "stage", signnow_app_signed_at: "signed_at" };

export type EventDef = { type: EventType; label: string; object: ObjectKind; description: string };

export const EVENTS: readonly EventDef[] = [
  { type: "contact.created", label: "Contact created", object: "contact", description: "A contact is added: by hand, by the application wizard, an import, a booking or a call." },
  { type: "contact.updated", label: "Contact updated", object: "contact", description: "Any of a contact's details or custom fields change." },
  { type: "company.created", label: "Company created", object: "company", description: "A company is added." },
  { type: "company.updated", label: "Company updated", object: "company", description: "Any of a company's details or custom fields change." },
  { type: "application.created", label: "Application created", object: "application", description: "A new application is started (wizard, staff, import or broker)." },
  { type: "application.stage_changed", label: "Stage changed", object: "application", description: "An application moves to another pipeline stage. data.from_stage and data.to_stage say where from and to." },
  { type: "document.uploaded", label: "Document uploaded", object: "document", description: "A document is added to an application. The file itself is not sent." },
  { type: "application.signed", label: "Application signed", object: "application", description: "The client signs the application." },
  { type: "deal.funded", label: "Deal funded", object: "application", description: "An application is marked funded. data.object.funded_amount and funded_currency say how much." },
  { type: "note.added", label: "Note added", object: "note", description: "A note is added to a contact, company or application." },
];

export function eventDef(type: string): EventDef | undefined {
  return EVENTS.find((e) => e.type === type);
}

function jsonSafe(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  return v;
}

/** The record as sent: only the listed fields, in that order, missing ones as null. */
export function shapeObject(kind: ObjectKind, raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const row = raw ?? {};
  const out: Record<string, unknown> = { object: kind };
  for (const f of OBJECT_FIELDS[kind]) {
    const key = RENAME[f] ?? f;
    const v = row[f];
    out[key] = f === "custom_fields" ? (v && typeof v === "object" ? v : {}) : v === undefined ? null : jsonSafe(v);
  }
  return out;
}

export type DeliveryRow = {
  event_id: string; event_type: string; object_type: string | null; occurred_at: string | Date;
  payload: { object?: Record<string, unknown>; extra?: Record<string, unknown> } | null;
};

/** The JSON body for a delivery (the same bytes on every attempt). */
export function buildBody(row: DeliveryRow): string {
  const def = eventDef(row.event_type);
  const kind = (def?.object ?? row.object_type ?? "contact") as ObjectKind;
  const extra = row.payload?.extra && typeof row.payload.extra === "object" ? row.payload.extra : {};
  const occurred = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(String(row.occurred_at)).toISOString();
  return JSON.stringify({
    id: row.event_id,
    type: row.event_type,
    created_at: occurred,
    data: { object: shapeObject(kind, row.payload?.object), ...extra },
  });
}

const SAMPLE_TIME = "2026-11-03T15:04:05.000Z";
const SAMPLE_OBJECTS: Record<ObjectKind, Record<string, unknown>> = {
  contact: { id: "6f1c2b9e-3a5d-4c7e-9f10-2b3c4d5e6f70", first_name: "Jordan", last_name: "Lee", name: "Jordan Lee", email: "jordan@example.com",
    phone: "+15555550123", job_title: "Owner", company_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", company_name: "Northwind Trucking",
    lead_status: "New", lifecycle_stage: "lead", status: "prospect", role: "applicant", tags: ["equipment"],
    owner_id: "11111111-2222-4333-8444-555555555555", address_city: "Calgary", address_state: "AB", address_country: "CA",
    marketing_opt_out: false, sms_opt_out: false, created_at: SAMPLE_TIME, updated_at: SAMPLE_TIME,
    custom_fields: { broker_licence: "AB-12345", renewal_date: "2027-03-31" } },
  company: { id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Northwind Trucking", legal_name: "Northwind Trucking Ltd.", website: "https://northwind.example",
    industry: "Transportation", city: "Calgary", province: "AB", country: "CA", employee_count: 14, tags: [],
    owner_id: "11111111-2222-4333-8444-555555555555", status: "prospect", created_at: SAMPLE_TIME, updated_at: SAMPLE_TIME,
    custom_fields: { fleet_size: 12 } },
  application: { id: "8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a", name: "Northwind Trucking", business_legal_name: "Northwind Trucking Ltd.",
    product_type: "standard", product_category: "EQUIPMENT", pipeline_state: "IN_REVIEW", status: "IN_REVIEW", requested_amount: 250000,
    funded_amount: null, funded_currency: "CAD", funded_at: null, contact_id: "6f1c2b9e-3a5d-4c7e-9f10-2b3c4d5e6f70",
    company_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", owner_user_id: "11111111-2222-4333-8444-555555555555", source: "client_portal",
    submitted_at: SAMPLE_TIME, signnow_app_signed_at: null, created_at: SAMPLE_TIME, updated_at: SAMPLE_TIME,
    custom_fields: { equipment_type: "dump_truck" } },
  document: { id: "doc_7e6d5c4b", application_id: "8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a", document_type: "bank_statements",
    category: "bank_statements", filename: "march-statement.pdf", status: "uploaded", uploaded_by: "client", size_bytes: 482113, created_at: SAMPLE_TIME },
  note: { id: "c3b2a1f0-9e8d-4c7b-a6f5-e4d3c2b1a0f9", body: "Spoke to Jordan; sending the March statement today.",
    contact_id: "6f1c2b9e-3a5d-4c7e-9f10-2b3c4d5e6f70", company_id: null, application_id: null,
    owner_id: "11111111-2222-4333-8444-555555555555", created_at: SAMPLE_TIME },
};

/** An example body for each event, for the Settings > Webhooks documentation and "Send test event". */
export function sampleBody(type: EventType, eventId = "evt_example"): Record<string, unknown> {
  const def = eventDef(type)!;
  let obj = { ...SAMPLE_OBJECTS[def.object] };
  let extra: Record<string, unknown> = {};
  if (type === "application.stage_changed") extra = { from_stage: "DOCUMENTS_REQUIRED", to_stage: "IN_REVIEW" };
  if (type === "application.signed") obj = { ...obj, signnow_app_signed_at: SAMPLE_TIME };
  if (type === "deal.funded") obj = { ...obj, pipeline_state: "ACCEPTED", funded_amount: 240000, funded_at: SAMPLE_TIME };
  return JSON.parse(buildBody({ event_id: eventId, event_type: type, object_type: def.object, occurred_at: SAMPLE_TIME, payload: { object: obj, extra } }));
}
