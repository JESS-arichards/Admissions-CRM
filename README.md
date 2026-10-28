# Admissions CRM

On screens up to 600px wide, the shared navigation title wraps rather than
truncating. The logo is capped at 80px wide and information/menu controls retain
their touch targets. Longer titles can increase the header height.

A public-facing school admissions site and staff workspace, inspired by the
pipeline-based CRM workflow popularised by HubSpot. This is an independent
implementation, not a HubSpot integration or reproduction of its proprietary UI.

## First release

- Public welcome, admissions, school visit and privacy information pages.
- Enquiries and visit requests, without parent registration.
- A random, case-sensitive **32-character tracking code** (192 bits of randomness),
  shown once after submission. Only its SHA-256 digest is stored in the request table.
- Parent progress timeline containing only request type, stage, dates and explicitly
  published updates. Contact details, original messages, ownership and internal notes
  are never returned by the tracking API.
- Optional email updates using a separately configured Microsoft 365 mailbox.
  A separate, single-use email confirmation token expires after 24 hours.
  Parents can enable, resend verification or unsubscribe using their tracking code.
- Staff pipeline with search, stage filters, pagination, self-assignment, internal
  notes, parent-facing updates and activity history. Stage changes are public.
- Admissions administrators can edit and publish public information. Content is
  plain text, not executable HTML. Privacy cannot be unpublished.
- Optimistic revisions prevent staff from overwriting concurrent request/page changes.

Formal admissions applications, child records, fee payments,
automated visit bookings, parent reply threads and HubSpot synchronisation are
**not** included. A visit request is not a booking and an enquiry is not an application.

Parents can upload, list and download enquiry documents **after looking up their
private tracking code**. Authenticated Admissions staff can do the same on request
details. All documents, including staff uploads, are visible to the code holder.

## Architecture and shared services

| Area | Implementation |
| --- | --- |
| Client | React 19, Vite, TypeScript, responsive glass design and Portal navigation |
| Server | Node.js 24, Express 5, Zod, Helmet, rate limiting, Pino |
| Data | A separate Azure SQL / SQL Server Admissions database |
| Staff identity | Portal `/api/platform/v1`, Microsoft Entra ID and independent signed session cookie |
| Brand | Same-origin proxy of Portal `/api/branding` and branding assets |
| Email | Microsoft Graph application `Mail.Send`, durable SQL outbox |
| Documents | Private Azure Blob Storage; references and metadata in Admissions SQL |

The Applications Portal is the **only user directory and role authority**.
There are no local accounts, duplicate passwords or local role grants.

| Central Portal role | Admissions access |
| --- | --- |
| Full Admin | All staff operations and content administration |
| Admissions Admin | All staff operations and content administration |
| Admissions Contributor | View and manage requests, assignment and notes |
| Any other role | No staff access |

Assign these roles in **Portal > Admin > Users**. Every protected Admissions request
checks live central account activation, session version and roles. An outage fails
closed, with no local/cached authorisation fallback. New consumer sign-in cannot
bootstrap Full Admin. My Profile links to the Portal; Admissions has no profile page.

Organisation name, logo, footer logo, favicon, background, colours and values come
from the Portal. Admissions page text remains in Admissions. Portal branding failure
is shown explicitly instead of silently creating a second brand store. Custom Portal
text colours are applied as configured; administrators must check contrast.

Navigation is a checked-in copy of the Portal's canonical component. Do not edit
`client/src/navigation` directly. From the Portal checkout:

```powershell
node scripts\sync-navigation.mjs ..\Admissions-CRM
node scripts\sync-navigation.mjs --check ..\Admissions-CRM
```

Commit updated copies in this repository. Branding colour helpers and their tests
were also reused from the Portal; keep their behaviour aligned when updating them.

