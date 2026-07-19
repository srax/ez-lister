# CarXprt Organizations Implementation Plan

Status: approved product direction, implementation in progress  
Primary system: Chrome MV3 extension + Node/Express Tools backend + PostgreSQL  
Auth: Better Auth with Google OAuth and bearer sessions  
Billing: Better Auth Stripe plugin backed by Stripe Checkout and Customer Portal

## 1. Objective

Expand the existing individual salesperson product into a multi-tenant dealership product
without slowing the List-to-Facebook workflow or exposing one tenant's data to another.
Existing paid users and installed extension versions must continue working throughout the
migration.

The Tools backend remains authoritative for extension identity, organizations, rooftop
access, subscriptions, seats, listings, and statistics. The existing CarXprt dealership
portal may consume a versioned read API later; it does not share this database or auth
system in V1.

## 2. Non-Negotiable Product Rules

- No free product access. A valid individual subscription or organization seat is required
  for List/Fill and statistics.
- A valid signed lease keeps the normal List click free of backend latency.
- Lease refresh runs every 30 minutes; the maximum offline revocation window is 90 minutes.
- The individual plan is $89.99/month and covers one active rooftop.
- The dealership package is $499/month per rooftop and includes 10 rooftop-specific listing
  seats. Prices and limits come from backend plan configuration and Stripe, not extension UI.
- One organization has one Stripe customer, one consolidated subscription, and one primary
  Organization Owner.
- One rooftop may belong to only one active organization at a time.
- Roles and listing seats are independent. Owners and managers consume no seat unless they
  List/Fill.
- Facebook credentials, cookies, and private identity are never sent to the backend.
- Never auto-click Facebook Publish. Statistics must not claim that a salesperson caused a
  dealership sale.

## 3. Domain Model

### Identity and workspaces

- `user`: Better Auth user. A person may use multiple devices and belong to multiple
  organizations.
- `workspace`: the isolation and attribution boundary for drafts, events, listings, and
  statistics. It is either `personal` or `organization`.
- Every existing user receives one personal workspace. Every Better Auth organization has
  one organization workspace.
- Only one workspace is active per Chrome profile at a time. Selection is stored locally,
  not globally on the user's account.

### Organizations and rooftops

- `organization`: Better Auth organization and the billing/administration boundary. It may
  contain one or many rooftops.
- `dealership`: the existing stable rooftop record. A rooftop is not identified by its URL.
- `organization_rooftop`: attaches a verified rooftop to one organization and records its
  package state and seat capacity.
- Domains, aliases, inventory URL patterns, and adapter configuration remain attached to
  the rooftop. Platform or domain changes do not create a new rooftop.

### Membership and seats

- Better Auth owns coarse organization membership and invitations.
- CarXprt owns rooftop-scoped operational access. An owner has all-rooftop access. Managers
  and salespeople receive explicit rooftop assignments; managers may also be marked as
  covering all current and future rooftops.
- A listing seat is uniquely assigned by `(organization_id, dealership_id, member_id)`.
- Assignment at two rooftops consumes two seats, even inside one organization.
- Pending invitations reserve seats. Expired, rejected, or canceled invitations release
  reservations.
- Seat assignment is tied to the Better Auth user, not a browser, device, or Facebook
  account.

### Billing

- Personal subscription `referenceId` remains the Better Auth user ID.
- Organization subscription `referenceId` is the Better Auth organization ID and uses
  `customerType=organization`.
- The rooftop package quantity equals the number of active paid rooftops. Each package adds
  10 included seats to that rooftop.
- Future extra-seat pricing is a separate Stripe subscription item. Custom capacity records
  allocate those purchased seats to rooftops.
- Stripe is billing truth. Better Auth's Stripe plugin owns Checkout, subscription lifecycle,
  webhook persistence, and Portal authorization. Custom `/api/billing/*` routes are thin
  extension adapters plus delayed-webhook reconciliation.
