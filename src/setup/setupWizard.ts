// KS_SETUP_WIZARD - the set-up wizard a person sees the first time they sign in to the portal.
//
// It is a guide, not a form: every step sends the person to the page that already does the job (Settings > Company,
// Settings > Users & roles, Lenders ...), with the help article that explains it. Each role gets its own list:
//   Admin      - setting up the brokerage (brand, team, phone number, Microsoft 365 / Google, lenders, import ...)
//   Staff      - shown as "Broker": profile, email, booking link, the apps, first contact
//   Marketing  - profile, email, sender details, website lead form, a contact list, the first campaign
//   Ops        - the Broker list (Ops cannot reach the Admin-only settings pages)
//
// A step is done when the data shows it (detect) - a logo saved, a phone number bought, a lender added. Steps that
// cannot be detected (or that the person may have done another way) can be marked done by hand; any step can be
// skipped. The manual answers live in setup_progress; '_wizard' = 'skipped' there means "closed for good".
//
// Shared hosting (KS_SHARED_HOSTING_v1): `db` is the request's brokerage database, so nothing here knows about tenants.
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState, type Q } from "../plans/state.js";
import { clientUrl } from "../licensee/urls.js";

export type StepStatus = "done" | "todo" | "skipped";
export type WizardRole = "admin" | "broker" | "marketing";

/** What the data shows. Every fact is read on its own, so one failing query only loses that one step's detection. */
export type Facts = {
  profile: boolean; // the person's first name and mobile
  signature: boolean; // their email signature
  bookingLink: boolean; // their booking link saved, or in their signature
  ownMicrosoft: boolean; // their own Microsoft 365 sign-in
  ownGoogle: boolean; // their own Google sign-in
  companyMicrosoft: boolean; // the company-wide Microsoft 365 approval
  brand: boolean; // a logo saved for the portal and client app
  team: boolean; // more than one person
  phoneNumber: boolean; // a business number bought
  lender: boolean; // at least one lender
  imported: boolean; // a finished Import data run
  myContacts: number; // contacts this person owns
  stripe: boolean; // Stripe connected for payment links
  quickbooks: boolean; // QuickBooks connected
  application: boolean; // an application has come in
  myApplication: boolean; // an application this person owns
  dialler: boolean; // the iPhone dialler signed in for this person
  sender: boolean; // the company's mailing address and reply email (the marketing email footer)
  websiteKit: boolean; // a lead form, or the website addresses for the kit
  campaign: boolean; // a campaign this person sent
  clientLanguages: boolean; // KS_CLIENT_LANGUAGES_v1 - the client app offers French or Spanish as well as English
};

export type StepDef = {
  key: string;
  title: string;
  why: string;
  /** The existing portal page that does the job, or null when the person's role has no page for it. */
  link: string | null;
  help: string;
  /** Detected from the data. Without detect the step is marked done by hand. */
  detect?: (f: Facts) => boolean;
  /** May be marked done by hand even though it is detected (the data cannot always see it). */
  manual?: boolean;
  optional?: boolean;
  /** An address outside the portal the step shows (the client app for the test application). */
  externalUrl?: () => string;
};

type Ctx = { payments: boolean };

