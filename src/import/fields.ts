// KS_SERVER_v14_DATA_IMPORT - what can be imported: the record types, the Keystone fields of each, the column names
// HubSpot / Salesforce / Pipedrive / a plain spreadsheet use for them, auto-matching and the downloadable templates.

export const RECORD_TYPES = ["contacts", "companies", "lenders", "lender_products", "applications", "notes", "documents"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const SOURCES = ["spreadsheet", "hubspot", "salesforce", "pipedrive", "keystone"] as const;
export type Source = (typeof SOURCES)[number];

export const isRecordType = (v: unknown): v is RecordType => (RECORD_TYPES as readonly string[]).includes(String(v));
export const isSource = (v: unknown): v is Source => (SOURCES as readonly string[]).includes(String(v));

export const RECORD_TYPE_LABEL: Record<RecordType, string> = {
  contacts: "Contacts",
  companies: "Companies",
  lenders: "Lenders",
  lender_products: "Lender products",
  applications: "Deals / applications",
  notes: "Notes and activities",
  documents: "Documents",
};

export const SOURCE_LABEL: Record<Source, string> = {
  spreadsheet: "Spreadsheet (CSV or Excel)",
  hubspot: "HubSpot export",
  salesforce: "Salesforce export",
  pipedrive: "Pipedrive export",
  keystone: "Keystone export zip",
};

export type FieldDef = {
  key: string;
  label: string;
  required?: boolean;
  /** At least one field of the same group must be mapped (e.g. a lender product needs its lender by id or name). */
  group?: string;
  hint?: string;
  example?: string;
};

export const FIELDS: Record<RecordType, FieldDef[]> = {
  contacts: [
    { key: "external_id", label: "ID in the old system", hint: "Links deals, notes and documents to this contact", example: "C-1001" },
    { key: "first_name", label: "First name", group: "who", example: "Jane" },
    { key: "last_name", label: "Last name", group: "who", example: "Doe" },
    { key: "name", label: "Full name", group: "who", hint: "Used when first and last name are not separate" },
    { key: "email", label: "Email", group: "who", example: "jane@example.com" },
    { key: "phone", label: "Phone", group: "who", example: "403-555-0100" },
    { key: "secondary_email", label: "Second email" },
    { key: "secondary_phone", label: "Second phone" },
    { key: "company_external_id", label: "Company ID in the old system" },
    { key: "company_name", label: "Company name", example: "Doe Trucking Ltd." },
    { key: "job_title", label: "Job title", example: "Owner" },
    { key: "lead_status", label: "Lead status", example: "New" },
    { key: "lifecycle_stage", label: "Lifecycle stage", example: "lead" },
    { key: "tags", label: "Tags", hint: "Separated by ; or ,", example: "trucking; referral" },
    { key: "address_street", label: "Street" },
    { key: "address_city", label: "City", example: "Calgary" },
    { key: "address_state", label: "Province / state", example: "AB" },
    { key: "address_zip", label: "Postal / ZIP code" },
    { key: "address_country", label: "Country", example: "Canada" },
    { key: "owner_email", label: "Owner (staff email)", hint: "A staff member's sign-in email; blank = you" },
    { key: "created_at", label: "Created date", example: "2024-03-15" },
  ],
  companies: [
    { key: "external_id", label: "ID in the old system", example: "CO-501" },
    { key: "name", label: "Company name", required: true, example: "Doe Trucking Ltd." },
    { key: "legal_name", label: "Legal name" },
    { key: "dba_name", label: "Operating (DBA) name" },
    { key: "website", label: "Website", example: "https://doetrucking.example" },
    { key: "domain", label: "Domain", example: "doetrucking.example" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "industry", label: "Industry", example: "Transportation" },
    { key: "address_street", label: "Street" },
    { key: "city", label: "City", example: "Calgary" },
    { key: "province", label: "Province / state", example: "AB" },
    { key: "country", label: "Country", example: "Canada" },
    { key: "address_zip", label: "Postal / ZIP code" },
    { key: "annual_revenue", label: "Annual revenue", example: "1200000" },
    { key: "number_of_employees", label: "Employees", example: "12" },
    { key: "types_of_financing", label: "Types of financing", hint: "Separated by ; or ," },
    { key: "tags", label: "Tags", hint: "Separated by ; or ," },
    { key: "owner_email", label: "Owner (staff email)" },
    { key: "created_at", label: "Created date" },
  ],
  lenders: [
    { key: "external_id", label: "ID in the old system", example: "L-7" },
    { key: "name", label: "Lender name", required: true, example: "Prairie Capital" },
    { key: "country", label: "Country", hint: "CA, US or BOTH (blank = CA)", example: "CA" },
    { key: "website", label: "Website" },
    { key: "phone", label: "Main phone" },
    { key: "email", label: "Email" },
    { key: "street", label: "Street" },
    { key: "city", label: "City" },
    { key: "region", label: "Province / state" },
    { key: "postal_code", label: "Postal / ZIP code" },
    { key: "contact_name", label: "Contact name" },
    { key: "contact_email", label: "Contact email" },
    { key: "contact_phone", label: "Contact phone" },
    { key: "submission_method", label: "Submission method", hint: "email, api or google_sheet", example: "email" },
    { key: "submission_email", label: "Submission email", example: "deals@prairiecapital.example" },
    { key: "description", label: "Description" },
    { key: "internal_notes", label: "Internal notes" },
    { key: "active", label: "Active", hint: "yes / no (blank = yes)" },
  ],
  lender_products: [
    { key: "external_id", label: "ID in the old system", example: "P-31" },
    { key: "lender_external_id", label: "Lender ID in the old system", group: "lender" },
    { key: "lender_name", label: "Lender name", group: "lender", example: "Prairie Capital" },
    { key: "name", label: "Product name", required: true, example: "Working capital line" },
    { key: "category", label: "Category", required: true, hint: "LOC, TERM, FACTORING, PO, EQUIPMENT, MCA, MEDIA, ABL, SBA or STARTUP", example: "LOC" },
    { key: "country", label: "Country", hint: "CA, US or BOTH (blank = BOTH)", example: "CA" },
    { key: "amount_min", label: "Minimum amount", example: "25000" },
    { key: "amount_max", label: "Maximum amount", example: "500000" },
    { key: "rate_min", label: "Minimum rate (%)", example: "8.5" },
    { key: "rate_max", label: "Maximum rate (%)", example: "18" },
    { key: "rate_type", label: "Rate type", hint: "FIXED or VARIABLE" },
    { key: "term_min", label: "Minimum term (months)", example: "6" },
    { key: "term_max", label: "Maximum term (months)", example: "36" },
    { key: "min_credit_score", label: "Minimum credit score", example: "600" },
    { key: "commission", label: "Commission (%)", example: "2" },
    { key: "required_documents", label: "Required documents", hint: "Separated by ; or ,", example: "bank_statements; tax_returns" },
    { key: "eligibility_notes", label: "Eligibility notes" },
    { key: "description", label: "Description" },
    { key: "active", label: "Active", hint: "yes / no (blank = yes)" },
  ],
  applications: [
    { key: "external_id", label: "Deal ID in the old system", example: "D-9001" },
    { key: "name", label: "Deal name", required: true, example: "Doe Trucking - working capital" },
    { key: "stage", label: "Pipeline stage", hint: "Matched to Keystone stages; see the stage list", example: "Closed won" },
    { key: "amount", label: "Amount requested", example: "150000" },
    { key: "product_category", label: "Product / category", example: "LOC" },
    { key: "lender_product_external_id", label: "Lender product ID in the old system" },
    { key: "lender_product_name", label: "Lender product name" },
    { key: "lender_external_id", label: "Lender ID in the old system" },
    { key: "lender_name", label: "Lender name" },
    { key: "contact_external_id", label: "Contact ID in the old system" },
    { key: "contact_email", label: "Contact email", example: "jane@example.com" },
    { key: "company_external_id", label: "Company ID in the old system" },
    { key: "company_name", label: "Company name", example: "Doe Trucking Ltd." },
    { key: "owner_email", label: "Owner (staff email)" },
    { key: "funded_amount", label: "Funded amount" },
    { key: "funded_at", label: "Funded date" },
    { key: "submitted_at", label: "Submitted date" },
    { key: "created_at", label: "Created date", example: "2024-03-15" },
    { key: "updated_at", label: "Last updated date" },
  ],
  notes: [
    { key: "external_id", label: "ID in the old system" },
    { key: "body", label: "Note text", required: true, example: "Called Jane, she will send bank statements Friday." },
    { key: "activity_type", label: "Type", hint: "note, call, email, meeting or task (blank = note)", example: "call" },
    { key: "subject", label: "Subject / title" },
    { key: "contact_external_id", label: "Contact ID in the old system", group: "link" },
    { key: "contact_email", label: "Contact email", group: "link", example: "jane@example.com" },
    { key: "company_external_id", label: "Company ID in the old system", group: "link" },
    { key: "company_name", label: "Company name", group: "link" },
    { key: "application_external_id", label: "Deal ID in the old system", group: "link" },
    { key: "author_email", label: "Written by (staff email)" },
    { key: "created_at", label: "Date", example: "2024-03-20 14:30" },
  ],
  documents: [
    { key: "file", label: "File name in the zip", required: true, example: "statements/jan-2024.pdf" },
    { key: "category", label: "Document category", hint: "e.g. bank_statements, tax_returns, id; blank = other", example: "bank_statements" },
    { key: "title", label: "Title" },
    { key: "application_external_id", label: "Deal ID in the old system", group: "link" },
    { key: "contact_external_id", label: "Contact ID in the old system", group: "link" },
    { key: "contact_email", label: "Contact email", group: "link" },
  ],
};

/** Column names each system's export uses for a field (compared case- and punctuation-insensitively). */
type Aliases = Partial<Record<RecordType, Record<string, string[]>>>;

const COMMON: Aliases = {
  contacts: {
    external_id: ["id", "contact id", "record id", "external id"],
    first_name: ["first name", "firstname", "given name"],
    last_name: ["last name", "lastname", "surname", "family name"],
    name: ["name", "full name", "contact name", "contact"],
    email: ["email", "email address", "e-mail", "primary email"],
    phone: ["phone", "phone number", "mobile", "mobile phone", "cell", "telephone", "work phone"],
    secondary_email: ["secondary email", "other email", "email 2", "personal email"],
    secondary_phone: ["secondary phone", "other phone", "phone 2", "home phone"],
    company_external_id: ["company id", "account id", "organization id"],
    company_name: ["company", "company name", "organization", "organisation", "account name", "business name"],
    job_title: ["job title", "title", "position", "role"],
    lead_status: ["lead status", "status"],
    lifecycle_stage: ["lifecycle stage", "stage"],
    tags: ["tags", "labels", "label"],
    address_street: ["street", "street address", "address", "address 1", "address line 1"],
    address_city: ["city", "town"],
    address_state: ["province", "state", "region", "state/region", "state/province"],
    address_zip: ["postal code", "zip", "zip code", "postcode", "postal/zip"],
    address_country: ["country", "country/region"],
    owner_email: ["owner email", "owner", "contact owner", "assigned to", "sales rep email"],
    created_at: ["created", "created at", "create date", "created date", "date created", "add time"],
  },
  companies: {
    external_id: ["id", "company id", "record id", "account id", "organization id"],
    name: ["name", "company", "company name", "account name", "organization", "organization name", "business name"],
    legal_name: ["legal name", "legal business name"],
    dba_name: ["dba", "dba name", "operating name", "trade name"],
    website: ["website", "website url", "url", "web site"],
    domain: ["domain", "company domain name", "domain name"],
    email: ["email", "company email"],
    phone: ["phone", "phone number", "company phone", "main phone"],
    industry: ["industry", "sector"],
    address_street: ["street", "street address", "address", "billing street"],
    city: ["city", "billing city", "town"],
    province: ["province", "state", "region", "state/region", "billing state/province", "billing state"],
    country: ["country", "country/region", "billing country"],
    address_zip: ["postal code", "zip", "zip code", "billing zip/postal code", "billing postal code"],
    annual_revenue: ["annual revenue", "revenue"],
    number_of_employees: ["employees", "number of employees", "employee count", "headcount"],
    types_of_financing: ["types of financing", "financing types"],
    tags: ["tags", "labels", "label"],
    owner_email: ["owner email", "owner", "company owner", "account owner"],
    created_at: ["created", "created at", "create date", "created date", "date created"],
  },
  lenders: {
    external_id: ["id", "lender id", "record id"],
    name: ["name", "lender", "lender name", "company name"],
    country: ["country"],
    website: ["website", "url"],
    phone: ["phone", "main phone", "phone number"],
    email: ["email"],
    street: ["street", "address", "street address"],
    city: ["city"],
    region: ["province", "state", "region"],
    postal_code: ["postal code", "zip", "zip code"],
    contact_name: ["contact name", "primary contact", "rep name"],
    contact_email: ["contact email", "rep email"],
    contact_phone: ["contact phone", "rep phone"],
    submission_method: ["submission method", "submit by"],
    submission_email: ["submission email", "submissions email", "deal email"],
    description: ["description", "about"],
    internal_notes: ["notes", "internal notes"],
    active: ["active", "is active", "enabled"],
  },
  lender_products: {
    external_id: ["id", "product id", "record id"],
    lender_external_id: ["lender id"],
    lender_name: ["lender", "lender name"],
    name: ["name", "product", "product name"],
    category: ["category", "product category", "type", "product type"],
    country: ["country"],
    amount_min: ["min amount", "minimum amount", "amount min", "min loan", "minimum"],
    amount_max: ["max amount", "maximum amount", "amount max", "max loan", "maximum"],
    rate_min: ["min rate", "minimum rate", "rate min", "interest min"],
    rate_max: ["max rate", "maximum rate", "rate max", "interest max"],
    rate_type: ["rate type"],
    term_min: ["min term", "minimum term", "term min"],
    term_max: ["max term", "maximum term", "term max"],
    min_credit_score: ["min credit score", "minimum credit score", "credit score"],
    commission: ["commission", "commission %", "commission percent"],
    required_documents: ["required documents", "documents required", "documents"],
    eligibility_notes: ["eligibility", "eligibility notes", "requirements"],
    description: ["description", "notes"],
    active: ["active", "is active", "enabled"],
  },
  applications: {
    external_id: ["id", "deal id", "record id", "opportunity id", "application id"],
    name: ["name", "deal name", "deal", "title", "opportunity name", "application name"],
    stage: ["stage", "deal stage", "pipeline stage", "status"],
    amount: ["amount", "deal value", "value", "requested amount", "loan amount"],
    product_category: ["product", "product category", "loan type", "type", "deal type"],
    lender_product_external_id: ["lender product id", "product id"],
    lender_product_name: ["lender product", "lender product name"],
    lender_external_id: ["lender id"],
    lender_name: ["lender", "lender name"],
    contact_external_id: ["contact id", "person id", "primary contact id"],
    contact_email: ["contact email", "email", "person email"],
    company_external_id: ["company id", "account id", "organization id"],
    company_name: ["company", "company name", "account name", "organization", "organization name", "business name"],
    owner_email: ["owner email", "owner", "deal owner", "opportunity owner"],
    funded_amount: ["funded amount", "won amount"],
    funded_at: ["funded date", "funded at", "close date", "won time", "closed date"],
    submitted_at: ["submitted date", "submitted at", "date submitted"],
    created_at: ["created", "created at", "create date", "created date", "deal created", "date created", "add time"],
    updated_at: ["updated", "updated at", "last modified", "last modified date", "update time"],
  },
  notes: {
    external_id: ["id", "note id", "activity id", "engagement id", "record id"],
    body: ["note", "notes", "body", "content", "note body", "description", "comments", "text"],
    activity_type: ["type", "activity type", "engagement type"],
    subject: ["subject", "title"],
    contact_external_id: ["contact id", "person id", "associated contact id"],
    contact_email: ["contact email", "email", "person email"],
    company_external_id: ["company id", "account id", "organization id", "associated company id"],
    company_name: ["company", "company name", "account name", "organization"],
    application_external_id: ["deal id", "opportunity id", "application id", "associated deal id"],
    author_email: ["author email", "owner email", "created by", "owner", "user"],
    created_at: ["date", "created", "created at", "create date", "activity date", "timestamp", "add time", "due date"],
  },
  documents: {
    file: ["file", "file name", "filename", "path", "file path"],
    category: ["category", "document category", "type", "document type"],
    title: ["title", "name", "description"],
    application_external_id: ["deal id", "application id", "opportunity id"],
    contact_external_id: ["contact id", "person id"],
    contact_email: ["contact email", "email"],
  },
};

/** Exact column names from each system's standard export, tried before the common names. */
const PRESETS: Record<Exclude<Source, "keystone" | "spreadsheet">, Aliases> = {
  hubspot: {
    contacts: {
      external_id: ["record id", "contact id", "hs_object_id"], email: ["email"], first_name: ["first name"], last_name: ["last name"],
      phone: ["phone number", "mobile phone number"], company_name: ["company name", "associated company"],
      company_external_id: ["associated company ids", "associated company id", "company id"], job_title: ["job title"],
      lead_status: ["lead status"], lifecycle_stage: ["lifecycle stage"], address_street: ["street address"],
      address_city: ["city"], address_state: ["state/region"], address_zip: ["postal code"], address_country: ["country/region"],
      owner_email: ["contact owner", "hubspot owner"], created_at: ["create date"],
    },
    companies: {
      external_id: ["record id", "company id", "hs_object_id"], name: ["company name", "name"], domain: ["company domain name"],
      website: ["website url"], phone: ["phone number"], industry: ["industry"], city: ["city"], province: ["state/region"],
      country: ["country/region"], address_zip: ["postal code"], address_street: ["street address"], annual_revenue: ["annual revenue"],
      number_of_employees: ["number of employees"], owner_email: ["company owner"], created_at: ["create date"],
    },
    applications: {
      external_id: ["record id", "deal id", "hs_object_id"], name: ["deal name"], stage: ["deal stage"], amount: ["amount"],
      product_category: ["deal type"], contact_external_id: ["associated contact ids", "associated contact id"],
      company_external_id: ["associated company ids", "associated company id"], company_name: ["associated company"],
      owner_email: ["deal owner"], funded_at: ["close date"], created_at: ["create date"], updated_at: ["last modified date"],
    },
    notes: {
      external_id: ["record id", "engagement id", "activity id"], body: ["note body", "body preview", "call notes", "meeting description", "email body"],
      activity_type: ["activity type", "engagement type"], subject: ["subject", "call title", "meeting name", "email subject"],
      contact_external_id: ["associated contact ids", "associated contact id"], company_external_id: ["associated company ids", "associated company id"],
      application_external_id: ["associated deal ids", "associated deal id"], author_email: ["activity assigned to", "created by"],
      created_at: ["activity date", "create date"],
    },
  },
  salesforce: {
    contacts: {
      external_id: ["id", "contact id"], first_name: ["firstname", "first name"], last_name: ["lastname", "last name"],
      email: ["email"], phone: ["phone", "mobilephone", "mobile phone"], company_external_id: ["accountid", "account id"],
      company_name: ["account name", "account.name"], job_title: ["title"], lead_status: ["leadsource", "lead source"],
      address_street: ["mailingstreet", "mailing street"], address_city: ["mailingcity", "mailing city"],
      address_state: ["mailingstate", "mailing state/province"], address_zip: ["mailingpostalcode", "mailing zip/postal code"],
      address_country: ["mailingcountry", "mailing country"], owner_email: ["owner.email", "owner email", "contact owner"],
      created_at: ["createddate", "created date"],
    },
    companies: {
      external_id: ["id", "account id"], name: ["name", "account name"], website: ["website"], phone: ["phone"],
      industry: ["industry"], address_street: ["billingstreet", "billing street"], city: ["billingcity", "billing city"],
      province: ["billingstate", "billing state/province"], country: ["billingcountry", "billing country"],
      address_zip: ["billingpostalcode", "billing zip/postal code"], annual_revenue: ["annualrevenue", "annual revenue"],
      number_of_employees: ["numberofemployees", "employees"], owner_email: ["owner.email", "account owner"],
      created_at: ["createddate", "created date"],
    },
    applications: {
      external_id: ["id", "opportunity id"], name: ["name", "opportunity name"], stage: ["stagename", "stage"],
      amount: ["amount"], product_category: ["type"], company_external_id: ["accountid", "account id"],
      company_name: ["account name", "account.name"], contact_external_id: ["contactid", "primary contact id"],
      owner_email: ["owner.email", "opportunity owner"], funded_at: ["closedate", "close date"],
      created_at: ["createddate", "created date"], updated_at: ["lastmodifieddate", "last modified date"],
    },
    notes: {
      external_id: ["id", "task id", "note id"], body: ["description", "body", "comments"], subject: ["subject", "title"],
      activity_type: ["type", "tasksubtype", "task subtype"], contact_external_id: ["whoid", "name id"],
      company_external_id: ["accountid", "account id"], application_external_id: ["whatid", "related to id"],
      author_email: ["owner.email", "assigned to"], created_at: ["activitydate", "createddate", "date"],
    },
  },
  pipedrive: {
    contacts: {
      external_id: ["person - id", "id"], name: ["person - name", "name"], first_name: ["person - first name", "first name"],
      last_name: ["person - last name", "last name"], email: ["person - email", "email", "person - email - work"],
      phone: ["person - phone", "phone", "person - phone - work", "person - phone - mobile"],
      company_external_id: ["person - organization id", "organization id"], company_name: ["person - organization", "organization"],
      job_title: ["person - job title"], tags: ["person - labels", "labels"], owner_email: ["person - owner", "owner"],
      created_at: ["person - person created", "person created", "add time"],
    },
    companies: {
      external_id: ["organization - id", "id"], name: ["organization - name", "name"], address_street: ["organization - address", "address"],
      tags: ["organization - labels", "labels"], owner_email: ["organization - owner", "owner"],
      created_at: ["organization - organization created", "organization created", "add time"],
    },
    applications: {
      external_id: ["deal - id", "id"], name: ["deal - title", "title"], stage: ["deal - stage", "stage"], amount: ["deal - value", "value"],
      contact_external_id: ["deal - contact person id", "person id"], contact_email: ["person - email"],
      company_external_id: ["deal - organization id", "organization id"], company_name: ["deal - organization", "organization"],
      owner_email: ["deal - owner", "owner"], funded_at: ["deal - won time", "won time"], created_at: ["deal - deal created", "deal created", "add time"],
      updated_at: ["deal - update time", "update time"],
    },
    notes: {
      external_id: ["note - id", "activity - id", "id"], body: ["note - content", "content", "activity - note", "note"],
      subject: ["activity - subject", "subject"], activity_type: ["activity - type", "type"],
      contact_external_id: ["note - person id", "activity - contact person id", "person id"],
      company_external_id: ["note - organization id", "activity - organization id", "organization id"],
      application_external_id: ["note - deal id", "activity - deal id", "deal id"], author_email: ["note - user", "activity - assigned to user", "user"],
      created_at: ["note - add time", "activity - due date", "add time", "due date"],
    },
  },
};

export const normaliseColumn = (s: string) => String(s ?? "").toLowerCase().replace(/[\s_.\-:/()]+/g, " ").trim();

/** Best guess of { field: column } for the given columns. Each column is used once; preset names win. */
export function autoMatch(source: Source, type: RecordType, columns: string[]): Record<string, string> {
  const preset = source === "hubspot" || source === "salesforce" || source === "pipedrive" ? PRESETS[source][type] ?? {} : {};
  const common = COMMON[type] ?? {};
  const byNorm = new Map<string, string>();
  for (const c of columns) if (!byNorm.has(normaliseColumn(c))) byNorm.set(normaliseColumn(c), c);
  const used = new Set<string>();
  const out: Record<string, string> = {};
  const tryAssign = (field: string, names: string[]) => {
    if (out[field]) return;
    for (const n of names) {
      const col = byNorm.get(normaliseColumn(n));
      if (col && !used.has(col)) { out[field] = col; used.add(col); return; }
    }
  };
  // Exact field key first ("email" column -> email), then the system's own names, then common names.
  for (const f of FIELDS[type]) tryAssign(f.key, [f.key, f.label]);
  for (const [field, names] of Object.entries(preset)) tryAssign(field, names);
  for (const [field, names] of Object.entries(common)) tryAssign(field, names);
  return out;
}

/** Template CSV for a record type: Keystone's own column names and one example row. */
export function templateCsv(type: RecordType): string {
  const fields = FIELDS[type];
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [fields.map((f) => esc(f.key)).join(","), fields.map((f) => esc(f.example ?? "")).join(",")].join("\r\n") + "\r\n";
}

export function presetsSummary() {
  return {
    sources: SOURCES.map((s) => ({ key: s, label: SOURCE_LABEL[s] })),
    record_types: RECORD_TYPES.map((t) => ({ key: t, label: RECORD_TYPE_LABEL[t], fields: FIELDS[t] })),
  };
}

/** Problems with a mapping before any row is read: required fields and one-of groups. */
export function mappingProblems(type: RecordType, mapping: Record<string, string>): string[] {
  const problems: string[] = [];
  const mapped = (k: string) => typeof mapping[k] === "string" && mapping[k].trim() !== "";
  for (const f of FIELDS[type]) if (f.required && !mapped(f.key)) problems.push(`Choose a column for "${f.label}".`);
  const groups = new Map<string, FieldDef[]>();
  for (const f of FIELDS[type]) if (f.group) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  for (const [, fs] of groups) {
    if (!fs.some((f) => mapped(f.key))) problems.push(`Choose a column for at least one of: ${fs.map((f) => f.label).join(", ")}.`);
  }
  const known = new Set(FIELDS[type].map((f) => f.key));
  for (const k of Object.keys(mapping)) if (!known.has(k)) problems.push(`"${k}" is not a ${RECORD_TYPE_LABEL[type]} field.`);
  return problems;
}
