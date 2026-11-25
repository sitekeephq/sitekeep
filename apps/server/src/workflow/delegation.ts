/**
 * Approval delegation hook (issue #190, SDK 0.20.0; docs/features/DELEGATION.md).
 *
 * The core has no delegation rules. A module (Platform) registers an assignee resolver that names,
 * for the people a step or a work is assigned to, who acts for them at a moment. The core asks the
 * resolvers when a step becomes current (or a work is assigned) and keeps the answer:
 *   - workflow_instances.step_delegates: the delegates of the current (and earlier) steps;
 *   - works.assignee_delegates: the delegates of the assignee of a work without a workflow.
 * The delegate may act on that step or work until it is done, even after the delegation ended; new
 * assignments after the end go to the person alone. Actions taken this way are recorded as
 * "X adına Y" (on_behalf_of_user_id). Delegation never widens folder permissions.
 *
 * Without a resolver (Community, or the module off) the lists stay empty and nothing changes.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DelegateGrant, StepDelegate, WorkflowStep } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { users, workflowActions, workflowInstances, works } from "../db/schema.js";
import { loadingModule } from "../app/module-owner.js";
import { moduleIds } from "../app/module-ids.js";
import { msg, type Msg } from "../i18n/index.js";
import { actingAs, isAssignee, type ActorContext, type Acting } from "./engine.js";
import { actorFor, notify, projectMemberRows, resolveAssigneeUsers, type Member, type NewNotification } from "./service.js";

// ---- Registry (SDK) -----------------------------------------------------------------------------

export interface DelegatesQuery {
  db: Db;
  projectId: string;
  /** People the step or work is assigned to (resolved from users, companies and teams). */
  userIds: readonly string[];
  /** When the step became current / the work was assigned. */
  at: Date;
}

export interface AssigneeResolver {
  /** Unique id, e.g. "delegation". */
  id: string;
  /** Delegates of the given people in the project at the moment. A throw is logged and ignored. */
  delegates(query: DelegatesQuery): Promise<DelegateGrant[]> | DelegateGrant[];
}

interface Registered {
  resolver: AssigneeResolver;
  /** Module that registered it while loading (off when that module is off), or null for the core. */
  owner: string | null;
}

const resolvers = new Map<string, Registered>();

/** Adds an assignee resolver (SDK); returns the function that removes it. Ids are unique. */
export function registerAssigneeResolver(resolver: AssigneeResolver): () => void {
  if (resolvers.has(resolver.id)) throw new Error(`Assignee resolver "${resolver.id}" is already registered`);
  const entry = { resolver, owner: loadingModule() };
  resolvers.set(resolver.id, entry);
  return () => {
    if (resolvers.get(resolver.id) === entry) resolvers.delete(resolver.id);
  };
}

function activeResolvers(): AssigneeResolver[] {
  const on = moduleIds();
  return [...resolvers.values()].filter((r) => !r.owner || on.includes(r.owner)).map((r) => r.resolver);
}

/**
 * Delegates of `userIds` in a project at `at`, from every active resolver. Kept: delegates who are
 * members of the project, are not one of the assigned people themselves and are not the person.
 */
export async function resolveDelegates(
  db: Db,
  projectId: string,
  userIds: readonly string[],
  at: Date,
  members?: readonly Member[],
): Promise<DelegateGrant[]> {
  const on = activeResolvers();
  const people = [...new Set(userIds)];
  if (!on.length || !people.length) return [];
  const list = members ?? (await projectMemberRows(db, projectId));
  const out: DelegateGrant[] = [];
  for (const r of on) {
    let grants: DelegateGrant[] = [];
    try {
      grants = await r.delegates({ db, projectId, userIds: people, at });
    } catch (err) {
      console.error(`assignee resolver "${r.id}" failed (project ${projectId})`, err);
      continue;
    }
    for (const g of grants) {
      if (!people.includes(g.forUserId) || people.includes(g.userId) || g.userId === g.forUserId) continue;
      if (!list.some((m) => m.userId === g.userId)) continue;
      if (out.some((x) => x.forUserId === g.forUserId && x.userId === g.userId)) continue;
      out.push({ forUserId: g.forUserId, userId: g.userId, delegationId: g.delegationId });
    }
  }
  return out;
}