- Existing Stripe subscriptions are reconciled in place. They are never canceled or
  recreated during migration.

## 4. User Journeys

### Individual on an unclaimed supported rooftop

1. Sign in with Google.
2. Choose `Use CarXprt myself`.
3. Detect or enter one supported dealership.
4. Confirm authorization to market that inventory.
5. Complete individual Checkout immediately.
6. Stripe webhook activates the personal workspace and rooftop-bound lease.

This does not claim the rooftop or create an organization. Once a rooftop is claimed, new
individual subscriptions for it are blocked and users are routed to `Request access`.
Existing individual subscriptions are grandfathered.

### Individual rooftop change

- Allow one self-service replacement per billing cycle.
- The destination must be supported and unclaimed.
- Switching revokes the old lease and unfinished old-rooftop drafts.
- Historical personal data remains attached to the old rooftop.
- Additional changes in the same cycle require support approval.

### Set up a dealership organization

1. Sign in and choose `Set up a dealership`.
2. Detect the first rooftop and optionally add more URLs.
3. Submit a short claim with an authorization attestation. Do not ask whether the user is
   the legal owner.
4. No payment is taken while the claim is pending.
5. CarXprt targets verification within a few hours. Pre-approved prospects and strong public
   matches can be approved immediately.
6. Each approved rooftop is reserved for that claimant for 72 hours.
7. Checkout includes only approved rooftops. Pending rooftops do not block activation.
8. The verified Stripe webhook activates the organization, owner, rooftop packages, and
   capacity.

Verification is risk-based. A Google-verified email proves control of an address, not
dealership authority. Work-domain email, a public staff-page match, an existing sales
relationship, or equivalent evidence speeds approval. Personal Gmail is allowed. Callback
or document upload is exceptional, not the default.

### Join an existing organization

- A one-time invitation is bound to normalized email, organization, role, rooftop scope,
  and optional seat reservation. It is hashed, single-use, and expires after seven days.
- Without an invitation, a user requests access to the claimed rooftop.
- Rooftop managers may approve salesperson access within their scope. Only the owner may
  approve manager access.
- If no seat is available, the request becomes `approved_awaiting_capacity`; it activates
  automatically after an owner purchases capacity and the webhook confirms it.
- Existing personal history remains private. Joining does not automatically cancel a
  personal subscription; offer cancellation at period end after the organization seat is
  active.

### Multi-rooftop owner or manager

- A verified group operator may own one organization containing multiple rooftops and one
  consolidated invoice.
- A single-rooftop GM may own a one-rooftop organization.
- Additional rooftops require authority verification, then an immediate prorated package
  increase.
- Owners see all current and future rooftops. Managers see only selected rooftops unless
  explicitly assigned `all rooftops`.
- Separate invoices require separate organizations. Cross-organization portfolio reporting
  is deferred.

### Owner who also lists

After organization activation ask one question: `Will you also list vehicles yourself?`
If yes, assign one seat at every selected rooftop. If no, show the full owner dashboard
without consuming capacity.

## 5. Roles and Authorization

### Organization Owner

- Exactly one primary owner.
- Billing, rooftop packages, seats, managers, ownership transfer, all statistics, and full
  audit log.
- Cannot leave or delete their account before ownership transfer.
- Ownership transfer requires recent Google reauthentication, target acceptance, and an
  immutable audit event. Support recovery repeats dealership-authority verification.

### Manager

- Explicitly scoped to one, several, or all rooftops.
- May invite/remove salespeople and allocate seats only within that scope.
- Cannot create managers, expand scope, change billing, add rooftops, or transfer ownership.
- Sees member performance and public listing URLs only inside assigned rooftops.

### Salesperson

- List/Fill requires an active rooftop seat.
- Sees personal organization activity and own statistics.
- Does not see billing, unrelated members, or other rooftops.