User-facing dates use the shared UK display policy: short dates are
`DD/MM/YYYY`, long dates are `D Month YYYY`, and date-times retain their time.
The canonical helper is `Applications-Portal/shared/dateFormatting.ts`; do not
edit the synchronized `shared/dateFormatting.ts` here. After changing the policy,
run `node scripts/sync-date-formatting.mjs` from the Applications-Portal root.
Commit and deploy all repositories together so their shared copies stay aligned.
This is a code policy, not a runtime administrator setting. API/database values,
logs, date inputs, filenames and machine-oriented exports remain in their
interoperable formats; human-facing export report dates should use the UK policy.
Native `type="date"` controls remain browser-locale dependent.

## Local development

1. Install Node.js 24 and provision an **empty, separate Admissions SQL database**.
   Do not point this application at the Portal database.
2. Copy `.env.example` to `.env` and fill in the settings below. Never commit `.env`.
3. In the Portal, set `PLATFORM_ADMISSIONS_KEY` to a randomly generated secret
   of at least 32 characters. Use the same value for Admissions `PLATFORM_API_KEY`.
   Do not reuse the Learn key or a cookie-signing secret.
4. Use the Portal's **same Entra tenant and SPA client registration**.
   Add `http://localhost:5174/auth/callback.html` as a SPA redirect URI.
5. Assign your staff account a central Admissions role, or use a Portal Full Admin.
6. Run:

```powershell
npm ci
npm run dev
```

Browse `http://localhost:5174`. Vite proxies `/api` to port 8081.
If using other ports, update Vite's proxy and `PUBLIC_BASE_URL` together.
By default the server validates required configuration and migrates its database before listening.
There is no fake-data mode or silent email-to-console fallback.

## Server configuration

| Setting | Required / purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | Admissions origin, HTTPS in production; e.g. `https://admissions.example.org` |
| `APPLICATIONS_PORTAL_URL` | Portal's matching-environment `PUBLIC_BASE_URL`; used for central API, brand and profile |
| `PLATFORM_API_KEY` | Server-only secret matching Portal `PLATFORM_ADMISSIONS_KEY`, minimum 32 characters |
| `SESSION_SECRET` | Separate random Admissions cookie-signing secret, minimum 32 characters |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` | Same names and matching-environment values as Portal; both are required |
| `SQL_CONNECTION_STRING` | Admissions DB connection string; Azure `SQLAZURECONNSTR_DefaultConnection` also supported |
| `SQL_SERVER`, `SQL_DATABASE` | Alternative to a connection string |
| `SQL_AUTH` | `managed-identity` (default) or `sql` |
| `SQL_MANAGED_IDENTITY_CLIENT_ID` | Optional user-assigned managed identity client ID |
| `SQL_USER`, `SQL_PASSWORD` | Required for discrete SQL authentication |
| `SQL_ENCRYPT` | `true` by default |
| `SQL_TRUST_SERVER_CERTIFICATE` | `false` by default; use only for local development if needed |
| `SQL_SERVERLESS_ENABLED` | Strict `true`/`false`, default `false`. Optional development Azure SQL serverless wake/manual-mail mode; leave unset or `false` in production |
| `AZURE_STORAGE_CONNECTION_STRING` | Server-only HTTPS account-key connection string (no SAS/emulator); enables documents |
| `AZURE_STORAGE_CONTAINER` | Private, pre-created container; default `admissions-files` |
| `GRAPH_CLIENT_SECRET`, `MAIL_FROM_ADDRESS` | Configure both to enable email; leave both unset to disable opt-in. The app needs Graph application `Mail.Send` with admin consent |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID` | Optional overrides for the mail app registration; default to `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` (same as the Applications Portal) |
| `TRUST_PROXY_HOPS` | `0` locally; set the exact trusted hop count for hosting (usually `1` on App Service) |
| `PORT` | `8081` by default; set as required by your host |
| `NODE_ENV` | `production` in deployed environments |
| `LOG_LEVEL` | `info` by default |