// ---- Workflow steps -----------------------------------------------------------------------------

type InstanceLike = {
  id: string;
  projectId: string;
  stepIndex: number;
  startedBy: string | null;
  stepStartedAt?: Date | null;
  template: { steps: readonly WorkflowStep[] };
  stepDelegates?: StepDelegate[] | null;
};

/** Delegates of the instance's current step. */
export function currentStepDelegates(i: Pick<InstanceLike, "stepIndex" | "stepDelegates">): StepDelegate[] {
  return (i.stepDelegates ?? []).filter((d) => d.stepIndex === i.stepIndex);
}

/** The user is a delegate on the instance's current step. */
export function isStepDelegate(i: Pick<InstanceLike, "stepIndex" | "stepDelegates">, userId: string): boolean {
  return currentStepDelegates(i).some((d) => d.userId === userId);
}

/** The user was a delegate on any step of the instance (they see the record). */
export function wasStepDelegate(i: Pick<InstanceLike, "stepDelegates">, userId: string): boolean {
  return (i.stepDelegates ?? []).some((d) => d.userId === userId);
}

/**
 * Called when the instance's current step became current (start, next step, return, reassignment):
 * asks the resolvers for the delegates of the step's people and stores them on the instance (the
 * object passed in is updated too). Returns the delegates of the step. Runs inside the caller's
 * transaction when it gets one.
 */
export async function enterStepDelegates(db: Db, instance: InstanceLike, members?: readonly Member[]): Promise<StepDelegate[]> {
  const step = instance.template.steps[instance.stepIndex];
  const before = instance.stepDelegates ?? [];
  const kept = before.filter((d) => d.stepIndex !== instance.stepIndex);
  let grants: DelegateGrant[] = [];
  if (step && activeResolvers().length) {
    const list = members ?? (await projectMemberRows(db, instance.projectId));
    const people = resolveAssigneeUsers(step.assignees, list, instance.startedBy);
    grants = await resolveDelegates(db, instance.projectId, people, instance.stepStartedAt ?? new Date(), list);
  }
  const next = [...kept, ...grants.map((g) => ({ ...g, stepIndex: instance.stepIndex }))];
  if (next.length !== before.length || grants.length) {
    await db.update(workflowInstances).set({ stepDelegates: next }).where(eq(workflowInstances.id, instance.id));
  }
  instance.stepDelegates = next;
  return currentStepDelegates(instance);
}

/**
 * Takes a delegation back from what is still open: the running steps and the open works it reached
 * (the module calls it when a delegation is withdrawn rather than just ended). Returns how many
 * steps and works changed.
 */
export async function dropStepDelegation(db: Db, delegationId: string): Promise<number> {
  let n = 0;
  const rows = await db.select({ id: workflowInstances.id, d: workflowInstances.stepDelegates }).from(workflowInstances).where(eq(workflowInstances.status, "running"));
  for (const r of rows) {
    if (!r.d.some((x) => x.delegationId === delegationId)) continue;
    await db.update(workflowInstances).set({ stepDelegates: r.d.filter((x) => x.delegationId !== delegationId) }).where(eq(workflowInstances.id, r.id));
    n++;
  }
  const workRows = await db
    .select({ id: works.id, d: works.assigneeDelegates })
    .from(works)
    .where(and(isNull(works.closedAt), sql`${works.assigneeDelegates} @> ${JSON.stringify([{ delegationId }])}::jsonb`));
  for (const w of workRows) {
    await db.update(works).set({ assigneeDelegates: w.d.filter((x) => x.delegationId !== delegationId) }).where(eq(works.id, w.id));
    n++;
  }
  return n;
}

/** What `handOverOpenAssignments` gave to a delegate. */
export interface HandedOver {
  steps: number;
  works: number;
  /** Projects concerned (ids). */
  projectIds: string[];
}

/**
 * A delegation became active: the person's assignments that are already open in the projects get
 * the delegate as well, as new ones do (the mirror of `dropStepDelegation`). Running workflow steps
 * that are the person's (users, companies, teams resolved) and not answered by them yet, and open
 * works assigned to them. Idempotent; skips projects the delegate is not a member of and steps where
 * the delegate is one of the step's own people. Permissions are not widened.
 */
