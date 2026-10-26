# Admissions CRM

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

Formal admissions applications, document uploads, child records, fee payments,
automated visit bookings, parent reply threads and HubSpot synchronisation are
**not** included. A visit request is not a booking and an enquiry is not an application.

## Architecture and shared services

| Area | Implementation |
| --- | --- |
| Client | React 19, Vite, TypeScript, responsive glass design and Portal navigation |
| Server | Node.js 24, Express 5, Zod, Helmet, rate limiting, Pino |
| Data | A separate Azure SQL / SQL Server Admissions database |
| Staff identity | Portal `/api/platform/v1`, Microsoft Entra ID and independent signed session cookie |
| Brand | Same-origin proxy of Portal `/api/branding` and branding assets |
| Email | Microsoft Graph application `Mail.Send`, durable SQL outbox |

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
The server validates required configuration and migrates its database before listening.
There is no fake-data mode or silent email-to-console fallback.

## Server configuration

| Setting | Required / purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | Admissions origin, HTTPS in production; e.g. `https://admissions.example.org` |
| `APPLICATIONS_PORTAL_URL` | Portal's matching-environment `PUBLIC_BASE_URL`; used for central API, brand and profile |
| `PLATFORM_API_KEY` | Server-only secret matching Portal `PLATFORM_ADMISSIONS_KEY`, minimum 32 characters |
| `SESSION_SECRET` | Separate random Admissions cookie-signing secret, minimum 32 characters |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` | Same tenant and SPA application registration as Portal |
| `SQL_CONNECTION_STRING` | Admissions DB connection string; Azure `SQLAZURECONNSTR_DefaultConnection` also supported |
| `SQL_SERVER`, `SQL_DATABASE` | Alternative to a connection string |
| `SQL_AUTH` | `managed-identity` (default) or `sql` |
| `SQL_MANAGED_IDENTITY_CLIENT_ID` | Optional user-assigned managed identity client ID |
| `SQL_USER`, `SQL_PASSWORD` | Required for discrete SQL authentication |
| `SQL_ENCRYPT` | `true` by default |
| `SQL_TRUST_SERVER_CERTIFICATE` | `false` by default; use only for local development if needed |
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

### Email setup and reliability

Grant the email app Microsoft Graph **application** `Mail.Send` permission with admin
consent. Restrict its mailbox scope using Exchange application access controls.
`MAIL_FROM_ADDRESS` must be a mailbox this app is allowed to send as; it is independent
of the Portal notification mailbox and is not taken from shared branding.

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
**Always On** (the mail worker runs in-process), environment settings, SQL firewall/
network access and database permissions. No sibling checkout is required at runtime.
CI validates pull requests and pushes. The development deployment workflow validates,
builds and deploys pushes to `development` to the existing `jess-admissions-dev`
App Service, then checks `/api/health`. It uses the repository's Azure OIDC secrets
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

Add the deployed `https://<admissions-host>/auth/callback.html` SPA redirect URI to
the Portal's Entra registration. MSAL 5 uses a dedicated redirect bridge page for
popup sign-in; this page must stay free of application routing/bootstrap code.
Staff must allow the Microsoft sign-in popup.

### Before public launch

- Publish school-approved admissions, visits and privacy text. Replace the starter
  privacy notice with actual school controller/contact, purposes, legal basis,
  retention and rights information. Establish retention/deletion procedures for
  requests, audit history, queued mail and backups; no automatic purge is provided.
- Verify Portal brand assets and colours, and configure official contact details in
  the information pages. Avoid sensitive personal details in parent-facing updates.
- Check `/api/health` (SQL readiness), `/api/config`, `/api/branding`, brand assets
  and the dedicated callback URL. Health checks do not exercise Portal or Graph.
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
clients cannot spoof forwarded IPs. All mutation requests require JSON and an
Origin header exactly matching `PUBLIC_BASE_URL`; there is no cross-origin API.
No tracking code is put into a query string, cookie or local storage.

## Validation

`npm test` covers permission boundaries, central disablement/role revocation/outage,
public validation, session cookies, consent endpoints, one-time confirmation checks,
outbox eligibility/retries, concurrency and explicit public response projections,
plus shared navigation/brand colour tests. SQL unit tests mock the driver; API tests
use real local HTTP with mocked central/data services. They do **not** replace live
Azure SQL, Entra and Graph smoke tests. Browser checks with mocked APIs can validate
UI flows but are not proof of external service integration.