URLs must be origins, without credentials, paths, query strings or fragments.
Keep all credentials in server environment settings / Key Vault, never Vite variables.
Use independent credentials, databases and registrations/configuration per environment.
Use HTTPS for all production traffic. A production cookie is Secure, HttpOnly and
SameSite=Strict, scoped to Admissions with its own name and eight-hour lifetime.

### Optional development SQL serverless auto-pause

For a **development-only** Azure SQL serverless database, enable auto-pause in Azure.
The `jess-admissions-dev` deployment workflow automatically sets
`SQL_SERVERLESS_ENABLED=true` and the App Service Health check path `/api/live` on that
app only, after Azure login and before deployment. You still configure the SQL
connection settings below. For other development hosts, set the flag manually.
This does not provision/change Azure SQL service tier or auto-pause delay. Use a fresh,
separate development Admissions database; no data migration is needed. Production
keeps normal startup and automatic mail polling: do not enable this flag there.

Connection settings have this precedence: `SQL_CONNECTION_STRING`, then Azure App
Service's `SQLAZURECONNSTR_DefaultConnection`, then `SQL_SERVER` / `SQL_DATABASE`
with `SQL_AUTH`. Connection-string credentials/authentication take precedence over
discrete `SQL_USER` / `SQL_PASSWORD` or managed-identity settings. For discrete SQL
authentication set `SQL_AUTH=sql` with both credentials; otherwise use managed identity
(and optionally `SQL_MANAGED_IDENTITY_CLIENT_ID`). Never put SQL credentials in client settings.

Serverless mode enforces pool minimum zero and 30-second idle eviction, including
connection-string configurations. It bounds startup connection attempts to ten seconds
and retries known transient connection/wake failures (including Azure SQL 40613)
with exponential backoff for approximately 90 seconds total. Authentication/configuration
errors fail immediately. Migrations run once after connecting; migrations and application
queries/writes are **never automatically replayed**, because a lost acknowledgement
may mean a write already committed. Exhausted wake retries or migration failures fail
startup; inspect logs and restart after correcting the cause.

The HTTP listener starts before SQL initialization only in serverless mode.
`GET /api/live` returns 200 without accessing SQL, storage, Portal or Graph. Dependent
`/api` endpoints return **503** with **Retry-After: 10** until migrations finish.
Use **`/api/live` as the development App Service Health check path**, and use it for
uptime probes so they do not prevent SQL auto-pause. Do not monitor `/api/health`,
`/api/config`, or other dependency-touching endpoints on a schedule in this mode:
`/api/health` still deliberately queries SQL and checks document storage.
Liveness is not a dependency readiness check. Other applications, SQL tools, open
connections and monitoring can also prevent auto-pause.

At runtime recognized transient SQL errors return 503 with Retry-After rather than
logging staff out or deleting their session. Central Portal availability is still required
for every protected operation; no cached-authority bypass is introduced. Before retrying
a failed write, check whether it completed; the server does not retry it for you.

**Development background processing is manual.** Serverless mode starts no mail
polling timer. Requests still enqueue real messages in the durable SQL outbox.
A signed-in, active **central Full Admin** (not Admissions Admin/Contributor) can run:

```javascript
// From the Admissions origin, using the existing signed-in session.
await fetch('/api/admin/background-jobs/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
}).then(async response => ({ status: response.status, result: await response.json() }));
```

This same-origin, CSRF-protected endpoint is limited to six accepted runs per minute,
is unavailable in normal mode, and rejects overlapping in-process batches with 409.
Each run processes at most ten queued mail jobs using the configured Graph mailbox
and returns `{ sent, failed }`. Delivery failures return 502 with counts, SQL resume
errors return 503, and missing email configuration fails explicitly. No delivery or
database errors are silently reported as success. Run again manually for remaining
jobs or after their SQL outbox retry delay (up to eight attempts); expiring confirmation
tokens and queue delays still apply. The outbox uses database leases across instances
and remains at-least-once delivery: an ambiguous Graph response or a lost completion
acknowledgement can lead to later duplicate delivery. This is not a scheduler or an
exactly-once guarantee. With the flag off, the existing five-second mail worker continues.

