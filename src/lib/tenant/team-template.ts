import type { PrismaClient, AccountFieldType } from "@prisma/client";
import { DEFAULT_STAGES } from "./stages";

// THE ORG TEMPLATE: the Stage pipeline and AccountFieldDef set a NEWLY CREATED team starts from.
//
// Template rows are the ones with `teamId = null` (see the comments on Stage.teamId and
// AccountFieldDef.teamId in schema.prisma). They are never attached to a Lead and never carry a
// field value — they exist only to be COPIED.
//
// THE TEMPLATE IS READ EXACTLY ONCE PER TEAM: at team-creation time, inside the same transaction
// that creates the team (see createTeamWithAdmin in teams.ts). A later edit to a template row
// therefore does NOT reach back into teams that already exist — by design, because a team's
// pipeline is live data the team admin owns: retro-applying an org-level edit would silently
// rename or reorder stages that leads are sitting in. For the same reason there is deliberately
// NO "reset this team to the template" operation: it would be a data-destroying button whose
// blast radius is every lead in the team.
//
// Both helpers take a narrow `TemplateDb` rather than PrismaClient so the SAME code runs against
// an interactive-transaction client without the `tx as PrismaClient` cast used elsewhere in the
// codebase.
type TemplateDb = Pick<PrismaClient, "stage" | "accountFieldDef">;

// The two account fields every team starts with (the pair prisma/seed.ts creates by hand today).
export const TEMPLATE_FIELD_DEFS: { label: string; type: AccountFieldType }[] = [
  { label: "Total area", type: "NUMBER" },
  { label: "Contract value", type: "CURRENCY" },
];

export type TemplateCounts = { stages: number; fieldDefs: number };

// Build the org template for a company if it has none. Idempotent, and safe to call inside a
// transaction.
//
// Stages and field definitions are considered SEPARATELY: a company that somehow has template
// stages but no template fields gets the fields added. Within stages the check is "any at all",
// because a stage set that has been hand-edited at org level must not have DEFAULT_STAGES
// re-injected into it; within field definitions the check is PER LABEL, which is also what
// enforces template-label uniqueness (see below).
export async function seedOrgTemplate(db: TemplateDb, companyId: string): Promise<TemplateCounts> {
  const existingStages = await db.stage.count({ where: { companyId, teamId: null } });
  let stages = 0;
  if (existingStages === 0) {
    const created = await db.stage.createMany({
      data: DEFAULT_STAGES.map((s, i) => ({
        companyId,
        teamId: null,
        name: s.name,
        type: s.type,
        probability: s.probability,
        order: i,
      })),
    });
    stages = created.count;
  }

  // `@@unique([teamId, label])` does NOT police template rows: Postgres treats NULLs as DISTINCT
  // in a unique index, so ("Total area", NULL) can be inserted twice. Uniqueness of a template
  // label is therefore an APP-LAYER rule, scoped by (companyId, label) — enforced here by only
  // inserting labels the company does not already hold as a template row.
  const existingDefs = await db.accountFieldDef.findMany({
    where: { companyId, teamId: null },
    select: { label: true, order: true },
  });
  const taken = new Set(existingDefs.map((d) => d.label));
  const missing = TEMPLATE_FIELD_DEFS.filter((d) => !taken.has(d.label));
  let fieldDefs = 0;
  if (missing.length > 0) {
    const nextOrder = existingDefs.reduce((max, d) => Math.max(max, d.order + 1), 0);
    const created = await db.accountFieldDef.createMany({
      data: missing.map((d, i) => ({
        companyId,
        teamId: null,
        label: d.label,
        type: d.type,
        order: nextOrder + i,
      })),
    });
    fieldDefs = created.count;
  }

  return { stages, fieldDefs };
}

// Copy the company's template stages and field definitions into a team, preserving order.
//
// Called inside createTeamWithAdmin's transaction, so a failure to clone rolls the whole team
// back rather than leaving a team with no pipeline (a team with zero stages cannot hold a lead).
//
// Idempotent per kind: a team that already has stages keeps them untouched, which is what stops
// a second call from violating the team's real `@@unique([teamId, label])` on field definitions.
export async function cloneTemplateToTeam(
  db: TemplateDb,
  companyId: string,
  teamId: string,
): Promise<TemplateCounts> {
  const [teamStages, teamDefs] = await Promise.all([
    db.stage.count({ where: { companyId, teamId } }),
    db.accountFieldDef.count({ where: { companyId, teamId } }),
  ]);

  let stages = 0;
  if (teamStages === 0) {
    const template = await db.stage.findMany({
      where: { companyId, teamId: null },
      orderBy: { order: "asc" },
      select: { name: true, type: true, probability: true },
    });
    if (template.length > 0) {
      // `order` is re-derived from the template's sort position rather than copied, so a template
      // with gaps or duplicates in `order` still yields a densely ordered team pipeline.
      const created = await db.stage.createMany({
        data: template.map((s, i) => ({
          companyId,
          teamId,
          name: s.name,
          type: s.type,
          probability: s.probability,
          order: i,
        })),
      });
      stages = created.count;
    }
  }

  let fieldDefs = 0;
  if (teamDefs === 0) {
    const template = await db.accountFieldDef.findMany({
      where: { companyId, teamId: null },
      orderBy: { order: "asc" },
      select: { label: true, type: true },
    });
    // Two template rows sharing a label are possible at the DB level (see seedOrgTemplate), and
    // copying both would break the team's own unique index — so dedupe on the way in.
    const seen = new Set<string>();
    const unique = template.filter((d) => (seen.has(d.label) ? false : (seen.add(d.label), true)));
    if (unique.length > 0) {
      const created = await db.accountFieldDef.createMany({
        data: unique.map((d, i) => ({ companyId, teamId, label: d.label, type: d.type, order: i })),
      });
      fieldDefs = created.count;
    }
  }

  return { stages, fieldDefs };
}
