# Qonshu CRM — Milestone 2: Sales CRM (Leads Pipeline)

**Date:** 2026-06-19
**Status:** Approved design
**Subsystem:** 2 of 5 (depends on Milestone 1 tenant foundation)

## Context

Milestone 1 delivered multi-tenant foundation: companies, users (SUPER_ADMIN /
COMPANY_ADMIN / MEMBER), auth, and a tenant-scoped data layer where every query
is filtered by `companyId` through `src/lib/tenant/*` (app code never touches a
tenant table directly). Milestone 2 builds the sales CRM on top: a leads/prospects
pipeline with customizable stages, an activity timeline, follow-up tasks, and file
attachments. It reuses M1's patterns exactly — scoped service → zod-validated route
handler → server page with guards, Vitest isolation tests, Prisma 7 + pg adapter.

Account management of already-partnered companies is a **separate** subsystem
(Milestone 3) and is out of scope here.

## Goals

- Company members manage leads through a customizable pipeline (board + list views).
- Each lead carries contact info, deal value, owner, stage, activity history,
  follow-up tasks, and file attachments.
- Company Admin customizes the pipeline stages and controls lead visibility.
- Strict per-company isolation preserved; configurable per-member visibility.

## Non-Goals (this milestone)

- Partner/account management workspace (Milestone 3).
- Dashboard/reporting aggregates (Milestone 5) — though the data model is shaped to
  support them (stage `type`, `probability`, `value`, timestamps).
- Email/calendar integrations, automation/workflows, custom user-defined fields,
  bulk import/export, lead deduplication, @mentions/notifications. (Candidates for
  later milestones; user will prioritize after testing M2.)

## Roles & Visibility

- **MEMBER** — create/edit leads; sees leads per the company visibility setting.
- **COMPANY_ADMIN** — everything a member can, plus manage pipeline stages, change
  the visibility setting, and always sees all company leads.
- **SUPER_ADMIN** — no access to tenant CRM data (platform role only), unchanged.

**Visibility setting** — `Company.shareAllLeads` (boolean, default `true`):
- `true` → every member sees all of the company's leads.
- `false` → a member sees only leads they own (`ownerId == self`); Company Admin
  still sees all. Enforced inside the scoped query layer, never in the UI alone.

## Data Model (Prisma; all tenant tables carry `companyId` + index)

```
Company  (existing)  + shareAllLeads Boolean @default(true)

Stage
  id, companyId, name, order Int, type StageType, probability Int @default(0),
  createdAt
  @@index([companyId])           // probability 0..100 (weighted pipeline)
  StageType = OPEN | WON | LOST

Lead
  id, companyId, title, contactName, email?, phone?, companyName?, source?,
  value Decimal @default(0), currency String @default("USD"),
  priority Priority @default(MEDIUM), stageId, ownerId,
  expectedCloseDate? DateTime, lostReason? String,
  createdAt, updatedAt
  @@index([companyId]) @@index([companyId, stageId]) @@index([companyId, ownerId])
  Priority = LOW | MEDIUM | HIGH

Activity                         // timeline; user notes + system audit entries
  id, companyId, leadId, authorId?, kind ActivityKind, body String,
  outcome? String, occurredAt DateTime @default(now()), createdAt
  @@index([companyId, leadId])
  ActivityKind = NOTE | CALL | MEETING | EMAIL | STAGE_CHANGE

Task                             // follow-ups
  id, companyId, leadId, title, dueDate? DateTime, done Boolean @default(false),
  assigneeId?, createdAt
  @@index([companyId, leadId]) @@index([companyId, assigneeId])

Attachment
  id, companyId, leadId, filename, diskPath, size Int, mime, uploadedById,
  createdAt
  @@index([companyId, leadId])
```

Relations are scoped through `companyId`; deleting a Lead cascades its Activities,
Tasks, and Attachments (and unlinks/removes attachment files on disk).

## Key Behaviors

- **Stage seeding:** when a company is created (M1 `createCompany`), seed its default
  pipeline: New(OPEN,10) → Contacted(OPEN,25) → Qualified(OPEN,50) →
  Proposal(OPEN,70) → Negotiation(OPEN,90) → Won(WON,100) → Lost(LOST,0). Existing
  demo company gets stages via an idempotent seed update.