export function adminSteps(ctx: Ctx): StepDef[] {
  return [
    {
      key: "profile", title: "Your profile", link: "/settings/profile", help: "sign-in-to-keystone",
      why: "Add your name and mobile. Your mobile is how you sign in.",
      detect: (f) => f.profile,
    },
    {
      key: "brand", title: "Brand your portal and client app", link: "/settings/company", help: "brand-your-portal",
      why: "Your logo and colours appear in the portal, the client app and your emails.",
      detect: (f) => f.brand,
    },
    // KS_CLIENT_LANGUAGES_v1 - English is always on; French and Spanish are the brokerage's choice.
    {
      key: "client_languages", title: "Choose your clients' languages", link: "/settings/company", help: "brand-your-portal",
      why: "Your client app can be in English, French and Spanish. Clients pick from the languages you offer.",
      detect: (f) => f.clientLanguages, manual: true, optional: true, // English only is a fine answer: mark it done
    },
    {
      key: "team", title: "Add your team and roles", link: "/settings/users", help: "add-users-and-roles",
      why: "Each person signs in with their own mobile and sees what their role allows.",
      detect: (f) => f.team,
    },
    {
      key: "phone", title: "Get your phone number", link: "/settings/phone", help: "get-phone-numbers",
      why: "Calls and texts to clients come from your business number.",
      detect: (f) => f.phoneNumber,
    },
    {
      key: "email", title: "Connect Microsoft 365 or Google", link: "/settings/connections", help: "connect-email-and-calendar",
      why: "Approve it once for your company, then connect your own email and calendar.",
      detect: (f) => f.ownGoogle || (f.ownMicrosoft && f.companyMicrosoft),
    },
    {
      key: "lenders", title: "Add your lenders and products", link: "/lenders", help: "add-lenders-and-products",
      why: "Applications are matched to the lenders and products you add.",
      detect: (f) => f.lender,
    },
    {
      key: "import", title: "Bring your data over", link: "/settings/import", help: "import-from-hubspot-salesforce-pipedrive",
      why: "Import contacts, companies and deals from HubSpot, Salesforce, Pipedrive or a spreadsheet.",
      detect: (f) => f.imported,
    },
    ctx.payments
      ? {
          key: "payments", title: "Payments and QuickBooks", link: "/settings/payments", help: "quickbooks-online", optional: true,
          why: "Optional. Take fee payments with your own Stripe account and send invoices to QuickBooks.",
          detect: (f) => f.stripe || f.quickbooks,
        }
      : {
          // KS_SETUP_WIZARD - payment links are Growth and up; on Starter the step is QuickBooks alone (every plan).
          key: "payments", title: "Connect QuickBooks", link: "/settings/company", help: "quickbooks-online", optional: true,
          why: "Optional. Fee invoices go to your QuickBooks Online company by themselves.",
          detect: (f) => f.quickbooks,
        },
    {
      key: "test_link", title: "Send yourself a test application link", link: "/crm/contacts", help: "send-application-link",
      why: "See what your clients see: open your client app and start an application.",
      detect: (f) => f.application, manual: true, externalUrl: clientUrl,
    },
  ];
}

export function brokerSteps(): StepDef[] {
  return [
    {
      key: "profile", title: "Your profile and email signature", link: "/settings/profile", help: "email-inbox-and-tracking",
      why: "Add your name and mobile, and the signature that goes on your emails.",
      detect: (f) => f.profile && f.signature,
    },
    {
      key: "email", title: "Connect your email and calendar", link: "/settings/profile", help: "connect-email-and-calendar",
      why: "Send email from the portal and let clients book time in your calendar.",
      detect: (f) => f.ownMicrosoft || f.ownGoogle,
    },
    {
      key: "booking", title: "Your booking link", link: "/settings/profile", help: "booking-pages",
      why: "Clients pick a time with you from this link. Add it to your signature.",
      detect: (f) => f.bookingLink, manual: true,
    },
    {
      // KS_SETUP_WIZARD - there is no download page in the portal: Keystone sends the install links, and the help
      // articles say how to sign in. Detected when the dialler has signed in on this person's iPhone.
      key: "apps", title: "Install the iPhone dialler and iPad app", link: null, help: "iphone-dialler",
      why: "Take calls on your business number from your iPhone, and use the full portal on your iPad.",
      detect: (f) => f.dialler, manual: true,
    },
    {
      key: "first_contact", title: "Add your first contact or send an application link", link: "/crm/contacts", help: "send-application-link",
      why: "Add a client in CRM, or send them your client app so they can apply.",
      detect: (f) => f.myContacts > 0 || f.myApplication,
    },
  ];
}