### Private enquiry documents

Provision an Azure Storage account with **Allow Blob anonymous access disabled**,
and a container with **Public access level: Private**. The application refuses
document operations if the container reports anonymous access; it never creates
public containers or issues SAS/download URLs.
Set only `AZURE_STORAGE_CONNECTION_STRING` and `AZURE_STORAGE_CONTAINER`, matching the Portal naming;
prefer a separate Admissions container/account and matching-environment settings.
Never use Vite variables for credentials. Connection strings are server-only.

Startup migrates existing Admissions databases to version 2 without replacing
data. Alternatively run rerunnable `database\schema.sql` for new/existing databases,
or `database\002-documents.sql` for an existing version-1 database. Back up first;
the migration identity needs table/index creation permissions. No Portal database
or role changes are required.

Limits are **5 documents total per enquiry** (parent and staff combined), **10 MiB
(10,485,760 bytes) per file**. This intentionally bounded first release has no delete
or replace UI; contact Admissions if the limit is reached. Allowed types: PDF, DOCX,
XLSX, PPTX, PNG, JPG/JPEG, WEBP and GIF. Clients check size/extension; the server checks
signatures or Office ZIP structure/content types and rejects macros, embedded
executables/OLE objects, encrypted Office archives and ZIP bombs. Office archives
are limited to 2,048 entries, 100 MiB declared expanded content and a 64 KiB content
types manifest. This is validation, **not malware scanning**; deploy an appropriate
malware scanning/quarantine policy before handling untrusted documents at scale.

Original bytes are stored and downloaded unchanged: no conversion, image
re-encoding or document/HTTP compression. Metadata is separate in SQL; blob names
are server-generated. Uploads are raw binary, one file at a time, with the tracking
secret in a header (or existing staff cookie), never a URL. Parent list/download
requests carry the tracking code in JSON. Origin checks and live central staff-role
checks remain mandatory. Downloads are proxied attachments with safe filenames,
`private, no-store` and `nosniff`, never public blob links. Configure reverse proxies
and diagnostics not to log request bodies, cookies, or `X-Tracking-Code`.

Per server process, each parent/staff document router permits two uploads and eight
streaming downloads concurrently (four uploads/sixteen downloads combined), rejects
excess work rather than queuing bodies, caps upload bodies and applies a 30-second
upload inactivity timeout and document rate limits. SQL serializable enquiry locks
enforce the shared five-file count across instances. On known SQL insert failure,
the newly uploaded blob is deleted. An uncertain commit acknowledgement or lost
storage acknowledgement may leave a private orphan; reconcile SQL references
against blobs operationally, and monitor cleanup failures. Do not delete a blob
automatically after an ambiguous commit, which could have succeeded.

`/api/config` and `/api/health` include non-secret document readiness. Readiness checks
the configured container exists, is private and is accessible for metadata reads;
it does not guarantee write permission. Missing/inaccessible storage returns **503**
for upload/download but does not prevent existing enquiries, tracking, staff work,
or document metadata listings. No local-disk fallback is provided. Publish approved
privacy/retention information covering documents; existing privacy page content is
preserved by migration, so review it before enabling uploads.

Storage initialization/operation failures and public-container rejection are logged
through the server logger. Diagnostics contain only fixed operation/reason names,
numeric HTTP status and allowlisted error codes/types—not Azure exception messages,
stacks, request objects, storage URLs, connection strings or tracking secrets.
Missing storage configuration produces a startup warning; normal enquiries remain
available. Keep warning/error logs enabled when diagnosing storage permissions.

### Consistent identity and mail settings across applications