All backend endpoints derive the user from the bearer session and validate workspace,
membership, rooftop access, and capability server-side. Never trust `ownerId`, role, or
organization claims sent by the extension.

## 6. State Machines

### Claim

`pending -> evidence_requested -> approved -> checkout_pending -> active`

Terminal/exception states: `rejected`, `expired`, `conflict`, `disputed`, `suspended`,
`transferred`. Multiple pending claims may exist for one rooftop; only approval creates the
72-hour exclusive reservation.

### Organization billing

- `active`/`trialing`: access allowed.
- `past_due`: three-day grace.
- After grace: List/Fill and dashboards locked; billing recovery remains.
- Cancellation/unpaid expiration: preserve claim and data for 90 days.
- After 90 days: archive the organization and mark rooftops `reclaimable`. A new claimant
  still requires verification; history is never transferred automatically.

### Member

`invited -> active -> suspended/removed`

Removal releases seats and prevents future access. Organization-created history remains
with immutable actor attribution. After the audit-retention period the UI may show
`Deleted member` instead of personal identifiers.

### Listing and draft attribution

At List click, stamp immutable `workspace_id`, `organization_id`, `dealership_id`, and
`actor_user_id`. A later workspace switch cannot move the draft. When a personal and
organization workspace both match, default to the organization seat but allow an explicit
Personal switch before List.

## 7. Proposed Additive Database Changes

Reserve migration number `009` for the separately planned Marketplace observation work.
Organization work starts at `010`.

### Migration 010: Better Auth organization schema

Generate with the installed Better Auth CLI after enabling the organization plugin. Better
Auth owns `organization`, `member`, `invitation`, and related plugin fields. Do not hand-edit
generated definitions.

### Migration 011: workspaces and rooftop tenancy

- `workspaces(id, type, user_id, organization_id, status, created_at, updated_at)`
- `organization_rooftops(organization_id, dealership_id, status, included_seats,
  extra_seats, reservation_expires_at, activated_at, archived_at)`
- Unique active ownership for each `dealership_id`.
- Backfill one personal workspace per existing Better Auth user.

### Migration 012: member scope and capacity

- `member_rooftop_access(member_id, organization_id, dealership_id, role, all_rooftops,
  created_at, revoked_at)` or an equivalent normalized organization-wide scope record.
- `seat_assignments(organization_id, dealership_id, member_id, assigned_at, released_at)`
- `seat_reservations(organization_id, dealership_id, invitation_id/access_request_id,
  expires_at)`
- Transactional capacity checks count active assignments plus live reservations.

### Migration 013: claims, requests, and audit

- `dealership_claims`
- `organization_access_requests`
- `claim_evidence` with minimal retained evidence metadata
- `organization_audit_events` as append-only records
- Required indexes for pending review, user inbox, organization inbox, and expiration jobs

### Migration 014: workspace attribution

Add nullable `workspace_id`, `organization_id`, and `actor_user_id` to listings and usage
events. Backfill existing rows to each owner's personal workspace. Add workspace-scoped
indexes and idempotency constraints before retiring the legacy `(owner_id, client_key)`
constraint in a later compatibility migration.

### Migration 015: billing allocation and lifecycle

- Store Stripe subscription-item mapping for rooftop packages and future extra-seat items.
- Store requested/effective capacity and pending reduction dates.
- Extend comp grants to a workspace scope while preserving legacy user grants.
- Record subscription reconciliation outcomes without storing card data.

Every migration is forward-only, repeat-safe where practical, and validated with pre/post
row counts. No destructive column removal occurs during the rollout.

## 8. Better Auth and Stripe Configuration

- Add Better Auth's `organization()` plugin with organization creation disabled for ordinary
  client calls. CarXprt creates organizations only after claim approval.
- Configure seven-day invitations, verified-email invitation acceptance, and the existing
  email adapter.