export async function handOverOpenAssignments(db: Db, grant: DelegateGrant, projectIds: readonly string[]): Promise<HandedOver> {
  const out: HandedOver = { steps: 0, works: 0, projectIds: [] };
  const scope = [...new Set(projectIds)];
  if (!scope.length || grant.userId === grant.forUserId) return out;
  const touched = new Set<string>();
  const memberCache = new Map<string, Member[]>();
  const membersOf = async (pid: string) => {
    if (!memberCache.has(pid)) memberCache.set(pid, await projectMemberRows(db, pid));
    return memberCache.get(pid)!;
  };
  const running = await db
    .select()
    .from(workflowInstances)
    .where(and(inArray(workflowInstances.projectId, scope), eq(workflowInstances.status, "running")));
  const answers = running.length
    ? await db
        .select({ instanceId: workflowActions.instanceId, stepIndex: workflowActions.stepIndex, userId: workflowActions.userId, onBehalfOfUserId: workflowActions.onBehalfOfUserId })
        .from(workflowActions)
        .where(and(inArray(workflowActions.instanceId, running.map((i) => i.id)), eq(workflowActions.kind, "submit")))
    : [];
  for (const i of running) {
    const step = i.template.steps[i.stepIndex];
    if (!step) continue;
    const members = await membersOf(i.projectId);
    if (!members.some((m) => m.userId === grant.userId)) continue;
    const people = resolveAssigneeUsers(step.assignees, members, i.startedBy);
    if (!people.includes(grant.forUserId) || people.includes(grant.userId)) continue;
    if (currentStepDelegates(i).some((d) => d.forUserId === grant.forUserId && d.userId === grant.userId)) continue;
    // Already answered for the person in this step (Field rounds: the instance re-enters; checked again at action time).
    if (i.subjectType !== "form" && answers.some((a) => a.instanceId === i.id && a.stepIndex === i.stepIndex && (a.onBehalfOfUserId ?? a.userId) === grant.forUserId)) continue;
    await db
      .update(workflowInstances)
      .set({ stepDelegates: [...(i.stepDelegates ?? []), { ...grant, stepIndex: i.stepIndex }] })
      .where(eq(workflowInstances.id, i.id));
    out.steps++;
    touched.add(i.projectId);
  }
  const open = await db
    .select({ id: works.id, projectId: works.projectId, d: works.assigneeDelegates })
    .from(works)
    .where(and(inArray(works.projectId, scope), eq(works.assigneeUserId, grant.forUserId), isNull(works.closedAt)));
  for (const w of open) {
    if (w.d.some((x) => x.forUserId === grant.forUserId && x.userId === grant.userId)) continue;
    if (!(await membersOf(w.projectId)).some((m) => m.userId === grant.userId)) continue;
    await db.update(works).set({ assigneeDelegates: [...w.d, { forUserId: grant.forUserId, userId: grant.userId, delegationId: grant.delegationId }] }).where(eq(works.id, w.id));
    out.works++;
    touched.add(w.projectId);
  }
  out.projectIds = [...touched];
  return out;
}

/**
 * How a user acts on the instance's current step: as themselves, or as the delegate of a person
 * the step is assigned to. `answered`: people (the one acted for) who already answered the step.
 * Null when the user may not act now; `involved` then tells "already answered" from "not assigned".
 */
export async function stepActing(
  db: Db,
  input: {
    instance: InstanceLike;
    user: { id: string; companyId: string | null; isAdmin: boolean };
    answered: ReadonlySet<string>;
    members?: readonly Member[];
  },
): Promise<{ acting: Acting | null; involved: boolean; self: ActorContext }> {
  const { instance, user } = input;
  const step = instance.template.steps[instance.stepIndex]!;
  const members = input.members ?? (await projectMemberRows(db, instance.projectId));
  const self = actorFor(user, members.find((m) => m.userId === user.id), instance.startedBy);
  const mine = currentStepDelegates(instance).filter((d) => d.userId === user.id);
  const principals = new Map<string, ActorContext>();
  if (mine.length) {
    const rows = await db
      .select({ id: users.id, companyId: users.companyId, isAdmin: users.isAdmin })
      .from(users)
      .where(and(inArray(users.id, mine.map((d) => d.forUserId)), eq(users.disabled, false)));
    for (const u of rows) principals.set(u.id, actorFor(u, members.find((m) => m.userId === u.id), instance.startedBy));
  }
  const acting = actingAs(step, self, mine, input.answered, (id) => principals.get(id) ?? null);
  return { acting, involved: isAssignee(step, self) || mine.length > 0, self };
}