- **Stage management (admin):** add, rename, reorder (`order`), set `type` +
  `probability`, delete. A stage with leads cannot be deleted until its leads are
  moved (return 409). At least one OPEN and the WON/LOST stages must remain.
- **Move lead stage:** changing `stageId` writes a `STAGE_CHANGE` Activity
  ("Moved from X to Y") automatically (audit trail). Moving into a LOST stage
  prompts for `lostReason`.
- **Weighted pipeline value:** `value * stage.probability/100` — exposed per lead and
  summable (used by board column totals now; dashboards in M5).
- **Activities:** members add NOTE/CALL/MEETING/EMAIL with optional `outcome`
  (meeting result) and `occurredAt`; STAGE_CHANGE entries are system-generated.
- **Tasks:** create with optional `dueDate` + `assignee`; toggle `done`; overdue =
  `!done && dueDate < now` (derived, shown in UI).
- **Attachments:** upload to `uploads/<companyId>/<leadId>/<uuid>-<filename>`
  (path on disk, gitignored); download via a guarded route that re-checks tenant +
  visibility before streaming. Max size enforced (e.g. 10 MB); content-type recorded.

## Architecture (reuses M1)

- `src/lib/tenant/stages.ts` — scoped stage CRUD + reorder + default-seed helper.
- `src/lib/tenant/leads.ts` — scoped lead CRUD, list (filter/sort/search/paginate),
  stage-move (emits STAGE_CHANGE), visibility-aware `where` builder.
- `src/lib/tenant/activities.ts` — scoped activity create/list.
- `src/lib/tenant/tasks.ts` — scoped task create/toggle/list.
- `src/lib/tenant/attachments.ts` — metadata CRUD; `src/lib/files/storage.ts` —
  disk read/write/delete behind an interface (swap to cloud later).
- `src/app/api/leads/**`, `/stages/**`, `/leads/[id]/activities|tasks|attachments`
  — zod-validated, session+role+visibility guarded route handlers.
- `src/app/(app)/crm/**` — board view, list view, lead detail; stage settings under
  admin. Wired into the existing sidebar "Sales CRM" entry.
- Board drag-and-drop via `dnd-kit`; the underlying stage-move goes through the API
  (DnD is sugar over a tested service call).

**Visibility is centralized:** a single `leadScopeWhere(user)` helper produces the
Prisma `where` (`{companyId}` for admins/shared, `{companyId, ownerId}` for
restricted members). Every lead read path uses it — no ad-hoc filtering.

## Error Handling

- Cross-tenant or out-of-scope lead access → 404 (don't leak existence).
- Member acting on a lead they can't see (restricted mode) → 404.
- Non-admin hitting stage-management or visibility-setting routes → 403.
- Deleting a stage that still has leads → 409 with a clear message.
- Upload over size limit or disallowed type → 400; missing file → 400.
- Validation errors → 400; unique conflicts → 409 (existing `http.ts` mapping).

## Testing

- **Isolation:** company A cannot read/update B's leads, stages, activities, tasks,
  attachments (expect 404/empty).
- **Visibility:** with `shareAllLeads=false`, a member sees only owned leads while the
  admin sees all; with `true`, all members see all. Test `leadScopeWhere` directly.
- **Stage move audit:** moving a lead writes a STAGE_CHANGE activity with from/to.
- **Stage rules:** can't delete a stage with leads (409); reorder persists.
- **Tasks:** toggle done; overdue derivation.
- **Attachments:** upload writes file + metadata under the company/lead path;
  download route denies cross-tenant access; lead delete removes files.
- **Weighted value:** computed correctly from stage probability.

## Success Criteria

- A member logs in, creates a lead, moves it across stages on the board (history is
  logged), adds activities/tasks, uploads/downloads a file.
- An admin customizes stages and flips the visibility setting; member view respects it.
- All isolation + visibility + behavior tests pass; `npm run build` clean.
- Sidebar "Sales CRM" opens the working pipeline.
