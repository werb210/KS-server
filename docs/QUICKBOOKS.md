# QuickBooks Online fee invoices

Each licensee can connect **its own QuickBooks Online company**. Once connected, Keystone keeps an invoice in
QuickBooks for every client-side media fee agreement (the "% on funding" fee agreement):

| When | What Keystone does in QuickBooks |
|---|---|
| The client signs the fee agreement (SignNow, or staff mark it signed by hand) | Finds the customer by name, or creates one, and creates an invoice with one line: **Media funding fee (X% of funding)** on the requested amount. A fixed fee recorded by staff is used as is. |
| The deal is funded (offer accepted with the funded amount, or the stage set to Accepted) | Changes the invoice to X% of the **funded** amount, then records a **Payment** against it, so the invoice shows as paid. |

The invoice number, amount, status (open or paid) and the last sync time show on the application card in the
staff portal. If the last sync failed, the card shows the error and a **Retry** button.

Only agreements signed **after** QuickBooks was connected are invoiced automatically, so connecting never
invoices old files. To invoice an older file, press Retry on its application card.

## Setting it up

1. Create an app at [developer.intuit.com](https://developer.intuit.com) (Accounting scope). Add the redirect URI
   `https://<licensee server>/api/quickbooks/oauth/callback` under **Keys & credentials** (sandbox keys and
   production keys each have their own list).
2. Put the settings on the licensee's KS-server App Service:

| Setting | Required | Value |
|---|---|---|
| `QBO_CLIENT_ID` | yes | the Intuit app's Client ID |
| `QBO_CLIENT_SECRET` | yes (secret) | the Intuit app's Client Secret |
| `QBO_TOKEN_ENCRYPTION_KEY` | yes (secret) | 32 random bytes: `openssl rand -base64 32`. Changing it disconnects QuickBooks (reconnect once). |
| `QBO_ENVIRONMENT` | no | `sandbox` (default) or `production` |
| `QBO_REDIRECT_URI` | no | default `{KS_SERVER_URL}/api/quickbooks/oauth/callback` |

   `scripts/provision-licensee.sh` in KS-Ops writes these (and makes the encryption key once). The KS-server deploy
   workflow also writes them from the licensee's GitHub environment `ks-<code>` when it has the secret
   `QBO_CLIENT_ID` (with `QBO_CLIENT_SECRET`, optional `QBO_TOKEN_ENCRYPTION_KEY`, and the variables
   `QBO_ENVIRONMENT` / `QBO_REDIRECT_URI`).
3. An administrator opens **Settings > Company** in the staff portal and presses **Connect QuickBooks**.
4. Optional: pick the **tax code** for fee lines on the same card (Canadian companies usually need one, e.g.
   Exempt or GST/HST).

Without `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and `QBO_TOKEN_ENCRYPTION_KEY` the feature is off: nothing is queued,
the worker does nothing, and the Settings card is greyed out with the reason.

## How it works (for developers)

- `src/routes/quickbooks.ts`: status, connect, callback, disconnect, tax codes and settings (Admin); invoice view and
  retry (Staff). The OAuth state is a random single-use nonce, hashed in `quickbooks_oauth_states`, 10 minutes.
- `src/services/quickbooks/qboAuth.ts`: tokens are AES-256-GCM encrypted. Intuit rotates refresh tokens, and every
  refresh stores the new one. `invalid_grant` marks the connection `reauth_required`. Disconnect revokes at Intuit.
- `src/services/quickbooks/feeInvoice.ts`: `quickbooks_invoices` is both the record and the outbox. The sign and
  fund hooks queue a row and run it at once. `workers/quickbooksInvoiceWorker.ts` runs every minute, picks up
  anything the hooks missed, and retries failures after 1, 5, 15, 60, 180 and 360 minutes. After that the row is
  `failed` until someone presses Retry. Every create sends an Intuit `requestid` derived from the application, so a
  retry never makes a second customer, invoice or payment. Failures are logged (`[quickbooks] invoice sync failed`).
- `src/services/quickbooks/feeMath.ts`: the fee (pure).
- The fee line uses a Service item named **Media funding fee**, created on the first income account if the company
  does not have one.
- Known limit: undoing a manual "mark signed" does not void an invoice already created. Void it in QuickBooks.