- Use Better Auth for coarse owner/member identity. Enforce manager/salesperson rooftop
  permissions in CarXprt services so plugin endpoints cannot widen scope.
- Configure Stripe plan names separately for `individual` and `dealership_rooftop`.
- Set `authorizeReference` so only the organization owner may change organization billing.
- Do not use automatic Better Auth member-count seat billing: listing seats are optional and
  rooftop-specific, while owners/managers may be stats-only members.
- Additions use immediate Stripe proration. Reductions apply at renewal and cannot reduce
  below active assignments.
- Use Stripe promotion codes for customer pilots. Keep audited, expiring comp grants for
  internal recovery/testing only.

## 9. Entitlement Lease V2

Issue a signed ES256 lease for one selected workspace. Retain V1 claims during compatibility.
V2 claims include:

```json
{
  "sub": "user-id",
  "wsp": "workspace-id",
  "wty": "personal|organization",
  "org": "organization-id-or-null",
  "dlr": "selected-rooftop-id",
  "dom": ["approved.example"],
  "cap": ["list", "fill", "stats:own"],
  "role": "owner|manager|salesperson|personal",
  "seat": true,
  "ent": true,
  "iat": 0,
  "exp": 0
}
```

The extension verifies signature, expiry, capability, and exact host/path before extraction.
The backend repeats authorization during sync. A valid lease preserves current click speed;
server revocation takes effect on the normal 30-minute refresh, with a 90-minute offline
worst case.

## 10. API Contract V2

Keep old response fields until the minimum extension version has advanced.

- `GET /api/me?workspaceId=`: profile, workspaces, selected workspace, memberships,
  onboarding state, subscription summary, and one scoped lease.
- `POST /api/workspaces/select`: optional server validation; selection remains device-local.
- `POST /api/claims`, `GET /api/claims/:id`, `GET /api/claims/mine`.
- `POST /api/access-requests`, `GET /api/organizations/:id/access-requests`.
- `POST /api/organizations/:id/invitations` and invitation accept/reject adapters.
- `GET/PATCH /api/organizations/:id/members` with scoped role enforcement.
- `POST/DELETE /api/organizations/:id/rooftops/:dealerId/seats/:memberId`.
- `GET /api/organizations/:id/dashboard` with date/rooftop/member filters.
- `POST /api/billing/checkout` accepts a validated billing target (`personal` or approved
  organization claim). Client-provided price IDs and quantities are forbidden.
- `POST /api/billing/capacity` performs owner-only rooftop/seat changes.
- `POST /api/listings/sync` accepts `workspaceId`; the server derives actor and verifies
  rooftop access before upsert.
- Admin claim, dispute, transfer, comp, and reconciliation endpoints remain strongly
  authenticated, reasoned, and audited.

Use idempotency keys on claim approval, invitation acceptance, billing capacity changes,
listing events, and ownership transfer.

## 11. Extension UX

### Onboarding

Present intent, not unverifiable titles:

- `Use CarXprt myself`
- `Set up a dealership`
- `Join an existing team`

Individual users on supported, unclaimed rooftops go directly to individual Checkout.
Unsupported rooftops create a support request and are not charged. Claimed rooftops route to
access requests.

### Workspace safety

- Show the selected organization and rooftop near List.
- Default to a matching organization seat over a grandfathered personal workspace.
- Ask only when multiple valid workspaces match.
- Scope local storage keys, drafts, queues, and restored listings by workspace.
- Never fill a draft whose stamped workspace/rooftop does not match its lease.

### Team UI

- Side panel: compact organization summary, seat warning, pending inbox count, and navigation.
- Expandable/full extension page: organization dashboard, rooftop/date/member filters, team,
  seats, invitations, access requests, and owner billing entry point.
- Owner sees all rooftops; manager queries are restricted to assigned rooftops; salesperson
  sees own activity.

### Dashboard metrics