Use the Portal's existing setting names and the same values within the matching
environment for `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `GRAPH_CLIENT_SECRET` and
`MAIL_FROM_ADDRESS`. No additional `GRAPH_TENANT_ID` or `GRAPH_CLIENT_ID` is required
when mail uses the Entra registration: both default to their `ENTRA_*` equivalents,
just as in the Portal. Explicit Graph overrides remain supported for a different
mail registration; its secret must belong to that registration.

`ENTRA_CLIENT_SECRET`, if present in the shared configuration, is not needed for
browser SPA sign-in and is not substituted for `GRAPH_CLIENT_SECRET`.
`ENTRA_ALLOWED_DOMAINS` and `INITIAL_ADMIN_EMAIL` remain Portal-owned: Admissions
delegates identity verification and domain restrictions to the Portal and never
bootstraps an administrator locally. Copying an initial-admin setting into Admissions
does not grant access. Assign Admissions roles centrally in Portal Admin > Users.

Setting names should stay consistent, but not every value is shared:
`SESSION_SECRET`, SQL database configuration and each app's `PUBLIC_BASE_URL` must
remain app-specific. Admissions `PLATFORM_API_KEY` must match the Portal's
`PLATFORM_ADMISSIONS_KEY`. Shared configuration is not automatically synchronised
between Azure App Services; configure the same environment-scoped values or Key
Vault references when provisioning each app. Do not share development credentials
with production.

### Email setup and reliability

Grant the email app Microsoft Graph **application** `Mail.Send` permission with admin
consent. Restrict its mailbox scope using Exchange application access controls.
`MAIL_FROM_ADDRESS` must be a mailbox this app is allowed to send as. It can use the
same configured address as the Portal; Admissions reads the environment setting,
not the Portal's branding-level notification-address override.

Confirmation is explicit (a button on the email landing page, not a GET side effect).
Confirmation secrets are in URL fragments, removed from browser history by the page,
and POSTed to the API. They never create a tracking or staff session.

Request creation and confirmation-mail queueing share a transaction. Public staff
updates and update-mail queueing also share a transaction. Internal notes/assignment
alone never trigger parent notifications. The worker leases jobs across instances,
rechecks notification eligibility, retries up to eight attempts with backoff and
exposes pending/failed counts in staff request details. Opt-out cancels queued mail;
mail already being submitted to Graph may still arrive.

Graph acceptance is not proof of inbox delivery. This is **at-least-once** delivery:
a crash after Graph accepts an email but before SQL records success can cause a
duplicate. Neither updates nor email logs contain the tracking code. Notification
emails contain no request details. Confirmation tokens are temporarily stored in the
outbox to permit retries and cleared on success, cancellation or retry exhaustion.
Protect the database and backups accordingly. Failed delivery is not silently
reported as sent. Parents can always use their saved code to check progress.

## Build and Azure deployment

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Deploy the standalone repository to an Azure App Service running Node.js 24.
Build with development dependencies available; deploy `dist`, `package.json`,
`package-lock.json` and production dependencies. Start with `npm start`. Front end
and API are hosted by the same Node service. Configure HTTPS-only, the correct port,
**Always On** (the normal-mode mail worker runs in-process), environment settings, SQL firewall/
network access and database permissions. No sibling checkout is required at runtime.
CI validates pull requests and pushes. The development deployment workflow validates,
builds and deploys pushes to `development` to the existing `jess-admissions-dev`
App Service. Before deployment it enables development-only `SQL_SERVERLESS_ENABLED=true`
and Health check path `/api/live` on that app, failing explicitly if it cannot find
exactly one app or lacks permission; setting values are not printed. After deployment
it checks `/api/live`, then deliberately checks `/api/health` (which wakes SQL).
It does not change the legacy workflow, other apps, database names or credentials.
It uses the repository's Azure OIDC secrets
and does not provision resources or set application credentials. The older
`admissions-crm` deployment workflow is manual-only so development pushes do not
deploy to a second app.
For initial development setup, the deployment workflow's manual `configure_runtime`
option configures the approved Portal origin `https://appsdev.jess.sch.ae` and
generates an independent `SESSION_SECRET` only if that setting is missing. Generated
values are masked, captured Azure responses are not logged, and existing session
secrets are preserved. This option is off by default and never runs on a push.

