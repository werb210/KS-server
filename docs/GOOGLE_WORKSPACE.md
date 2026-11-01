# Google Workspace in Keystone

Keystone can now work with **Google Workspace** as well as **Microsoft 365**. A brokerage picks one of the two, or both. Each staff member then connects their own Google account from **Settings → My Profile → Connect Google**.

This page covers:

1. What works today, and what stays off for now
2. The company setting
3. Setting up Google Cloud (a one-time job, done under the company Google account)
4. Where to put the keys
5. Gmail inbox reading: how to switch it on later, and the yearly security assessment (CASA) it needs
6. Known limits
7. How it works (for developers)

---

## 1. What works today, and what stays off

Today Keystone asks Google only for "sensitive" permissions. Those need Google's **standard app verification**, which is free:

| Feature | Google permission | Where it shows up in Keystone |
|---|---|---|
| Sign in and identify the account | `openid`, `email`, `profile` | Connect Google |
| **Send email** from the composer (new, reply, CRM card, templates, collateral, attachments, inline images) | `gmail.send` | Every send is logged on the contact timeline, the same way as Outlook, including the open-tracking pixel and creating a lead for an unknown recipient |
| **Calendar**: list, create, edit and cancel events; create a **Google Meet** link wherever Keystone creates a Teams meeting; Find-a-time; client bookings | `calendar.events` | Calendar page, CRM meetings, "Schedule meeting", the public booking page |
| **Tasks**: every portal task appears in Google Tasks. Ticking one off in Google completes it in the portal | `tasks` | Tasks, calendar tasks |
| **Client folders** in Google Drive, shared with the brokerage's Google Workspace domain | `drive.file` (Keystone sees only the files and folders it created) | The CRM contact's folder card |

**Built but switched off: Gmail inbox reading.** Reading mail needs `gmail.readonly`, which Google classes as **restricted**. Restricted permissions need a yearly third-party security assessment (CASA, see section 5). While the switch (`KS_GOOGLE_GMAIL_READ_ENABLED`) is off:

- Keystone never asks Google for `gmail.readonly`.
- The sync never runs, and the Gmail inbox routes answer "Gmail inbox reading is pending Google's security review".
- Settings > Connections and My Profile show the same sentence.

Keystone asks only for `gmail.readonly`, never `gmail.modify` or full mail access: reading is enough for the sync, the inbox view and filing attachments.

> **One rule for people who connect both accounts:** Microsoft 365 is used whenever it is connected. Google is used only when Microsoft 365 is not connected. To move someone fully to Google, disconnect Microsoft 365 in their profile.

## 2. The company setting

Go to **Settings → Company → Email, calendar and files**. An administrator picks one of these:

- **Microsoft 365** (the default, and how Keystone works today). Staff see only "Connect Microsoft 365".
- **Google Workspace.** Staff see only "Connect Google". Anyone still connected to Microsoft 365 also keeps the Microsoft button, so they can disconnect it.
- **Both.** Staff see both buttons and each person connects the one they use.

The setting only changes which buttons staff see. It never disconnects anyone. It is saved in `licensee_settings.workspace_provider` (`m365`, `google` or `both`). The `KS_WORKSPACE_PROVIDER` app setting gives the starting value.

If Google is not set up on the server (section 4), the Connect Google button is greyed out and shows a short explanation. Nothing else changes.

## 3. Setting up Google Cloud (step by step)

Do this once, signed in as the **company account `borealfinancial@gmail.com`**. Do not use a personal account.

### 3.1 Create the project

1. Open <https://console.cloud.google.com/> and sign in as `borealfinancial@gmail.com`.
2. Use the project picker at the top, then choose **New project**.
   - **Name:** `Keystone Workspace`
   - **Organization:** none
3. Choose **Create**, then make sure the new project is selected.

### 3.2 Turn on the four Google services

Go to **APIs & Services → Library**. Search for each of these and choose **Enable**:

1. **Gmail API**
2. **Google Calendar API**
3. **Google Tasks API**
4. **Google Drive API**

### 3.3 Prove you own the website domain

Google verifies only domains you have proven you own.