export function marketingSteps(): StepDef[] {
  return [
    {
      key: "profile", title: "Your profile", link: "/settings/profile", help: "sign-in-to-keystone",
      why: "Add your name and mobile. Your mobile is how you sign in.",
      detect: (f) => f.profile,
    },
    {
      key: "email", title: "Connect your email", link: "/settings/profile", help: "connect-email-and-calendar",
      why: "Send and test emails from your own address.",
      detect: (f) => f.ownMicrosoft || f.ownGoogle,
    },
    {
      // KS_SETUP_WIZARD - the footer of every marketing email is the company's legal name, mailing address and reply
      // email from Settings > Company, which only Admins open; unsubscribes are handled for you. No page for Marketing.
      key: "sender", title: "Your sender details and unsubscribe settings", link: null, help: "email-and-text-campaigns",
      why: "Every marketing email shows your company's mailing address and reply email, and an unsubscribe link is added for you. An Admin fills these in under Settings, Company.",
      detect: (f) => f.sender,
    },
    {
      key: "website", title: "Add the lead form or tracking script to your website", link: "/marketing?tab=kit", help: "marketing-add-on",
      why: "Leads from your own website land in CRM by themselves.",
      detect: (f) => f.websiteKit, manual: true,
    },
    {
      key: "import", title: "Import a contact list", link: "/crm/contacts?import=1", help: "import-from-hubspot-salesforce-pipedrive",
      why: "Bring in the people you want to market to from a spreadsheet.",
      detect: (f) => f.imported || f.myContacts >= 5, manual: true,
    },
    {
      key: "campaign", title: "Send your first campaign", link: "/marketing?tab=email", help: "email-and-text-campaigns",
      why: "Email or text a saved group of contacts, now or on a schedule.",
      detect: (f) => f.campaign,
    },
  ];
}

export function wizardRoleOf(role: unknown): WizardRole {
  const r = String(role ?? "").trim().toLowerCase();
  if (r === "admin") return "admin";
  if (r === "marketing") return "marketing";
  return "broker"; // Staff (shown as Broker) and Ops
}

export function stepsFor(role: WizardRole, ctx: Ctx): StepDef[] {
  if (role === "admin") return adminSteps(ctx);
  if (role === "marketing") return marketingSteps();
  return brokerSteps();
}

const NO_FACTS: Facts = {
  profile: false, signature: false, bookingLink: false, ownMicrosoft: false, ownGoogle: false, companyMicrosoft: false,
  brand: false, clientLanguages: false, team: false, phoneNumber: false, lender: false, imported: false, myContacts: 0, stripe: false,
  quickbooks: false, application: false, myApplication: false, dialler: false, sender: false, websiteKit: false, campaign: false,
};

/** Runs one fact query; a failure is logged and the fact is "not detected" (the step can still be done by hand). */
async function fact<T>(db: Q, where: string, sql: string, params: unknown[], read: (rows: any[]) => T, fallback: T): Promise<T> {
  try {
    const r = await db.query(sql, params);
    return read(r?.rows ?? []);
  } catch (err) {
    return logWarnSwallowed(err, `setup/setupWizard.ts:${where}`, fallback);
  }
}
const yes = (rows: any[]) => rows.length > 0 && rows[0]?.ok === true;

/** Which facts a role's list needs, so a Broker does not read company-wide tables it never shows. */
const FACTS_FOR: Record<WizardRole, ReadonlyArray<keyof Facts>> = {
  admin: ["profile", "brand", "clientLanguages", "team", "phoneNumber", "ownMicrosoft", "ownGoogle", "companyMicrosoft", "lender", "imported", "stripe", "quickbooks", "application"],
  broker: ["profile", "signature", "bookingLink", "ownMicrosoft", "ownGoogle", "dialler", "myContacts", "myApplication"],
  marketing: ["profile", "ownMicrosoft", "ownGoogle", "sender", "websiteKit", "imported", "myContacts", "campaign"],
};