- Listing actions and unique vehicles
- Currently listed inventory
- Vehicles sold at dealership
- Average days from first listing to dealership sale
- Observed Marketplace views, views per listing, coverage, and last observed timestamp
- Active versus purchased seats
- Per-member activity, unique VINs, sold-at-dealership count, view coverage, and last activity

Use sortable tables, not a gamified leaderboard. Missing view observations show `Not
available`, never zero.

## 12. Notifications and Background Jobs

- Durable in-extension Team inbox plus transactional email for invitations, approvals,
  rejections, access requests, expiring invites, and capacity waits.
- Email failure does not mutate workflow state.
- Listing/publish events sync immediately through an idempotent offline queue.
- Open dashboards refresh at most every 60 seconds.
- Dealer inventory scans continue hourly, 24/7.
- Two consecutive successful inventory misses mark `Sold at dealership`.
- Notify relevant listers and rooftop managers; owners receive a daily summary by default.
- Reappearance restores active status and emits a correction.
- Scheduled jobs expire claim reservations, invitation reservations, past-due grace, and
  archived organization holds.

## 13. Detailed Milestones

### M0: Baseline and contract lock

- Commit this document separately from implementation.
- Record baseline test count, staging API version, extension version, and production row
  counts.
- Reconcile active branches/PRs before schema work.
- Acceptance: clean baseline tests; no unknown production diff; database backup available.

### M1: Additive workspace foundation

- Add migrations 010-011 and workspace service.
- Backfill personal workspaces idempotently.
- Expose workspaces in `/api/me` while preserving all V1 fields.
- Acceptance: every user has exactly one personal workspace; existing extension E2E is
  unchanged; rerunning migration produces no duplicates.

### M2: Better Auth organization foundation

- Enable organization plugin and generated schema.
- Block direct unverified organization creation.
- Add coarse owner/member authorization and organization service wrappers.
- Acceptance: owner/member isolation tests, one-primary-owner invariant, and no direct client
  bypass of claim approval.

### M3: Rooftop scope, seats, and invitations

- Add migrations 012-013.
- Implement rooftop access, transactional seats/reservations, seven-day invitations, and
  access requests.
- Acceptance: concurrency test cannot exceed capacity; manager cannot widen scope; expired
  invite releases capacity; email mismatch is rejected.

### M4: Claims and verification operations

- Implement individual versus organization routing, pending claims, 72-hour reservations,
  multi-claim conflict handling, pre-approved invitations, disputes, and CLI/admin actions.
- Acceptance: no charge before approval; first pending claim does not lock rooftop; only one
  active organization can own a rooftop; every admin mutation is audited.

### M5: Organization billing

- Add dealership and individual plan catalog entries.
- Move Checkout/Portal lifecycle behind Better Auth Stripe adapters.
- Implement organization `referenceId` authorization, rooftop package quantity, proration,
  past-due grace, reduction scheduling, and reconciliation.
- Migrate existing Stripe rows in place.
- Acceptance: Stripe test-mode E2E covers individual, one rooftop, three rooftops, 100% promo,
  failed renewal, recovery, capacity increase, cancellation, and delayed webhook sync.

### M6: Entitlement and tenant-scoped sync

- Add lease V2 and backward-compatible `/api/me`.
- Add workspace attribution migration 014 and backfill listings/events.
- Validate workspace and rooftop on listing sync, AI use, stats, and sold scanning.
- Acceptance: cross-tenant attempts fail; wrong rooftop fails; valid cached lease keeps List
  instant; V1 clients remain functional.

### M7: Extension onboarding and workspace UX

- Implement the three onboarding intents and all claim/access/capacity states.
- Scope local storage and queues by workspace.
- Add visible workspace/rooftop context and immutable draft stamping.
- Acceptance: personal, owner, manager, salesperson, grandfathered-personal, multi-org, and
  multi-device test matrices pass without stale data crossing workspaces.

### M8: Team management and dashboard