Enable a managed identity and create its SQL user if using managed identity.
On first startup, the identity needs DDL rights to create Admissions tables and
indexes. Startup migrations in `server/db.ts` are versioned, transactional and
serialised with `sp_getapplock`. SQL schema uses `Admissions*` tables; central users
and branding are never migrated/copied. Coordinate schema privileges with your DBA;
do not grant access to the Portal database.

To configure the Admissions database manually (for example when the app identity
lacks DDL rights), run [database/schema.sql](database/schema.sql) against the
**Admissions** database with SSMS, the Azure SQL query editor or
`sqlcmd -S <server> -d <admissions-db> -G -b -i database\schema.sql`. It only creates
missing tables, indexes and starter pages, never replaces existing data, and is safe
to rerun. It records schema versions 1 and 2; startup preserves existing tables/data.
The central Admissions roles live in the Portal database and are created by the
Portal's own `database/schema.sql` (migration v22).

Add the deployed `https://<admissions-host>/auth/callback.html` SPA redirect URI to
the Portal's Entra registration. MSAL 5 uses a dedicated redirect bridge page for
popup sign-in; this page must stay free of application routing/bootstrap code.
Staff must allow the Microsoft sign-in popup.

### Before public launch

- Publish school-approved admissions, visits and privacy text. Replace the starter
  privacy notice with actual school controller/contact, purposes, legal basis,
  retention and rights information. Establish retention/deletion procedures for
  requests, documents/blobs, audit history, queued mail and backups; no automatic purge is provided.
- Verify Portal brand assets and colours, and configure official contact details in
  the information pages. Avoid sensitive personal details in parent-facing updates.
- Check `/api/health` (SQL and separate document readiness), `/api/config`,
  `/api/branding`, brand assets and the dedicated callback URL. A healthy database
  alone does not prove storage readiness. Health checks do not exercise Portal or Graph.
- If documents are enabled, verify parent/staff upload/list/download against real
  Azure Storage, role revocation, the sixth-file rejection and exact byte equality
  after download. Confirm anonymous blob access fails and no secret appears in URLs/logs.
- Sign in as Full Admin, Admissions Admin and Contributor; confirm role limits.
  Remove a role or disable a user centrally and confirm the next protected request
  fails. Check central outage behaviour.
- Submit both request types, save the code, update a request as staff, then track it
  anonymously. Confirm internal notes/contact details are not shown.
- Verify opt-in, expired/reused links, resend cooldown, unsubscribe and actual email
  delivery from the configured mailbox. Check failed-email counts and worker logs.
- Check desktop/mobile navigation and forms with the school's real branding.
- Configure database backups, monitoring, restricted mailbox permissions and a
  privacy-approved operational process for lost tracking codes. Codes cannot be
  recovered through the site.

Public creation, tracking, sign-in and email actions are rate-limited. Limits are
in-process; for multiple App Service instances enforce aggregate limits and bot
protection at your trusted ingress/WAF. Set `TRUST_PROXY_HOPS` correctly so public
clients cannot spoof forwarded IPs. All mutation requests require JSON (except raw
`application/octet-stream` document uploads) and an Origin header exactly matching
`PUBLIC_BASE_URL`; there is no cross-origin API.
No tracking code is put into a query string, cookie or local storage.

## Validation

`npm test` covers permission boundaries, central disablement/role revocation/outage,
public validation, session cookies, consent endpoints, one-time confirmation checks,
outbox eligibility/retries, concurrency and explicit public response projections,
plus shared navigation/brand colour tests. SQL unit tests mock the driver; API tests
use real local HTTP with mocked central/data services. They do **not** replace live
Azure SQL, Blob Storage, Entra and Graph smoke tests. Browser checks with mocked APIs can validate
UI flows but are not proof of external service integration.