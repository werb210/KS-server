# Google Workspace in Keystone

Keystone can now work with **Google Workspace** as well as **Microsoft 365**. A brokerage picks one of the two, or both. Each staff member then connects their own Google account from **Settings → My Profile → Connect Google**.

This page covers:

1. What works today, and what stays off for now
2. The company setting
3. Setting up Google Cloud (a one-time job, done under the company Google account)
4. Where to put the keys
5. Gmail inbox sync: how to switch it on later, and the yearly security assessment it needs
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

**Built but switched off: Gmail inbox sync.** Reading mail needs `gmail.readonly`, which Google classes as **restricted**. Restricted permissions need a yearly third-party security assessment (CASA, see section 5). While the switch is off:

- Keystone never asks Google for `gmail.readonly`.
- The sync never runs.

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
3. Do the same for every domain the licensee servers run on (see section 4.2).

### 3.4 OAuth consent screen ("Google Auth Platform")

Go to **APIs & Services → OAuth consent screen**. Newer consoles call this **Google Auth Platform → Branding / Audience / Data access**.

1. **Branding**
   - **App name:** `Keystone`. This is what staff see on Google's "Keystone wants to access your Google Account" screen.
   - **User support email:** `borealfinancial@gmail.com`
   - **App logo:** optional. A logo needs its own short review.
   - **App home page:** the Keystone website home page, for example `https://<keystone website>/`
   - **Privacy policy:** a page on the Keystone website. It must say what Google data Keystone uses and why: email it sends, calendar events, tasks, and the folders it creates. It must also say that the data is not sold or used for advertising, and include Google's **Limited Use** statement. *(The privacy policy page and the home page have to exist on the Keystone website before you submit for verification.)*
   - **Terms of service:** optional
   - **Authorized domains:** the Keystone website domain, plus the domain the licensee servers run on (section 4.2)
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
4. Under **Authorized redirect URIs**, add one line for **each licensee server**:
   `https://<that licensee's KS-server address>/api/google/oauth/callback`
   Also add the development server:
   `https://ks-server-dev-chb5htbwaue2hygk.canadacentral-01.azurewebsites.net/api/google/oauth/callback` (for testing only)
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

### 4.1 App settings on each licensee's KS-server

Go to **Azure → that licensee's KS-server App Service → Settings → Environment variables (Configuration)**. If the licensee's GitHub environment (`ks-<code>`) feeds the deploy, put the values there too.

| Setting | Value | Required |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Client ID from step 3.5 | yes |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Client secret from step 3.5 | yes |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | 32 random bytes in base64. Generate with `openssl rand -base64 32`. **Use a different key for each licensee and never change it.** Changing it disconnects everyone, and each person then reconnects once. | yes |
| `GOOGLE_OAUTH_REDIRECT_URI` | Normally leave blank. The default is `{KS_SERVER_URL}/api/google/oauth/callback`, and it must match a redirect URI added in step 3.5 exactly. | no |
| `GOOGLE_OAUTH_RETURN_URL` | Normally leave blank. The default is `{KS_PORTAL_URL}/settings/profile`, where the user lands after connecting. | no |
| `GOOGLE_GMAIL_READ_ENABLED` | Leave **unset or `false`**. Set it to `true` only after the CASA assessment (section 5). | no |
| `KS_WORKSPACE_PROVIDER` | `m365`, `google` or `both`. This is only the starting value; the admin setting overrides it. | no |

The server must also know its own public address: `KS_SERVER_URL` is already set for Microsoft and Twilio callbacks. Restart the App Service after saving.

If the client ID, the client secret or the encryption key is missing, Google stays switched off on that server and the portal greys out the button.

### 4.2 One Google OAuth client for every licensee (recommended)

**Recommendation: use one Google Cloud project and one OAuth client, owned by `borealfinancial@gmail.com`, for all licensees.** Each licensee server gets its own redirect URI on that client.

- **Why this works:** the callback is handled by each licensee's own server, at `/api/google/oauth/callback`. Each server keeps its own users' tokens in its own database, encrypted with its own key. Sharing the client ID does not share any data.
- **Why it is simplest:**
  - You go through Google's verification **once**, and every licensee benefits.
  - Adding a licensee means adding one redirect URI in step 3.5 and pasting the same ID and secret into their server.
  - Brokers see one consistent "Keystone" consent screen.