/** Engine view of the people answers were given for (by user id), e.g. to rebuild submissions. */
export async function actorsOf(db: Db, projectId: string, userIds: readonly string[], startedBy: string | null, members?: readonly Member[]) {
  const ids = [...new Set(userIds)];
  const out = new Map<string, ActorContext>();
  if (!ids.length) return out;
  const list = members ?? (await projectMemberRows(db, projectId));
  const rows = await db.select({ id: users.id, companyId: users.companyId, isAdmin: users.isAdmin }).from(users).where(inArray(users.id, ids));
  for (const u of rows) out.set(u.id, actorFor(u, list.find((m) => m.userId === u.id), startedBy));
  return out;
}

/**
 * Running instances where the user, as a delegate, still has a step to answer: instance id → the
 * delegate entry (the person they act for). `keep` filters the answers that count (Field: the
 * current round only). Used by task lists ("vekâleten").
 */
export async function openDelegateSteps<I extends InstanceLike & { status?: string }>(
  db: Db,
  instances: readonly I[],
  userId: string,
  keep?: (action: { instanceId: string; stepIndex: number; details: Record<string, unknown> | null }, instance: I) => boolean,
): Promise<Map<string, StepDelegate>> {
  const out = new Map<string, StepDelegate>();
  const mine = instances.filter((i) => (i.status ?? "running") === "running" && isStepDelegate(i, userId));
  if (!mine.length) return out;
  const acts = await db
    .select({
      instanceId: workflowActions.instanceId,
      stepIndex: workflowActions.stepIndex,
      userId: workflowActions.userId,
      onBehalfOfUserId: workflowActions.onBehalfOfUserId,
      details: workflowActions.details,
    })
    .from(workflowActions)
    .where(and(inArray(workflowActions.instanceId, mine.map((i) => i.id)), eq(workflowActions.kind, "submit")));
  for (const i of mine) {
    const here = acts.filter((x) => x.instanceId === i.id && x.stepIndex === i.stepIndex && (!keep || keep(x, i)));
    if (here.some((x) => x.userId === userId)) continue;
    const answered = new Set(here.map((x) => x.onBehalfOfUserId ?? x.userId));
    const d = currentStepDelegates(i).find((x) => x.userId === userId && !answered.has(x.forUserId));
    if (d) out.set(i.id, d);
  }
  return out;
}

/** Names of users by id (task labels, "X adına Y"). */
export async function userNameMap(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---- Notifications ------------------------------------------------------------------------------

/**
 * The notification a step's (or work's) people get, sent to their delegates as well, with the
 * title marked "vekâleten" and the person's name. Same kind: e-mailed like the original (#189).
 */
export async function notifyDelegates(db: Db, delegates: readonly DelegateGrant[], n: NewNotification): Promise<void> {
  if (!delegates.length) return;
  const names = await userNameMap(db, delegates.map((d) => d.forUserId));
  for (const d of delegates) {
    if (d.userId === n.actorId) continue;
    await notify(db, [d.userId], { ...n, title: delegatedTitle(n.title, names.get(d.forUserId) ?? "?") });
  }
}

export function delegatedTitle(title: Msg | string, name: string): Msg {
  return msg("workflow:delegation.notificationTitle", { title, name });
}


/** Delegates of a work's assignee at the moment it is assigned (works.assignee_delegates). */
export async function workAssigneeDelegates(db: Db, projectId: string, assigneeUserId: string | null, at = new Date()): Promise<DelegateGrant[]> {
  if (!assigneeUserId) return [];
  return resolveDelegates(db, projectId, [assigneeUserId], at);
}