- Build compact side-panel summary and expandable full extension dashboard.
- Add team inbox, member/seat controls, filters, coverage-aware metrics, and audit views.
- Acceptance: API and UI authorization match; totals reconcile with raw listings; no private
  personal history appears in organization views.

### M9: Operations and lifecycle hardening

- Add claim-review CLI, dispute/freeze/transfer, organization archival, account deletion,
  notification retries, and observability.
- Add dashboards/alerts for webhook lag, reconciliation mismatch, claim backlog, seat
  conflicts, lease failures, sync rejects, and sold-scan failures.
- Acceptance: runbooks exercise owner recovery, disputed claim, expired reservation, failed
  email, and Stripe outage.

### M10: Staging E2E

- Build a staging extension against Railway staging and Stripe test mode.
- Test with fresh Google identities and at least two Chrome profiles.
- Test one personal user, a one-rooftop organization, a three-rooftop organization, owner
  without seat, owner with seat, scoped manager, salesperson, full capacity, removal,
  re-invite, subscription failure, and cancellation/reactivation.
- Run syntax, unit, integration, migration, security, and extension smoke tests.
- Acceptance: all gates green; database reconciliation exact; no production secrets in build.

### M11: Production pilot and rollout

- Deploy backend additive changes with dealership features disabled.
- Verify old Web Store extension compatibility.
- Enable internal accounts, then selected dealership pilots.
- Monitor for at least one complete billing webhook and sold-scan cycle.
- Publish the extension only after backend compatibility is confirmed.
- Expand rollout gradually; retain feature flags and forward-fix procedures.

## 14. Required Test Matrix

- Auth: signed out, expired bearer, email mismatch, multiple sessions, account deletion.
- Claims: supported/unclaimed, supported/claimed, unsupported, concurrent claims, reservation
  expiry, dispute, wrong rooftop, multi-rooftop partial approval.
- Billing: live subscription, trial, 100% discount, past due grace, cancellation, recovery,
  webhook replay/out-of-order delivery, reconciliation, existing customer migration.
- Seats: exact limit, concurrent approval, reservation expiry, immediate reassignment,
  multi-rooftop consumption, member removal, manager privilege escalation attempts.
- Tenancy: personal versus organization, two organizations, two rooftops on a shared domain,
  same user in multiple organizations, same VIN across workspaces, stale draft after switch.
- Statistics: duplicate VIN actions, sold-at-dealership semantics, reappearance correction,
  view coverage, former/deleted members, date and rooftop filters.
- Extension: restart, offline lease, lease expiry, two Chrome profiles, same Facebook account,
  changed Facebook account, delayed sync, old extension against new backend.
- Security: forged workspace/role/owner IDs, cross-tenant reads, replayed invitations,
  arbitrary Stripe price/quantity, claim spam, SSRF, CORS, and audit immutability.

## 15. Deployment Gates

Production rollout is prohibited until all are true:

- Staging migrations complete twice without error and row-count reconciliation passes.
- All automated tests and syntax checks pass.
- Stripe test Checkout and signed webhook flows pass for both plan types.
- Old production extension remains functional against the candidate backend.
- New staging extension passes the complete E2E matrix.
- CORS, OAuth redirect, extension ID, JWKS, plan IDs, and webhook destinations are verified.
- A database backup and forward-fix runbook exist.
- Claim review and ownership recovery can be performed without direct SQL.
- Feature flags can disable organization onboarding without disabling existing individuals.

## 16. Deferred Scope

- Cross-organization corporate portfolio dashboards
- Automated employment verification beyond risk signals
- CRM/DMS sale attribution
- Shared or cloud-hosted Facebook sessions
- Facebook inbox/message aggregation
- Automatic Facebook publishing or sending
- Full dealership portal write integration
- Dynamic pooled group-seat contracts
- Self-service account merging across different Google emails

These may be additive later; no V1 schema should assume they already exist.