- **The one catch: domains.** Google accepts redirect URIs only on **authorized, verified domains**. You cannot verify `*.azurewebsites.net`. So give every licensee server a hostname under a domain the company owns and has verified in Search Console. For example, add an Azure custom domain such as `<licensee-code>.api.<keystone domain>`, then set `KS_SERVER_URL` to it. After that, adding a licensee does not require a new verification.
- **What doesn't work as well:**
  - A separate Google project for each licensee means a separate verification each time.
  - Putting redirect URIs on licensees' own domains would require the company to verify domains it does not own.
- **Option for a single brokerage on Google Workspace:** that brokerage can create its **own** project, with User type **Internal**, inside its own Workspace. Internal apps used only by the organisation's own accounts skip Google's public verification, and normally the security assessment too. This is the quickest path for a brokerage that wants Gmail inbox sync. Confirm Google's current rules before relying on this. The only change on its server is to paste that brokerage's own client ID and secret.

## 5. Gmail inbox sync: switching it on later

### 5.1 What the switch does

`GOOGLE_GMAIL_READ_ENABLED` is off by default.

| | Off (today) | On (`true`) |
|---|---|---|
| Consent screen asks for | the 7 scopes above | the same 7 **plus `gmail.readonly`** |
| Gmail sync worker | never started; `syncGmailOnce()` returns without touching the database or Google | starts on boot and polls every 3 minutes |
| Mail **from** a CRM contact | not seen | written to the contact's timeline (`communications_messages`, inbound email), exactly like Outlook mail. Sequences stop on a reply, the "message received" automation fires, and the user gets a "New email" notification |
| Mail sent **from Gmail itself** (phone, gmail.com) to a CRM contact | not seen | written to the timeline (`crm_email_log`), like Outlook's Sent Items. Mail sent from the portal is skipped because it was logged when it was sent |

Turning it on does not grant the new permission by itself. Each person must **reconnect Google once** so the consent screen can ask for read access. Until they do, the sync skips their account.

### 5.2 The yearly security assessment (CASA)

Restricted Gmail scopes require Google's **Cloud Application Security Assessment (CASA)**:

- **Who does it:** an independent lab authorized by the App Defense Alliance. Google's verification email lists them.
- **Cost:** roughly **US$500 to US$5,000 a year**, depending on the lab and the assessment tier. Google usually asks a small app for Tier 2, a lab-verified scan.
- **How often:** **every 12 months**. Google emails a reminder before the letter of assessment expires. If it lapses, Google can block the restricted scope until it is renewed.
- **How long it takes:** usually a few weeks. Most of that is the lab's questionnaire and scan, then fixing anything it finds.

### 5.3 Steps to switch it on

1. In the consent screen, under **Data access**, add `https://www.googleapis.com/auth/gmail.readonly`. Explain why: "Show brokers' replies from clients on the CRM timeline."
2. Submit for restricted-scope verification. Update the demo video to show a client's email appearing on the timeline.
3. Do the CASA assessment with an authorized lab when Google asks, and send Google the letter of assessment.
4. After Google approves, set `GOOGLE_GMAIL_READ_ENABLED=true` on each licensee's KS-server and restart it.
5. Ask Google users to reconnect: Settings → My Profile → Disconnect Google → Connect Google.
6. Put a yearly reminder in the calendar for the CASA renewal.

## 6. Known limits (Google only)

These Microsoft 365 features have no Google equivalent yet:

- **Email**
  - Gmail sends come from the connected address only. There are no shared or "send as" mailboxes.
  - Outlook drafts and **scheduled send** are not available, because `gmail.send` cannot store drafts. The composer hides those buttons for Google users.
  - Delivery receipts are not supported. Read receipts are requested with the standard header, and the recipient's mail app decides whether to send one.
  - Attachments are capped at 25 MB per email, the same as Outlook.
- **Inbox:** the portal's Inbox screen still reads Outlook. With Google, client email reaches the CRM through the inbox sync above, once it is switched on.
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

**Gmail inbox sync:** `workers/gmailSyncWorker.ts`. It is started from `index.ts` only when `GOOGLE_GMAIL_READ_ENABLED=true`.

**Tests:** `src/__tests__/googleOAuth.v12.test.ts` and `src/__tests__/googleWorkspace.v12.test.ts`. They include the check that the restricted scope is never requested while the switch is off.