1. Open <https://search.google.com/search-console> (same account).
2. Add the **Keystone website domain** as a *Domain property*, and add the TXT record it gives you at the domain's DNS host.
3. Do the same for the domain KS-Ops runs on (its sign-in redirect address lives there; see section 3.5).

### 3.4 OAuth consent screen ("Google Auth Platform")

Go to **APIs & Services → OAuth consent screen**. Newer consoles call this **Google Auth Platform → Branding / Audience / Data access**.

1. **Branding**
   - **App name:** `Keystone`. This is what staff see on Google's "Keystone wants to access your Google Account" screen.
   - **User support email:** `borealfinancial@gmail.com`
   - **App logo:** optional. A logo needs its own short review.
   - **App home page:** the Keystone website home page, for example `https://<keystone website>/`
   - **Privacy policy:** a page on the Keystone website. It must say what Google data Keystone uses and why: email it sends, calendar events, tasks, and the folders it creates. It must also say that the data is not sold or used for advertising, and include Google's **Limited Use** statement. *(The privacy policy page and the home page have to exist on the Keystone website before you submit for verification.)*
   - **Terms of service:** optional
   - **Authorized domains:** the Keystone website domain, plus the domain KS-Ops runs on (section 3.5)
   - **Developer contact email:** `borealfinancial@gmail.com`
2. **Audience**
   - **User type:** **External**. Each brokerage's staff sign in with their own Google accounts.
   - While the app is in **Testing**, add up to 100 test users, for example your own staff. Choose **Publish app** when you are ready for verification.
3. **Data access → Add or remove scopes.** Add exactly these:
   - `openid`
   - `.../auth/userinfo.email` (shown as `email`)
   - `.../auth/userinfo.profile` (shown as `profile`)
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/drive.file`

   **Do not add `gmail.readonly` yet.** It is only for the later inbox-sync step (section 5).

### 3.5 Create the OAuth client

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type:** *Web application*. **Name:** `Keystone servers`.
3. Leave **Authorized JavaScript origins** empty. The browser never talks to Google directly.
4. Under **Authorized redirect URIs**, add **one** line, Keystone's redirect broker on KS-Ops (KS_SERVER_M365_ONE_CLICK):
   `https://<KS-Ops address>/api/oauth/callback/google`
   KS-Ops checks the signed state and forwards each sign-in to the right licensee's server, so new licensees need no
   new redirect URI. The KS-Ops address must be on a domain verified in Search Console (step 3.3); `azurewebsites.net`
   cannot be verified.
5. Choose **Create**, then copy the **Client ID** and **Client secret**. Section 4 says where they go.

### 3.6 Submit for Google's standard verification

1. Go back to the consent screen and choose **Publish app**, then **Prepare for verification**.
2. Google asks for:
   - The home page and privacy policy links (section 3.4).
   - **One sentence per scope** explaining why Keystone needs it. For example:
     - *gmail.send:* "Brokers send client emails from their own mailbox, from inside the CRM."
     - *calendar.events:* "Book client meetings with Google Meet links and show the broker's calendar."
     - *tasks:* "Follow-up tasks from the CRM appear in the broker's Google Tasks."
     - *drive.file:* "Create a folder for each client and list the files Keystone put there."
   - **A short demo video**, unlisted on YouTube and about 2 to 4 minutes long. It should show:
     1. Google's consent screen, with the app name and the URL bar visible.
     2. Each permission in use: send an email, book a meeting with a Meet link, create a task, create a client folder.
     3. Disconnecting.
   - Proof that you own the domains (section 3.3).
3. Verification of sensitive scopes is free and usually takes a few days to a few weeks. Answer Google's emails at `borealfinancial@gmail.com` promptly.
4. Until the app is verified, up to 100 users can still use it. They see an "unverified app" warning and must be listed as test users while the app is in Testing.

## 4. Where to put the keys

**On KS-Ops only** (KS_SERVER_M365_ONE_CLICK): set `KS_GOOGLE_OAUTH_CLIENT_ID` and `KS_GOOGLE_OAUTH_CLIENT_SECRET` on the
`ks-ops` App Service. The provisioning step `workspace_apps` writes them, with `KS_OAUTH_BROKER_URL`, to every
licensee's KS-server. Nobody types them per licensee, and brokerages never create a Google project. KS-Ops
`docs/PROVISIONING.md` has the one-time checklist.

