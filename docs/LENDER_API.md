# Lender API connections (KS_SERVER_LENDER_API)

Growth and Pro (catalogue key `lender_api`). A brokerage connects a lender's broker API in
Lenders > edit lender > Connection, with its own broker API key or portal credentials. Then:

- **Send**: a selected lender whose connection is on and set to "send packages by API" gets the package through its
  connector instead of the email. If the API refuses or is unreachable and email fallback is on, the package goes by
  email straight away (logged). Without fallback, retryable failures are retried 5 times (2, 4, 8, 16 min ...).
- **Submit by API** on the application's Lenders tab sends to one lender on demand (same holds as a normal send:
  signed application, SBA forms, fraud hold, product questions, dispatch lock).
- **Status back**: the lender's webhook (`POST /api/lender-webhooks/<connection id>/<secret>`, plus HMAC / shared
  secret / Salesforce organization id) or polling every N minutes (default 30) updates the deal: status timeline,
  the lender's offers in the Offers list, conditions and document requests, funded amount. A status mapped to a stage
  moves the file (by default only an offer, to Offer). The assigned staff member (else every Admin) is notified.
- Every change is in `lender_api_events` (the timeline) and the audit log.

## Connectors (`src/lenderConnectors/connectors`)

| Connector | Use for | Status |
|---|---|---|
| `generic_rest` | Any lender with a JSON broker API: field mapping, response paths, optional webhooks | Available |
| `salesforce` | Lenders whose broker portal is Salesforce Experience Cloud (`*.my.site.com`): OAuth at the site, sObject create, ContentVersion files, SOQL for offers/conditions, Outbound Messages or Flow callouts | Available |
| `heron` | Funders taking broker deals through Heron Data (`bft_` broker key); submit + files only (Heron documents no broker status read-back) | Available |
| `merchant_growth` | Salesforce preset shaped from Merchant Growth's broker portal (merchantadvance.my.site.com) | **Awaiting Merchant Growth's API docs** (`MERCHANT_GROWTH_API_DOCS_RECEIVED = false`): never sends; email + Google Sheet continue |

Credentials are sealed with AES-256-GCM under `LENDER_CREDENTIALS_ENCRYPTION_KEY` (provisioned by KS-Ops; without
it credentials cannot be saved). Lender addresses go through the same SSRF guard as outgoing webhooks.

## Turning Merchant Growth on

When Merchant Growth sends documentation and API access: correct `MERCHANT_GROWTH_PRESET` (object and field API
names, status names) in `connectors/merchantGrowth.ts`, set `MERCHANT_GROWTH_API_DOCS_RECEIVED = true`, and update
the tests. A brokerage that gets access sooner can use the plain `salesforce` connector and map the fields itself.