export async function detectFacts(db: Q, userId: string, role: WizardRole): Promise<Facts> {
  const want = new Set(FACTS_FOR[role]);
  const u = [userId];
  const run: Partial<Record<keyof Facts, () => Promise<unknown>>> = {
    profile: () => fact(db, "profile",
      `SELECT (COALESCE(btrim(first_name), '') <> '' AND COALESCE(NULLIF(btrim(phone), ''), NULLIF(btrim(phone_number), '')) IS NOT NULL) AS ok
         FROM users WHERE id = $1`, u, yes, false),
    signature: () => fact(db, "signature",
      `SELECT (COALESCE(btrim(email_signature_html), '') <> '') AS ok FROM user_settings WHERE user_id = $1`, u, yes, false),
    bookingLink: () => fact(db, "bookingLink",
      `SELECT (COALESCE(btrim(booking_url), '') <> '' OR COALESCE(email_signature_html, '') ILIKE '%/book/%') AS ok
         FROM user_settings WHERE user_id = $1`, u, yes, false),
    ownMicrosoft: () => fact(db, "ownMicrosoft",
      `SELECT (o365_refresh_token IS NOT NULL OR o365_access_token IS NOT NULL) AS ok FROM users WHERE id = $1`, u, yes, false),
    ownGoogle: () => fact(db, "ownGoogle",
      `SELECT true AS ok FROM google_workspace_accounts WHERE user_id = $1 AND status = 'connected'`, u, yes, false),
    companyMicrosoft: () => fact(db, "companyMicrosoft",
      `SELECT (COALESCE(btrim(office365_tenant_id), '') <> '' OR COALESCE(m365_consent->>'tenant_id', '') <> '') AS ok
         FROM licensee_settings WHERE id = 1`, [], yes, false),
    clientLanguages: () => fact(db, "clientLanguages",
      `SELECT (COALESCE(client_languages, '') LIKE '%,%') AS ok FROM licensee_settings WHERE id = 1`, [], yes, false),
    brand: () => fact(db, "brand",
      `SELECT (COALESCE(btrim(logo_url), '') <> '' OR COALESCE(btrim(ops_branding->>'logo_url'), '') <> '') AS ok
         FROM licensee_settings WHERE id = 1`, [], yes, false),
    team: () => fact(db, "team",
      `SELECT (count(*) > 1) AS ok FROM users
        WHERE deleted_at IS NULL AND COALESCE(disabled, false) = false AND active = true
          AND lower(COALESCE(role, '')) IN ('admin', 'staff', 'ops', 'marketing')`, [], yes, false),
    phoneNumber: () => fact(db, "phoneNumber",
      `SELECT true AS ok FROM phone_numbers WHERE status = 'active' LIMIT 1`, [], yes, false),
    lender: () => fact(db, "lender", `SELECT true AS ok FROM lenders LIMIT 1`, [], yes, false),
    imported: () => fact(db, "imported", `SELECT true AS ok FROM import_batches WHERE status = 'completed' LIMIT 1`, [], yes, false),
    myContacts: () => fact(db, "myContacts",
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM contacts WHERE owner_id = $1 LIMIT 5) mine`, u, (rows) => Number(rows[0]?.n ?? 0) || 0, 0),
    stripe: () => fact(db, "stripe",
      `SELECT true AS ok FROM stripe_connection WHERE id = 1 AND status = 'connected' AND account_id IS NOT NULL`, [], yes, false),
    quickbooks: () => fact(db, "quickbooks",
      `SELECT true AS ok FROM quickbooks_connection WHERE id = 1 AND status = 'connected' AND realm_id IS NOT NULL`, [], yes, false),
    application: () => fact(db, "application", `SELECT true AS ok FROM applications LIMIT 1`, [], yes, false),
    myApplication: () => fact(db, "myApplication", `SELECT true AS ok FROM applications WHERE owner_user_id = $1 LIMIT 1`, u, yes, false),
    dialler: () => fact(db, "dialler", `SELECT true AS ok FROM staff_push_tokens WHERE user_id = $1 AND app = 'dialer-ios' LIMIT 1`, u, yes, false),
    sender: () => fact(db, "sender",
      `SELECT (COALESCE(btrim(mailing_address), '') <> '' AND COALESCE(btrim(support_email), '') <> '') AS ok
         FROM licensee_settings WHERE id = 1`, [], yes, false),
    websiteKit: () => fact(db, "websiteKit",
      `SELECT (EXISTS (SELECT 1 FROM website_kit_forms WHERE active = true)
               OR EXISTS (SELECT 1 FROM brokerage_settings
                           WHERE key = 'website_kit' AND jsonb_typeof(value->'allowed_origins') = 'array'
                             AND jsonb_array_length(value->'allowed_origins') > 0)) AS ok`, [], yes, false),
    campaign: () => fact(db, "campaign",
      `SELECT (EXISTS (SELECT 1 FROM marketing_send_jobs WHERE created_by = $1::text)
               OR EXISTS (SELECT 1 FROM sms_campaigns WHERE created_by = $1::uuid)) AS ok`, u, yes, false),
  };
  const keys = (Object.keys(run) as Array<keyof Facts>).filter((k) => want.has(k));
  const values = await Promise.all(keys.map((k) => run[k]!()));
  const out: Facts = { ...NO_FACTS };
  keys.forEach((k, i) => { (out as Record<string, unknown>)[k] = values[i]; });
  return out;
}

export const DISMISS_KEY = "_wizard";

export type WizardStep = {
  key: string;
  title: string;
  why: string;
  link: string | null;
  help_slug: string;
  status: StepStatus;
  /** Detected from the data (no button needed when it is done). */
  auto: boolean;
  /** "Mark done" is offered. */
  can_mark_done: boolean;
  optional: boolean;
  external_url: string | null;
};

export type Wizard = { role: WizardRole; steps: WizardStep[]; done: number; total: number; complete: boolean; dismissed: boolean };

async function readProgress(db: Q, userId: string): Promise<Map<string, "done" | "skipped">> {
  const r = await db.query(`SELECT step_key, status FROM setup_progress WHERE user_id = $1`, [userId]);
  const m = new Map<string, "done" | "skipped">();
  for (const row of r.rows ?? []) {
    if (row?.status === "done" || row?.status === "skipped") m.set(String(row.step_key), row.status);
  }
  return m;
}

async function contextFor(db: Q, role: WizardRole): Promise<Ctx> {
  if (role !== "admin") return { payments: false };
  const state = await getPlanState(db);
  return { payments: checkFeature(state, "payment_links").allowed };
}

export async function buildWizard(db: Q, userId: string, rawRole: unknown): Promise<Wizard> {
  const role = wizardRoleOf(rawRole);
  const [ctx, facts, progress] = await Promise.all([contextFor(db, role), detectFacts(db, userId, role), readProgress(db, userId)]);
  const steps: WizardStep[] = stepsFor(role, ctx).map((s) => {
    const detected = s.detect ? s.detect(facts) : false;
    const saved = progress.get(s.key);
    const status: StepStatus = detected ? "done" : saved === "done" && (!s.detect || s.manual) ? "done" : saved === "skipped" ? "skipped" : "todo";
    return {
      key: s.key,
      title: s.title,
      why: s.why,
      link: s.link,
      help_slug: s.help,
      status,
      auto: Boolean(s.detect),
      can_mark_done: !s.detect || Boolean(s.manual),
      optional: Boolean(s.optional),
      external_url: s.externalUrl ? s.externalUrl() : null,
    };
  });
  const done = steps.filter((s) => s.status === "done").length;
  return {
    role,
    steps,
    done,
    total: steps.length,
    complete: steps.every((s) => s.status !== "todo"),
    dismissed: progress.get(DISMISS_KEY) === "skipped",
  };
}

export type StatusChange = { ok: true } | { ok: false; status: 400 | 404; error: string; message: string };

/** Saves a manual answer: done (only where "Mark done" is offered), skipped, or todo (forget the answer). */
export async function setStepStatus(db: Q, userId: string, rawRole: unknown, key: string, status: unknown): Promise<StatusChange> {
  if (status !== "done" && status !== "skipped" && status !== "todo") {
    return { ok: false, status: 400, error: "invalid_status", message: "Choose done, skipped or to do." };
  }
  const role = wizardRoleOf(rawRole);
  const step = stepsFor(role, await contextFor(db, role)).find((s) => s.key === key);
  if (!step) return { ok: false, status: 404, error: "not_found", message: "That step is not in your set-up list." };
  if (status === "done" && step.detect && !step.manual) {
    return { ok: false, status: 400, error: "detected_step", message: "This step is ticked off by itself once it is done. Use Do it now to finish it." };
  }
  if (status === "todo") {
    await db.query(`DELETE FROM setup_progress WHERE user_id = $1 AND step_key = $2`, [userId, key]);
  } else {
    await saveProgress(db, userId, key, status);
  }
  return { ok: true };
}

async function saveProgress(db: Q, userId: string, key: string, status: "done" | "skipped"): Promise<void> {
  await db.query(
    `INSERT INTO setup_progress (user_id, step_key, status, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, step_key) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [userId, key, status],
  );
}

/** Closes the wizard for good: it no longer opens by itself (Set-up in the sidebar still opens it). */
export async function dismissWizard(db: Q, userId: string): Promise<void> {
  await saveProgress(db, userId, DISMISS_KEY, "skipped");
}