Settings a KS-server reads:

| Setting | Value | Required |
|---|---|---|
| `KS_GOOGLE_OAUTH_CLIENT_ID`, `KS_GOOGLE_OAUTH_CLIENT_SECRET` | Keystone's client, written by KS-Ops | yes (unless the two below are set) |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Only for a server with its **own** client (for example a brokerage on its own Internal Workspace app). When set, they win over Keystone's. | no |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | 32 random bytes in base64. The provisioning script generates one per licensee and keeps it. **Never change it**: changing it disconnects everyone, and each person then reconnects once. | yes |
| `KS_OAUTH_BROKER_URL` | Written by KS-Ops: `https://<KS-Ops address>/api/oauth/callback`. With it the redirect URI is `<that>/google`; without it, `{KS_SERVER_URL}/api/google/oauth/callback`. | no |
| `GOOGLE_OAUTH_REDIRECT_URI` | Normally leave blank (overrides both of the above). | no |
| `GOOGLE_OAUTH_RETURN_URL` | Normally leave blank. The default is `{KS_PORTAL_URL}/settings/profile`, where the user lands after connecting. | no |
| `KS_GOOGLE_GMAIL_READ_ENABLED` | Written by KS-Ops (the same value for every licensee). Leave **unset or `false`** until Google has approved the CASA assessment (section 5). `GOOGLE_GMAIL_READ_ENABLED` is the older name and also works. | no |
| `KS_GOOGLE_PUBSUB_TOPIC`, `KS_GOOGLE_PUBSUB_PUSH_TOKEN` | Optional Gmail push (section 5.4). Without them the sync polls every 2 minutes. | no |
| `KS_GMAIL_HISTORY_DAYS` | How far back the first sync looks (default 30 days, at most 500 messages). | no |
| `KS_WORKSPACE_PROVIDER` | `m365`, `google` or `both`. This is only the starting value; the admin setting overrides it. | no |

If no client or the encryption key is missing, Google stays switched off on that server. The portal greys out the
button and Settings > Connections says Keystone sets it up.

There is no "connect the whole domain" option: Keystone does not use domain-wide delegation. Each person clicks
**Connect Google** once.

**Option for a single brokerage on Google Workspace:** that brokerage can have its **own** project with User type
**Internal**, inside its own Workspace. Internal apps used only by the organisation's own accounts skip Google's public
verification and normally the security assessment too. It is the quickest path for a brokerage that wants Gmail inbox
sync. Set that brokerage's own `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` on its server. Confirm Google's current rules
before relying on this.

## 5. Gmail inbox reading: switching it on later

### 5.1 What the switch does

`KS_GOOGLE_GMAIL_READ_ENABLED` is off by default. KS-Ops writes it to every licensee server (provisioning step
`workspace_apps`), so it is switched on once, for everyone, when Keystone's Google client passes the assessment.

| | Off (today) | On (`true`) |
|---|---|---|
| Consent screen asks for | the 7 scopes above | the same 7 **plus `gmail.readonly`** |
| Settings > Connections, My Profile | "Gmail inbox reading is pending Google's security review" | how many people still need to reconnect |
| Gmail sync worker | never started; nothing touches the database or Google | every 2 minutes (and at once on a Gmail push, if set up) |
| First sync ("history sync") | | the last 30 days (`KS_GMAIL_HISTORY_DAYS`), at most 500 messages; no notification storm |
| Later syncs | | Gmail's history API from the stored history id; if Google no longer has it (about a week), a 7-day catch-up |
| Mail **from** a CRM contact | not seen | on the contact's timeline (`communications_messages`, inbound email, linked to the contact's latest application), exactly like Outlook mail. Sequences stop on a reply, the "message received" automation fires, and the person gets a "New email" notification |
| Attachments on that mail | not seen | filed to the contact's documents (like Outlook's inbound attachment worker), up to 25 MB each, inline images skipped |
| Mail sent **from Gmail itself** (phone, gmail.com) to a CRM contact | not seen | on the timeline (`crm_email_log`, with the Gmail thread), like Outlook's Sent Items. Portal sends are skipped because they were logged when sent |
| Read receipts ("Read: subject") | not seen | mark the original email opened, like the Outlook read-receipt worker |
| Portal inbox for Google users | the Outlook inbox only | Communications > Gmail: threads, messages, attachments, "Save to CRM" (`/api/google/gmail`) |

