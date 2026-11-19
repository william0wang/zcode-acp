/**
 * Billing-authoritative Start Plan verdict — a process-wide cache written by
 * the quota reader (`queryStartPlan`, quota/startplan.ts) and read by the
 * sync entitlement ladder (account-provider.ts).
 *
 * Why a cache and not a direct call: every entitlement consumer
 * (`buildAccountProviderConfig`, `entitledCodingPlanModels`,
 * `startPlanRequestAuthFor`) is SYNC — the dropdown and the runtime-headers
 * answer are built without an await boundary. The billing query is async
 * network, so the flow is warm-then-read: `syncProviderRegistry`
 * (handlers/session.ts) awaits a bounded warm before the account push, and
 * every sync consumer reads whatever the last COMPLETED query proved.
 *
 * Verdict semantics (issue #406, mirroring upstream
 * codingPlanProviderAvailability.ts — billing/balance `data.plans` is the
 * Start Plan availability authority):
 * - `entitled` — billing answers an active start plan. This entitles WITHOUT
 *   the desktop connection-selection flag: 3.17+ serves Start Plan as an
 *   OVERLAY whose `providerFamilyConnectionSelections` entry stays
 *   `individual-coding-plan` forever (observed: ~294M Start Plan tokens with
 *   the flag never flipping; flipping it by hand breaks the desktop's own
 *   credential resolution). `modelIds` (the grant's capability list) also
 *   filters the advertised models so the dropdown lists no dead option.
 * - `none` — the query succeeded and billing holds NO active start plan.
 *   Authoritative negative: even a start-plan selection flag cannot entitle.
 * - `unknown` — never queried, or the query failed (offline, rate-limited,
 *   auth error). The legacy on-disk gate decides (connection selection kind
 *   `start-plan`), preserving pre-billing behavior. A FAILED query never
 *   overwrites an earlier verdict — entitlement must not flap on blips.
 */

export type StartPlanVerdict =
  { status: "unknown" } | { status: "entitled"; modelIds: string[] } | { status: "none" };

let verdict: StartPlanVerdict = { status: "unknown" };

/** The latest billing verdict; `unknown` until the first completed query. */
export function startPlanVerdict(): StartPlanVerdict {
  return verdict;
}

/** Written only by the quota reader after a completed billing query. */
export function setStartPlanVerdict(next: StartPlanVerdict): void {
  verdict = next;
}

/** Test-only: drop the verdict between fixtures. */
export function resetStartPlanVerdictForTests(): void {
  verdict = { status: "unknown" };
}
