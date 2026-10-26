// KS_SERVER_SSO_API_KEYS - the OpenAPI 3.0 description of the public REST API, served unauthenticated at
// GET /api/open/v1/openapi.json (stable path) and shown on the portal's Settings > API page.
import { serverUrl } from "../licensee/urls.js";
import { API_STAGES } from "./stages.js";

export const PUBLIC_API_BASE = "/api/open/v1";

const page = [
  { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 25 }, description: "Items per page (1-100)." },
  { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, default: 0 }, description: "Items to skip. Use pagination.next_offset from the previous page." },
];
const idParam = (name = "id") => ({ name, in: "path", required: true, schema: { type: "string" } });
const ok = (schema: string, list = false) => ({
  description: "OK",
  content: { "application/json": { schema: list
    ? { type: "object", properties: { data: { type: "array", items: { $ref: `#/components/schemas/${schema}` } }, pagination: { $ref: "#/components/schemas/Pagination" } } }
    : { type: "object", properties: { data: { $ref: `#/components/schemas/${schema}` } } } } },
});
const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "402": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/Error" },
};
const json = (schema: Record<string, unknown>) => ({ required: true, content: { "application/json": { schema } } });

export function openApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Keystone REST API",
      version: "1.0.0",
      description: "Read and update your brokerage's contacts, companies, applications, notes and lenders. "
        + "Authenticate with an API key created by an Admin in Settings > API: `Authorization: Bearer ks_live_...`. "
        + "Read-only keys can call GET endpoints; read-write keys can also create and update. Requires the Pro plan.",
    },
    servers: [{ url: serverUrl() + PUBLIC_API_BASE }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/contacts": {
        get: { summary: "List contacts", parameters: [...page, { name: "q", in: "query", schema: { type: "string" }, description: "Search name or email." }, { name: "email", in: "query", schema: { type: "string" }, description: "Exact email (case-insensitive)." }], responses: { "200": ok("Contact", true), ...errors } },
        post: { summary: "Create a contact (read-write key)", requestBody: json({ $ref: "#/components/schemas/ContactInput" }), responses: { "201": ok("Contact"), ...errors } },
      },
      "/contacts/{id}": { get: { summary: "Get a contact", parameters: [idParam()], responses: { "200": ok("Contact"), ...errors } } },
      "/companies": { get: { summary: "List companies", parameters: [...page, { name: "q", in: "query", schema: { type: "string" }, description: "Search by name." }], responses: { "200": ok("Company", true), ...errors } } },
      "/companies/{id}": { get: { summary: "Get a company", parameters: [idParam()], responses: { "200": ok("Company"), ...errors } } },
      "/applications": { get: { summary: "List applications", parameters: [...page, { name: "stage", in: "query", schema: { type: "string", enum: API_STAGES } }], responses: { "200": ok("Application", true), ...errors } } },
      "/applications/{id}": { get: { summary: "Get an application", parameters: [idParam()], responses: { "200": ok("Application"), ...errors } } },
      "/applications/{id}/stage": {
        patch: { summary: "Move an application to another stage (read-write key)", parameters: [idParam()], requestBody: json({ type: "object", required: ["stage"], properties: { stage: { type: "string", enum: API_STAGES } } }), responses: { "200": ok("Application"), ...errors } },
      },
      "/applications/{id}/notes": {
        get: { summary: "List an application's notes", parameters: [idParam(), ...page], responses: { "200": ok("Note", true), ...errors } },
        post: { summary: "Add a note to an application (read-write key)", parameters: [idParam()], requestBody: json({ type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 10000 } } }), responses: { "201": ok("Note"), ...errors } },
      },
      "/lenders": { get: { summary: "List lenders", parameters: [...page, { name: "active", in: "query", schema: { type: "boolean" } }], responses: { "200": ok("Lender", true), ...errors } } },
      "/lenders/{id}": { get: { summary: "Get a lender", parameters: [idParam()], responses: { "200": ok("Lender"), ...errors } } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "An API key: ks_live_..." } },
      responses: {
        Error: {
          description: "Error",
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } } },
        },
      },
      schemas: {
        Pagination: { type: "object", properties: { limit: { type: "integer" }, offset: { type: "integer" }, next_offset: { type: "integer", nullable: true } } },
        Contact: { type: "object", properties: {
          id: { type: "string" }, first_name: { type: "string", nullable: true }, last_name: { type: "string", nullable: true }, name: { type: "string", nullable: true },
          email: { type: "string", nullable: true }, phone: { type: "string", nullable: true }, company_id: { type: "string", nullable: true },
          company_name: { type: "string", nullable: true }, job_title: { type: "string", nullable: true }, lead_status: { type: "string", nullable: true },
          lifecycle_stage: { type: "string", nullable: true }, tags: { type: "array", items: { type: "string" } }, owner_id: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, custom_fields: { type: "object", additionalProperties: true, description: "Custom field values keyed by internal name (Settings > Properties)." },
        } },
        ContactInput: { type: "object", required: ["first_name", "last_name"], properties: {
          first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
          company_id: { type: "string" }, job_title: { type: "string" },
        } },
        Company: { type: "object", properties: {
          id: { type: "string" }, name: { type: "string", nullable: true }, legal_name: { type: "string", nullable: true }, dba_name: { type: "string", nullable: true },
          website: { type: "string", nullable: true }, email: { type: "string", nullable: true }, phone: { type: "string", nullable: true },
          industry: { type: "string", nullable: true }, city: { type: "string", nullable: true }, province: { type: "string", nullable: true },
          country: { type: "string", nullable: true }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, custom_fields: { type: "object", additionalProperties: true, description: "Custom field values keyed by internal name (Settings > Properties)." },
        } },
        Application: { type: "object", properties: {
          id: { type: "string" }, name: { type: "string" }, stage: { type: "string", enum: [...API_STAGES, "Fraud", "Hold"] },
          business_legal_name: { type: "string", nullable: true }, requested_amount: { type: "number", nullable: true },
          product_category: { type: "string", nullable: true }, company_id: { type: "string", nullable: true }, contact_id: { type: "string", nullable: true },
          lender_id: { type: "string", nullable: true }, submitted_at: { type: "string", format: "date-time", nullable: true },
          funded_amount: { type: "number", nullable: true }, funded_at: { type: "string", format: "date-time", nullable: true },
          created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, custom_fields: { type: "object", additionalProperties: true, description: "Custom field values keyed by internal name (Settings > Properties)." },
        } },
        Note: { type: "object", properties: {
          id: { type: "string" }, application_id: { type: "string" }, body: { type: "string" }, owner_id: { type: "string", nullable: true },
          owner_name: { type: "string", nullable: true }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" },
        } },
        Lender: { type: "object", properties: {
          id: { type: "string" }, name: { type: "string" }, active: { type: "boolean" }, website: { type: "string", nullable: true },
          phone: { type: "string", nullable: true }, email: { type: "string", nullable: true }, country: { type: "string", nullable: true },
          region: { type: "string", nullable: true }, city: { type: "string", nullable: true }, contact_name: { type: "string", nullable: true },
          contact_email: { type: "string", nullable: true }, contact_phone: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" },
        } },
      },
    },
  };
}