Only messages that match a CRM contact are stored (`gmail_messages`, for de-duplication and threads). Keystone never
copies the rest of a mailbox; the inbox view reads it live from Gmail, as the Outlook inbox reads it from Microsoft.
The never-log list applies throughout.

Turning it on does not grant the new permission by itself. Each person must **reconnect Google once** so the consent
screen can ask for read access. Until they do, the sync skips them and Connections counts them.

### 5.2 The yearly security assessment (CASA)

Restricted Gmail scopes need two things from Google: **restricted-scope verification** (Google reviews the app, the
privacy policy and a demo video) and a **CASA** assessment (Cloud Application Security Assessment), done by an
independent lab authorized by the App Defense Alliance. What we found in October 2026 (check the current rules in
Google's verification email before paying anyone):

- **Tier:** a small app that asks for one restricted scope per user (no domain-wide delegation) is normally asked for
  **Tier 2**: Keystone runs the lab's approved scan, the lab validates it, and Keystone answers a self-assessment
  questionnaire of about 50 questions. Tier 3 (a full lab penetration test) is asked of bigger or riskier apps.
- **Cost (Tier 2):** published prices run from about **US$540 to US$1,500 a year**. TAC Security (the lab Google
  points many developers to) lists Tier 2 at about $540 to $720 (the higher price includes unlimited re-scans);
  Netsentries about $700 to $1,500; Leviathan about $800 to $1,200; others are $1,000 and up. Tier 3, if Google asks for
  it, is about $4,500 to $8,000.
- **Time:** app verification is usually under a week when the demo video and justifications are ready; CASA Tier 2
  takes about 1 to 3 weeks (5 to 20 working days, longer if the scan finds things to fix); Google can take up to a
  week to act on the lab's letter.
- **Every 12 months:** both the verification and the CASA letter must be renewed yearly. Google emails about 90 days
  before, but the approval simply expires if nothing is done. Renewal is quicker when the app has not changed much.
- **Until it is approved:** at most 100 users, an "unverified app" warning, and testing tokens that expire after 7 days.
  That is why the switch stays off.

### 5.3 Steps to switch it on

1. In the consent screen, under **Data access**, add `https://www.googleapis.com/auth/gmail.readonly` (only this one).
   Justification: "Brokers see clients' replies and documents on the CRM timeline, and read their inbox inside the CRM."
2. Submit for restricted-scope verification. Update the demo video to show a client's email arriving on the timeline,
   its attachment filed to the client, and the Gmail inbox in the portal.
3. When Google emails that a CASA assessment is needed, pick an authorized lab (TAC Security is the cheapest Tier 2
   option we found), forward Google's email to it, run its scan against the KS-server and portal, answer the
   questionnaire and fix any findings. The lab sends Google the letter of validation.
4. After Google approves, set `KS_GOOGLE_GMAIL_READ_ENABLED=true` on **KS-Ops**, then re-run the `workspace_apps` step
   for each licensee (or set it on each server, see KS-Ops `docs/PROVISIONING.md`) and restart the servers.
5. Ask Google users to reconnect: Settings > My Profile > Reconnect Google. Connections shows who still has to.
6. Put a yearly reminder in the calendar (about 3 months before the approval date) for the renewal.

### 5.4 Optional: Gmail push

Polling every 2 minutes is enough. For near-instant mail, per licensee server:

1. In Keystone's Google Cloud project, create a Pub/Sub topic and give `gmail-api-push@system.gserviceaccount.com` the
   **Pub/Sub Publisher** role on it.
2. Create a push subscription to `https://<licensee server>/api/gmail-push?token=<a long random value>`.
3. Set `KS_GOOGLE_PUBSUB_TOPIC=projects/<project>/topics/<topic>` and `KS_GOOGLE_PUBSUB_PUSH_TOKEN=<that value>` on
   the server. The worker starts each person's Gmail watch and renews it daily (a watch lasts 7 days).

## 6. Known limits (Google only)

These Microsoft 365 features have no Google equivalent yet:

- **Email**
  - Gmail sends come from the connected address only. There are no shared or "send as" mailboxes.
  - Outlook drafts and **scheduled send** are not available, because `gmail.send` cannot store drafts. The composer hides those buttons for Google users.
  - Delivery receipts are not supported. Read receipts are requested with the standard header, and the recipient's mail app decides whether to send one.
  - Attachments are capped at 25 MB per email, the same as Outlook.
- **Inbox:** once reading is switched on, Google users get Communications > Gmail (threads, messages, attachments, "Save to CRM"). It is read-only: no flags, folders, moving or deleting from the portal, because Keystone asks only for `gmail.readonly`. Shared mailboxes are Microsoft-only.
- **Meetings:**
  - Google Meet meetings get a Meet link, but there are no automatic recordings, transcripts or AI summaries. Those come from the Teams transcript worker.
  - Meeting rooms and app-level (tenant-wide) calendar access stay Microsoft-only.
- **Microsoft-only features:** Outlook contacts sync, out-of-office, presence, the OneDrive file picker and the shared Staff Library.
- **Drive:**
  - `drive.file` lets Keystone see only files it created. Files someone drags into a client folder through Google Drive are in the folder (open it with the link), but the portal's file list shows only what Keystone itself created.
  - For a personal `@gmail.com` account the folder is not shared with anyone. For a Workspace account it is shared (edit) with the whole company domain.
- **Find-a-time:** this shows availability for teammates who have connected Google themselves, because each person's own connection is used.

## 7. How it works (for developers)

**Connect, status and disconnect** (`src/routes/googleOAuth.ts`, mounted at `/api/google`)

- The authorization-code flow uses offline access and PKCE (S256).
- The `state` value is a random single-use nonce:
  - stored as sha256 with the user ID and the PKCE verifier in `google_oauth_states`, valid for 10 minutes;
  - also held in an HttpOnly, Secure, SameSite=Lax cookie, the same as the Microsoft connect.
- Disconnect revokes the grant at `oauth2.googleapis.com/revoke`.

**Tokens** (`google_workspace_accounts`)

- Tokens are encrypted with AES-256-GCM using `GOOGLE_TOKEN_ENCRYPTION_KEY`, in `src/services/workspace/tokenCrypto.ts`.
- `getGoogleForUser()` refreshes the token a minute before it expires, and retries once on a 401. Only one refresh runs per user at a time.
- When Google answers `invalid_grant`, the account is marked `reauth_required` and the portal shows **Reconnect Google**.

**Provider abstraction** (`src/services/workspace/{index,o365,google}.ts`)

- `getWorkspaceForUser()` returns `sendMail`, `createEvent`, `busyTimes`, `createTask`, `ensureClientFolder` and related operations for either provider.
- The order is Microsoft 365 first, then Google.
- The existing Microsoft routes keep their own Graph code unchanged. The Google halves sit beside them:
  - `/api/o365/mail/send`: the Gmail branch, built with `gmailMime.ts`, shares the merge fields, signature, collateral, tracking pixel and timeline logging.
  - `/api/calendar/*`: `googleCalendarRoutes.ts`
  - `/api/o365/meetings/schedule` and CRM meetings: Google Meet
  - client booking: `clientBooking.ts`
  - Google Tasks: `workers/googleTasksWorker.ts`
  - Drive folders: `googleFeatures.ts`

**Gmail inbox reading** (KS_SERVER_GMAIL_INBOX): `modules/gmail/gmailApi.ts` (Gmail calls and message parsing),
`modules/gmail/gmailSync.ts` (history sync, history API, timeline, attachments, receipts), `modules/gmail/gmailPush.ts`
(Pub/Sub watch), `routes/gmail.ts` (`/api/google/gmail`), `routes/gmailPush.ts` (`/api/gmail-push`), the worker
`workers/gmailSyncWorker.ts` (started from `index.ts` only when the switch is on), migration
`2026_11_06_ks_gmail_inbox.sql`.

**Tests:** `src/__tests__/googleOAuth.v12.test.ts`, `src/__tests__/googleWorkspace.v12.test.ts`,
`src/modules/gmail/__tests__/gmailInbox.test.ts` and `src/__tests__/ksGmailInbox.integration.test.ts`. They include the
check that the restricted scope is never requested, and nothing reads mail, while the switch is off.
