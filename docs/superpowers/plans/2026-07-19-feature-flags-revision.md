# Feature Flags Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pr-agent's flat 88-env-var surface with 8 user-facing `FEATURE_*` settings, a 25-var ops tier, an 18-var infra tier, and ~37 hardcoded constants, per the approved spec at `docs/superpowers/specs/2026-07-19-feature-flags-revision-design.md`.

**Architecture:** All config still flows through `loadConfig()` (`src/config.ts`) into a frozen `Config`. A new `cfg.features` object carries the 8 feature modes. Auto-trigger `pull_request` actions become a hardcoded map. Demoted knobs become named constants in `src/settings/*Constants.ts`. `loadConfig()` fails fast when a removed env var is still set.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import suffixes), Vitest, Nub (`nub run test`, `nub run check:code`).

## Global Constraints

- Defaults must preserve today's out-of-the-box behavior exactly: auto review+describe on PR `opened`, auto verification on `synchronize`, ask/triage slash-only, effort label on, security label off, commit status off, title rewrite off.
- `FEATURE_REVIEW` has no `off` state — `/review` always works.
- `off` slash commands must reply with a visible "disabled" notice, never silently ignore.
- Every commit must pass `nub run check:code` and `nub run test` (use `nub run --node test` if Vitest flakes on augmentation).
- `test/settingsInventory.test.ts` enforces ENV ↔ `.env.example` parity — update `.env.example` in the same commit as any `ENV` map change.
- Final `ENV` map: 48 keys (15 infra + 8 feature + 25 ops); `EXTERNAL_ENV` keeps its 3 — 51 total env vars.
- Follow existing code style: `readonly` types, `as const` maps, no comment noise.
- Commit messages: repo style `feat:`/`fix:`/`docs:`/`test:` prefixes, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Feature modes module

**Files:**
- Create: `src/settings/featureModes.ts`
- Modify: `src/settings/index.ts` (add `export * from "./featureModes.js";` alongside existing re-exports)
- Test: `test/featureModes.test.ts`

**Interfaces:**
- Produces: `Features` type, per-capability mode unions, `DEFAULT_FEATURE_*` constants, `AUTO_TRIGGER_ACTIONS` map. Later tasks import all of these from `../../settings/index.js`.

- [ ] **Step 1: Write the failing test**

```ts
// test/featureModes.test.ts
import { describe, expect, it } from "vitest";
import {
  AUTO_TRIGGER_ACTIONS,
  DEFAULT_FEATURE_ASK,
  DEFAULT_FEATURE_COMMIT_STATUS,
  DEFAULT_FEATURE_DESCRIBE,
  DEFAULT_FEATURE_REVIEW,
  DEFAULT_FEATURE_REVIEW_LABELS,
  DEFAULT_FEATURE_TITLE_REWRITE,
  DEFAULT_FEATURE_TRIAGE,
  DEFAULT_FEATURE_VERIFICATION,
} from "../src/settings/index.js";

describe("feature modes", () => {
  it("defaults preserve current out-of-the-box behavior", () => {
    expect(DEFAULT_FEATURE_REVIEW).toBe("auto");
    expect(DEFAULT_FEATURE_DESCRIBE).toBe("auto");
    expect(DEFAULT_FEATURE_VERIFICATION).toBe("auto");
    expect(DEFAULT_FEATURE_ASK).toBe("manual");
    expect(DEFAULT_FEATURE_TRIAGE).toBe("manual");
    expect(DEFAULT_FEATURE_REVIEW_LABELS).toBe("effort");
    expect(DEFAULT_FEATURE_COMMIT_STATUS).toBe(false);
    expect(DEFAULT_FEATURE_TITLE_REWRITE).toBe(false);
  });

  it("auto triggers match current AUTO_ACTIONS defaults", () => {
    expect([...AUTO_TRIGGER_ACTIONS.review]).toEqual(["opened"]);
    expect([...AUTO_TRIGGER_ACTIONS.describe]).toEqual(["opened"]);
    expect([...AUTO_TRIGGER_ACTIONS.verification]).toEqual(["synchronize"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nub run test -- test/featureModes.test.ts`
Expected: FAIL — module `src/settings/featureModes.ts` does not exist / exports missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/settings/featureModes.ts
/** Feature tier: the only user-facing settings. Catalog: docs/features.md. */

export const REVIEW_FEATURE_MODES = ["manual", "auto"] as const;
export const DESCRIBE_FEATURE_MODES = ["off", "manual", "auto"] as const;
export const VERIFICATION_FEATURE_MODES = ["off", "auto"] as const;
export const COMMAND_FEATURE_MODES = ["off", "manual"] as const;
export const REVIEW_LABELS_MODES = ["off", "effort", "effort+security"] as const;

export type ReviewFeatureMode = (typeof REVIEW_FEATURE_MODES)[number];
export type DescribeFeatureMode = (typeof DESCRIBE_FEATURE_MODES)[number];
export type VerificationFeatureMode = (typeof VERIFICATION_FEATURE_MODES)[number];
export type CommandFeatureMode = (typeof COMMAND_FEATURE_MODES)[number];
export type ReviewLabelsMode = (typeof REVIEW_LABELS_MODES)[number];

export type Features = {
  readonly review: ReviewFeatureMode;
  readonly describe: DescribeFeatureMode;
  readonly verification: VerificationFeatureMode;
  readonly ask: CommandFeatureMode;
  readonly triage: CommandFeatureMode;
  readonly reviewLabels: ReviewLabelsMode;
  readonly commitStatus: boolean;
  readonly titleRewrite: boolean;
};

export const DEFAULT_FEATURE_REVIEW: ReviewFeatureMode = "auto";
export const DEFAULT_FEATURE_DESCRIBE: DescribeFeatureMode = "auto";
export const DEFAULT_FEATURE_VERIFICATION: VerificationFeatureMode = "auto";
export const DEFAULT_FEATURE_ASK: CommandFeatureMode = "manual";
export const DEFAULT_FEATURE_TRIAGE: CommandFeatureMode = "manual";
export const DEFAULT_FEATURE_REVIEW_LABELS: ReviewLabelsMode = "effort";
export const DEFAULT_FEATURE_COMMIT_STATUS = false;
export const DEFAULT_FEATURE_TITLE_REWRITE = false;

/** `pull_request` actions that fire each capability in `auto` mode. Not configurable on purpose. */
export const AUTO_TRIGGER_ACTIONS = {
  review: new Set(["opened"]),
  describe: new Set(["opened"]),
  verification: new Set(["synchronize"]),
} as const;
```

Add to `src/settings/index.ts` (match the file's existing `export *` ordering):

```ts
export * from "./featureModes.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nub run test -- test/featureModes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings/featureModes.ts src/settings/index.ts test/featureModes.test.ts
git commit -m "feat: add feature mode settings module"
```

---

### Task 2: Removed-env guard module

**Files:**
- Create: `src/settings/removedEnv.ts`
- Modify: `src/settings/index.ts` (add `export * from "./removedEnv.js";`)
- Test: `test/removedEnv.test.ts`

**Interfaces:**
- Produces: `REMOVED_ENV: Readonly<Record<string, string>>` (removed var name → operator guidance) and `assertNoRemovedEnv(env: Record<string, string | undefined>): void` which throws listing **every** offending var. Task 7 wires the call into `loadConfig()`; do NOT call it from `loadConfig()` in this task (old vars are still parsed until Tasks 4-6 remove them).

- [ ] **Step 1: Write the failing test**

```ts
// test/removedEnv.test.ts
import { describe, expect, it } from "vitest";
import { REMOVED_ENV, assertNoRemovedEnv } from "../src/settings/index.js";

describe("removed env guard", () => {
  it("passes when no removed vars are set", () => {
    expect(() => assertNoRemovedEnv({ PORT: "7224", FEATURE_ASK: "manual" })).not.toThrow();
  });

  it("throws naming every removed var and its replacement", () => {
    expect(() =>
      assertNoRemovedEnv({
        ENABLE_REVIEW_COMMIT_STATUS: "true",
        MAX_TOOL_ROUNDS: "24",
      }),
    ).toThrow(/ENABLE_REVIEW_COMMIT_STATUS.*FEATURE_COMMIT_STATUS[\s\S]*MAX_TOOL_ROUNDS.*hardcoded/);
  });

  it("covers all replaced flag and auto-action vars", () => {
    for (const key of [
      "ENABLE_REVIEW_LABELS_EFFORT",
      "ENABLE_REVIEW_LABELS_SECURITY",
      "ENABLE_REVIEW_COMMIT_STATUS",
      "DESCRIPTION_GENERATE_TITLE",
      "REVIEW_AUTO_ACTIONS",
      "DESCRIPTION_AUTO_ACTIONS",
      "VERIFICATION_AUTO_ACTIONS",
      "REVIEW_INJECT_ANCHOR_MENU",
      "REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT",
      "LOCAL_WORKSPACE_CLONE_TIMEOUT_MS",
    ]) {
      expect(REMOVED_ENV[key], `missing ${key}`).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nub run test -- test/removedEnv.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/settings/removedEnv.ts
/** Env vars removed by the feature-flags revision (docs/features.md). loadConfig() refuses to start while any is set. */

const HARDCODED = "was removed and is now hardcoded; delete it from the environment";

export const REMOVED_ENV: Readonly<Record<string, string>> = {
  ENABLE_REVIEW_LABELS_EFFORT: "was removed — use FEATURE_REVIEW_LABELS (off | effort | effort+security)",
  ENABLE_REVIEW_LABELS_SECURITY: "was removed — use FEATURE_REVIEW_LABELS (off | effort | effort+security)",
  ENABLE_REVIEW_COMMIT_STATUS: "was removed — use FEATURE_COMMIT_STATUS (true | false)",
  DESCRIPTION_GENERATE_TITLE: "was removed — use FEATURE_TITLE_REWRITE (true | false)",
  REVIEW_AUTO_ACTIONS: "was removed — use FEATURE_REVIEW (manual | auto); auto reviews on opened",
  DESCRIPTION_AUTO_ACTIONS: "was removed — use FEATURE_DESCRIBE (off | manual | auto); auto describes on opened",
  VERIFICATION_AUTO_ACTIONS: "was removed — use FEATURE_VERIFICATION (off | auto); auto verifies on synchronize",
  REVIEW_INJECT_ANCHOR_MENU: "was removed; the anchor menu is always on",
  REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT: "was removed; the diff-cache gate is always on",
  MAX_TOOL_ROUNDS: HARDCODED,
  MAX_TOOL_ROUNDS_DESCRIBE: HARDCODED,
  MAX_TOOL_ROUNDS_TRIAGE: HARDCODED,
  MAX_TOOL_ROUNDS_VERIFICATION: HARDCODED,
  MAX_ASK_TOOL_ROUNDS: HARDCODED,
  MAX_ASK_FINALIZE_ROUNDS: HARDCODED,
  MAX_REVIEW_PUBLISH_ATTEMPTS: HARDCODED,
  MAX_REVIEW_PUBLISH_CALLS: HARDCODED,
  MAX_TRIAGE_FIXES_PER_RUN: HARDCODED,
  REVIEW_MIN_CONFIDENCE: HARDCODED,
  MAX_PR_FILES_LISTED: HARDCODED,
  MAX_PR_FILES_PATCH_BYTES: HARDCODED,
  REVIEW_CI_SUMMARY_WAIT_MS: HARDCODED,
  REVIEW_CI_SUMMARY_WAIT_POLL_MS: HARDCODED,
  REVIEW_CI_SUMMARY_MAX_FAILURES: HARDCODED,
  REVIEW_ANCHOR_MENU_MAX_FILES: HARDCODED,
  REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE: HARDCODED,
  WEBHOOK_MAX_BODY_BYTES: HARDCODED,
  WEBHOOK_TIMEOUT_MS: HARDCODED,
  CONTEXT7_RESPONSE_BYTES: HARDCODED,
  LOG_MAX_WIDE_EVENTS: HARDCODED,
  LOCAL_WORKSPACE_CLONE_TIMEOUT_MS: HARDCODED,
  LOCAL_WORKSPACE_FETCH_TIMEOUT_MS: HARDCODED,
  LOCAL_WORKSPACE_SEARCH_MAX_FILES: HARDCODED,
  LOCAL_WORKSPACE_MAX_FILE_BYTES: HARDCODED,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES: HARDCODED,
  LOCAL_WORKSPACE_MAX_DIFF_BYTES: HARDCODED,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES: HARDCODED,
  LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES: HARDCODED,
  LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES: HARDCODED,
  LOCAL_WORKSPACE_MAX_FETCH_BYTES: HARDCODED,
  LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB: HARDCODED,
  LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS: HARDCODED,
};

export function assertNoRemovedEnv(env: Record<string, string | undefined>): void {
  const offenders = Object.keys(REMOVED_ENV).filter((key) => env[key] !== undefined);
  if (offenders.length === 0) return;
  const lines = offenders.map((key) => `  ${key} ${REMOVED_ENV[key]}`);
  throw new Error(
    `Refusing to start: removed environment variables are set (see docs/features.md):\n${lines.join("\n")}`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nub run test -- test/removedEnv.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings/removedEnv.ts src/settings/index.ts test/removedEnv.test.ts
git commit -m "feat: add removed-env fail-fast guard"
```

---

### Task 3: Parse `cfg.features` in loadConfig (additive)

Old vars keep working in this task; removal happens in Tasks 4-6.

**Files:**
- Modify: `src/settings/envKeys.ts` (add 8 `FEATURE_*` keys to `ENV`)
- Modify: `src/config.ts` (parse `features`, add to return object)
- Modify: `.env.example` (add a `# --- Features (docs/features.md) ---` block at the top of the settings, after the HTTP/role block, listing all 8 with defaults)
- Test: `test/featureConfig.test.ts`

**Interfaces:**
- Consumes: Task 1 types/defaults.
- Produces: `Config["features"]: Features`. Parsing uses the existing `readEnum` helper (`src/config.ts:120-126`) — it already throws on invalid values. Booleans parse via `readEnum(name, ["true","false"] as const, ...) === "true"` so typos fail instead of silently becoming false.

- [ ] **Step 1: Write the failing test**

Follow the env-stubbing pattern used in `test/config.test.ts` / `test/configValidation.test.ts` (read one first; reuse its helper for setting required env + generated PEM key).

```ts
// test/featureConfig.test.ts — adapt setup to the existing config test helper
import { describe, expect, it } from "vitest";
// ...same env fixture bootstrapping as test/configValidation.test.ts...

describe("feature config", () => {
  it("defaults features to current behavior", async () => {
    const cfg = await loadConfigWithBaseEnv({});
    expect(cfg.features).toEqual({
      review: "auto",
      describe: "auto",
      verification: "auto",
      ask: "manual",
      triage: "manual",
      reviewLabels: "effort",
      commitStatus: false,
      titleRewrite: false,
    });
  });

  it("parses explicit modes", async () => {
    const cfg = await loadConfigWithBaseEnv({
      FEATURE_DESCRIBE: "off",
      FEATURE_ASK: "off",
      FEATURE_REVIEW_LABELS: "effort+security",
      FEATURE_COMMIT_STATUS: "true",
    });
    expect(cfg.features.describe).toBe("off");
    expect(cfg.features.ask).toBe("off");
    expect(cfg.features.reviewLabels).toBe("effort+security");
    expect(cfg.features.commitStatus).toBe(true);
  });

  it("rejects invalid modes", async () => {
    await expect(loadConfigWithBaseEnv({ FEATURE_REVIEW: "off" })).rejects.toThrow(/FEATURE_REVIEW/);
    await expect(loadConfigWithBaseEnv({ FEATURE_TITLE_REWRITE: "yes" })).rejects.toThrow(/FEATURE_TITLE_REWRITE/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nub run test -- test/featureConfig.test.ts`
Expected: FAIL — `cfg.features` undefined / `FEATURE_*` not in ENV.

- [ ] **Step 3: Implement**

`src/settings/envKeys.ts` — add inside `ENV` after `DATABASE_URL`:

```ts
  FEATURE_REVIEW: "FEATURE_REVIEW",
  FEATURE_DESCRIBE: "FEATURE_DESCRIBE",
  FEATURE_VERIFICATION: "FEATURE_VERIFICATION",
  FEATURE_ASK: "FEATURE_ASK",
  FEATURE_TRIAGE: "FEATURE_TRIAGE",
  FEATURE_REVIEW_LABELS: "FEATURE_REVIEW_LABELS",
  FEATURE_COMMIT_STATUS: "FEATURE_COMMIT_STATUS",
  FEATURE_TITLE_REWRITE: "FEATURE_TITLE_REWRITE",
```

`src/config.ts` — import the Task 1 symbols from `./settings/index.js`, then before the return object:

```ts
  const features = {
    review: readEnum(ENV.FEATURE_REVIEW, REVIEW_FEATURE_MODES, DEFAULT_FEATURE_REVIEW),
    describe: readEnum(ENV.FEATURE_DESCRIBE, DESCRIBE_FEATURE_MODES, DEFAULT_FEATURE_DESCRIBE),
    verification: readEnum(
      ENV.FEATURE_VERIFICATION,
      VERIFICATION_FEATURE_MODES,
      DEFAULT_FEATURE_VERIFICATION,
    ),
    ask: readEnum(ENV.FEATURE_ASK, COMMAND_FEATURE_MODES, DEFAULT_FEATURE_ASK),
    triage: readEnum(ENV.FEATURE_TRIAGE, COMMAND_FEATURE_MODES, DEFAULT_FEATURE_TRIAGE),
    reviewLabels: readEnum(ENV.FEATURE_REVIEW_LABELS, REVIEW_LABELS_MODES, DEFAULT_FEATURE_REVIEW_LABELS),
    commitStatus:
      readEnum(ENV.FEATURE_COMMIT_STATUS, ["true", "false"] as const, String(DEFAULT_FEATURE_COMMIT_STATUS) as "true" | "false") === "true",
    titleRewrite:
      readEnum(ENV.FEATURE_TITLE_REWRITE, ["true", "false"] as const, String(DEFAULT_FEATURE_TITLE_REWRITE) as "true" | "false") === "true",
  } satisfies Features;
```

Add `features,` to the return object (after `role,`).

`.env.example` — add after the ROLE block:

```
# --- Features (the user-facing catalog: docs/features.md) ---
# What the bot does and when it spends tokens. off = disabled entirely,
# manual = slash command only, auto = slash command + automatic trigger.
FEATURE_REVIEW=auto
FEATURE_DESCRIBE=auto
FEATURE_VERIFICATION=auto
FEATURE_ASK=manual
FEATURE_TRIAGE=manual
FEATURE_REVIEW_LABELS=effort
FEATURE_COMMIT_STATUS=false
FEATURE_TITLE_REWRITE=false
```

- [ ] **Step 4: Run tests**

Run: `nub run test -- test/featureConfig.test.ts test/settingsInventory.test.ts` then `nub run check:code`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/envKeys.ts src/config.ts .env.example test/featureConfig.test.ts
git commit -m "feat: parse FEATURE_* modes into cfg.features"
```

---

### Task 4: Demote tuning knobs to constants

Delete ~30 env vars (all "now hardcoded" entries in `REMOVED_ENV` from Task 2) and switch consumers to imported constants. One commit; the tree must typecheck at the end.

**Files:**
- Modify: `src/settings/envKeys.ts`, `src/settings/defaults.ts`, `src/config.ts`, `.env.example`
- Modify: `src/settings/reviewConstants.ts`, `src/settings/descriptionConstants.ts`, `src/settings/triageConstants.ts`, `src/settings/askConstants.ts`, `src/settings/workspaceConstants.ts`, `src/settings/context7Constants.ts`, `src/settings/loggingConstants.ts`, `src/settings/constants.ts`
- Create: `src/settings/verificationConstants.ts`
- Modify: every consumer of the demoted `cfg.*` fields (grep-driven; list below)
- Test: existing suites; `test/settingsInventory.test.ts` (drop the `DEFAULT_MAX_PR_FILES_LISTED`/`DEFAULT_MAX_PR_FILES_PATCH_BYTES`/`DEFAULT_WEBHOOK_MAX_BODY_BYTES` example-value assertions — those keys leave `.env.example`; keep `documented.length` check but lower the floor to `> 15`)

**Interfaces:**
- Produces: constants named by dropping the `DEFAULT_` prefix, exported via `src/settings/index.js`. Mapping (constant = current default value from `src/settings/defaults.ts`):

| Removed env var / Config field | New constant | Home |
|---|---|---|
| `MAX_TOOL_ROUNDS` / `maxToolRounds` | `MAX_TOOL_ROUNDS = 24` | reviewConstants.ts |
| `MAX_REVIEW_PUBLISH_ATTEMPTS` | `MAX_REVIEW_PUBLISH_ATTEMPTS = 3` | reviewConstants.ts |
| `MAX_REVIEW_PUBLISH_CALLS` | `MAX_REVIEW_PUBLISH_CALLS = 2` | reviewConstants.ts |
| `REVIEW_MIN_CONFIDENCE` | `REVIEW_MIN_CONFIDENCE = 1` | reviewConstants.ts |
| `MAX_PR_FILES_LISTED` | `MAX_PR_FILES_LISTED = 300` | reviewConstants.ts |
| `MAX_PR_FILES_PATCH_BYTES` | `MAX_PR_FILES_PATCH_BYTES = 500_000` | reviewConstants.ts |
| `REVIEW_CI_SUMMARY_WAIT_MS` | `REVIEW_CI_SUMMARY_WAIT_MS = 15_000` | reviewConstants.ts |
| `REVIEW_CI_SUMMARY_WAIT_POLL_MS` | `REVIEW_CI_SUMMARY_WAIT_POLL_MS = 2_000` | reviewConstants.ts |
| `REVIEW_CI_SUMMARY_MAX_FAILURES` | `REVIEW_CI_SUMMARY_MAX_FAILURES = 3` | reviewConstants.ts |
| `REVIEW_ANCHOR_MENU_MAX_FILES` | `REVIEW_ANCHOR_MENU_MAX_FILES = 40` | reviewConstants.ts |
| `REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE` | `REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE = 20` | reviewConstants.ts |
| `MAX_TOOL_ROUNDS_DESCRIBE` | `MAX_TOOL_ROUNDS_DESCRIBE = 16` | descriptionConstants.ts |
| `MAX_TOOL_ROUNDS_TRIAGE` | `MAX_TOOL_ROUNDS_TRIAGE = 32` | triageConstants.ts |
| `MAX_TRIAGE_FIXES_PER_RUN` | `MAX_TRIAGE_FIXES_PER_RUN = 10` | triageConstants.ts |
| `MAX_TOOL_ROUNDS_VERIFICATION` | `MAX_TOOL_ROUNDS_VERIFICATION = 32` | verificationConstants.ts (new) |
| `MAX_ASK_TOOL_ROUNDS` | `MAX_ASK_TOOL_ROUNDS = 12` | askConstants.ts |
| `MAX_ASK_FINALIZE_ROUNDS` | `MAX_ASK_FINALIZE_ROUNDS = 2` | askConstants.ts |
| 12× `LOCAL_WORKSPACE_*` | same names, values from defaults.ts:82-94 | workspaceConstants.ts |
| `CONTEXT7_RESPONSE_BYTES` | `CONTEXT7_RESPONSE_BYTES = 64_000` | context7Constants.ts |
| `LOG_MAX_WIDE_EVENTS` | `LOG_MAX_WIDE_EVENTS = 128` | loggingConstants.ts |
| `WEBHOOK_MAX_BODY_BYTES` | `WEBHOOK_MAX_BODY_BYTES = 25_000_000` | constants.ts |
| `WEBHOOK_TIMEOUT_MS` | `WEBHOOK_TIMEOUT_MS = 10_000` | constants.ts |

Notes: `MAX_PR_FILES_LISTED` keeps a comment that it must not exceed `GITHUB_PULL_REQUEST_FILES_API_MAX_FILES` (the runtime clamp in config.ts:456-464 is deleted). If a name collides with an existing export in its home file, keep the existing export and delete the duplicate default instead.

- [ ] **Step 1: Add the constants** to the settings files per the table (values copied verbatim from `src/settings/defaults.ts:11-94`). Create `src/settings/verificationConstants.ts` with the one export plus `/** Verification agent caps. */` header; add `export * from "./verificationConstants.js";` to `src/settings/index.ts`.

- [ ] **Step 2: Strip config.ts** — delete the corresponding `read*` blocks, return-object fields, and now-unused `DEFAULT_*` imports. Delete the same `DEFAULT_*` constants from `defaults.ts` and the keys from `ENV` in `envKeys.ts`, and the lines from `.env.example`.

- [ ] **Step 3: Rewire consumers.** For each removed field, find call sites and replace `cfg.<field>` with the imported constant, and shrink `Pick<Config, ...>` types accordingly:

```bash
for f in maxToolRounds maxReviewPublishAttempts maxReviewPublishCalls reviewMinConfidence \
  maxPrFilesListed maxPrFilesPatchBytes reviewCiSummaryWaitMs reviewCiSummaryWaitPollMs \
  reviewCiSummaryMaxFailures reviewAnchorMenuMaxFiles reviewAnchorMenuMaxRangesPerFile \
  maxToolRoundsDescribe maxToolRoundsTriage maxToolRoundsVerification maxTriageFixesPerRun \
  maxAskToolRounds maxAskFinalizeRounds webhookMaxBodyBytes webhookTimeoutMs \
  context7ResponseBytes logMaxWideEvents localWorkspace; do
  grep -rn "$f" src test --include="*.ts" | grep -v "src/settings/"; done
```

Where a test constructs a fake `cfg` with a removed field, delete the field (or move the expectation onto the constant).

- [ ] **Step 4: Verify**

Run: `nub run check:code && nub run test`
Expected: PASS. Also run `grep -rn "MAX_TOOL_ROUNDS\|LOCAL_WORKSPACE_\|WEBHOOK_TIMEOUT_MS" docker-compose.yml Dockerfile fly.toml 2>/dev/null` — remove any stale references in deploy files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: hardcode tuning knobs as settings constants"
```

---

### Task 5: Feature-mode intake (planner, scheduler, slash gating)

**Files:**
- Modify: `src/agentWork/intake/planner.ts` (full rewrite below)
- Modify: `src/agentWork/intake/applier.ts:225-250` (`cfg` param → `features`)
- Modify: `src/agentWork/scheduler.ts:40-44` (`Pick<Config, "features">`)
- Modify: `src/agentWork/intake/slashIntake.ts` (gate `off` commands)
- Modify: `src/settings/slashConstants.ts` (disabled-reply body)
- Modify: caller that constructs `makeAgentWorkScheduler` (grep `makeAgentWorkScheduler(` — pass `cfg` with `features`) and the webhook mention-ask path (grep `promoteAskFromWebhookEvent` outside slashIntake; gate `features.ask === "off"` the same way)
- Modify: `src/settings/envKeys.ts`, `src/settings/defaults.ts`, `src/config.ts`, `.env.example` (delete the three `*_AUTO_ACTIONS` vars, `DEFAULT_*_AUTO_ACTIONS`, `readAutoActions()`, and `AUTOMATED_PR_ACTIONS` if now unused)
- Test: `test/intakePlanner.test.ts` (rewrite), `test/schedulerAutomatedDescribe.test.ts`, `test/slashIntake*.test.ts` / `test/askIntake.test.ts` (adjust), new cases in `test/intakePlanner.test.ts`

**Interfaces:**
- Consumes: `Features`, `AUTO_TRIGGER_ACTIONS` (Task 1); `cfg.features` (Task 3).
- Produces: `planAutomatedPullRequestIntake(action: string, features: Pick<Features, "review" | "describe" | "verification">): AutomatedPrIntakePlan`; `applySlashCommandIntake(boss, client, input, features: Features)`; `slashDisabledBody(command: string): string`.

- [ ] **Step 1: Rewrite planner tests** — replace the options-set fixtures in `test/intakePlanner.test.ts` with mode fixtures:

```ts
const allAuto = { review: "auto", describe: "auto", verification: "auto" } as const;

it("opened triggers review and description in auto mode", () => {
  expect(planAutomatedPullRequestIntake("opened", allAuto).kinds).toEqual(["review", "description"]);
});

it("synchronize triggers verification only", () => {
  expect(planAutomatedPullRequestIntake("synchronize", allAuto).kinds).toEqual(["verification"]);
});

it("manual/off modes suppress auto triggers", () => {
  expect(
    planAutomatedPullRequestIntake("opened", { review: "manual", describe: "off", verification: "auto" }).kinds,
  ).toEqual([]);
  expect(
    planAutomatedPullRequestIntake("synchronize", { review: "auto", describe: "auto", verification: "off" }).kinds,
  ).toEqual([]);
});
```

Run: `nub run test -- test/intakePlanner.test.ts` — expected FAIL (signature mismatch).

- [ ] **Step 2: Rewrite `src/agentWork/intake/planner.ts`:**

```ts
import { AUTO_TRIGGER_ACTIONS, type Features } from "../../settings/index.js";

/** Durable work kinds scheduled from automated pull_request webhooks. */
type AutomatedPrIntakeKind = "review" | "description" | "verification";

export type AutomatedPrIntakePlan = {
  readonly kinds: readonly AutomatedPrIntakeKind[];
};

/** Pure planner: maps webhook action + feature modes → agent work kinds (no I/O). */
export function planAutomatedPullRequestIntake(
  action: string,
  features: Pick<Features, "review" | "describe" | "verification">,
): AutomatedPrIntakePlan {
  const kinds: AutomatedPrIntakeKind[] = [];
  if (features.review === "auto" && AUTO_TRIGGER_ACTIONS.review.has(action)) kinds.push("review");
  if (features.describe === "auto" && AUTO_TRIGGER_ACTIONS.describe.has(action)) {
    kinds.push("description");
  }
  if (features.verification === "auto" && AUTO_TRIGGER_ACTIONS.verification.has(action)) {
    kinds.push("verification");
  }
  return { kinds };
}
```

Update `applier.ts` (`cfg: Pick<Config, "features">`, pass `cfg.features` to the planner) and `scheduler.ts:43` the same way; fix the `makeAgentWorkScheduler` construction site.

- [ ] **Step 3: Slash gating.** In `src/settings/slashConstants.ts` add:

```ts
export function slashDisabledBody(command: string): string {
  return `\`/${command}\` is disabled on this deployment (\`FEATURE_*\` settings — see docs/features.md).`;
}
```

In `slashIntake.ts`, `applySlashCommandIntake` gains a `features: Features` last parameter. After building `ctx` and before the handler dispatch (`slashIntake.ts:396`):

```ts
  const disabledCommands: Record<string, boolean> = {
    ask: features.ask === "off",
    describe: features.describe === "off",
    triage: features.triage === "off",
  };
  if (disabledCommands[command]) {
    await enqueueSlashAck(ctx, {
      reply: { target: input.replyTarget, body: slashDisabledBody(command) },
    });
    events.push({ name: "ignored_disabled_slash_command", fields: { command } });
    return events;
  }
```

Gate the mention-ask path with the same `features.ask === "off"` check where `promoteAskFromWebhookEvent` is invoked outside slash intake (grep first; mirror the ack-reply pattern used there).

- [ ] **Step 4: Delete the old knobs.** Remove `REVIEW_AUTO_ACTIONS`/`DESCRIPTION_AUTO_ACTIONS`/`VERIFICATION_AUTO_ACTIONS` from `envKeys.ts`, `defaults.ts` (`DEFAULT_*_AUTO_ACTIONS`), `config.ts` (`readAutoActions` + fields), `.env.example`. Delete `AUTOMATED_PR_ACTIONS` from settings if nothing else imports it.

- [ ] **Step 5: Verify + commit**

Run: `nub run check:code && nub run test`
Expected: PASS, including scheduler/slash/ask intake suites.

```bash
git add -A
git commit -m "feat: drive intake from feature modes"
```

---

### Task 6: Feature-mode publish surfaces + always-on collapse

**Files:**
- Modify: `src/review/publish/publishReview.ts` (`Pick` at :233-235 → `"features"`; :456 `cfg.features.commitStatus`; :506-531 labels from `cfg.features.reviewLabels`)
- Modify: `src/agent/description/publishDescription.ts:40-41` (`cfg.features.titleRewrite`)
- Modify: `src/review/run/reviewRun.ts:123` and `src/review/publish/submitReviewTool.ts:115` (drop the config condition; keep the other conjuncts)
- Modify: `src/settings/envKeys.ts`, `src/settings/defaults.ts`, `src/config.ts`, `.env.example` (delete `ENABLE_REVIEW_LABELS_EFFORT`, `ENABLE_REVIEW_LABELS_SECURITY`, `ENABLE_REVIEW_COMMIT_STATUS`, `DESCRIPTION_GENERATE_TITLE`, `REVIEW_INJECT_ANCHOR_MENU`, `REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT` + their defaults/reads/fields)
- Test: `test/publishReview.labelsAndTokenExpiry.test.ts`, `test/reviewRun.test.ts`, `test/submitReviewTool.test.ts`, description publish tests (grep `descriptionGenerateTitle` in `test/`)

Label mapping (write as a tiny helper next to the existing label-sync code in publishReview.ts):

```ts
const effort = cfg.features.reviewLabels !== "off";
const security = cfg.features.reviewLabels === "effort+security";
```

`effort`/`security` slot into the existing `{ effort: ..., security: ... }` objects at :515-516 and :530-531; the guard at :506 becomes `effort || security || syncCategoryLabels`.

- [ ] **Step 1: Update the tests first** — swap fake-cfg booleans for `features` fixtures, e.g. `cfg: { features: { reviewLabels: "effort+security", commitStatus: true, ... } }`; add a `reviewLabels: "off"` case asserting no label sync. Run the four suites — expected FAIL.
- [ ] **Step 2: Implement** the mappings above; delete the six env vars end-to-end (envKeys, defaults, config.ts reads + return fields, `.env.example` lines).
- [ ] **Step 3: Verify + commit**

Run: `nub run check:code && nub run test`
Expected: PASS.

```bash
git add -A
git commit -m "feat: gate publish surfaces by feature modes"
```

---

### Task 7: Wire fail-fast guard + PostHog through config

**Files:**
- Modify: `src/config.ts` (first line of `loadConfig()`: `assertNoRemovedEnv(process.env);`)
- Modify: `src/posthog.ts` (init pattern below)
- Modify: `src/index.ts` (call `initPostHog(...)` right after `loadConfig()`; keep the existing `context7_enabled` boot log intact)
- Modify: the 9 `posthog` consumers (`grep -rln "posthog.js\"" src`) — switch `posthog.` member calls to `getPostHog().`
- Test: `test/removedEnv.test.ts` gains a loadConfig-level case; posthog-touching tests (grep `posthog` in `test/`) adjusted

New `src/posthog.ts`:

```ts
import { PostHog } from "posthog-node";
import { sanitizePostHogEvent } from "./security/sanitizePostHogEvent.js";

let client: PostHog | null = null;

function buildClient(projectToken: string, host: string): PostHog {
  return new PostHog(projectToken, {
    ...(host ? { host } : {}),
    enableExceptionAutocapture: true,
    before_send: sanitizePostHogEvent,
  });
}

/** Called once from src/index.ts with loadConfig() values; empty token disables capture upstream. */
export function initPostHog(opts: { readonly projectToken: string; readonly host: string }): void {
  client ??= buildClient(opts.projectToken, opts.host.trim());
}

export function getPostHog(): PostHog {
  client ??= buildClient("", "");
  return client;
}

export function shutdownPostHog(): Promise<void> {
  return client ? Promise.resolve(client.shutdown()) : Promise.resolve();
}
```

- [ ] **Step 1: Failing test** — add to `test/removedEnv.test.ts` (reuse the config test env fixture): setting `ENABLE_REVIEW_COMMIT_STATUS=true` makes `loadConfig()` reject with `/removed environment variables/`. Run — expected FAIL (guard not wired).
- [ ] **Step 2: Implement** the guard call, posthog rewrite, `initPostHog(cfg.posthogProjectToken ...)` in `src/index.ts`, consumer sweep.
- [ ] **Step 3: Verify + commit**

Run: `nub run check:code && nub run test`
Expected: PASS.

```bash
git add -A
git commit -m "feat: fail fast on removed env vars and route posthog through config"
```

---

### Task 8: Settings inventory test extension

**Files:**
- Modify: `test/settingsInventory.test.ts`

- [ ] **Step 1: Add failing test** (docs/features.md does not exist yet — this drives Task 9):

```ts
  it("docs/features.md documents every FEATURE_* key", () => {
    const featuresDoc = fs.readFileSync(path.join(process.cwd(), "docs", "features.md"), "utf8");
    const featureKeys = Object.values(ENV).filter((key) => key.startsWith("FEATURE_"));
    expect(featureKeys.length).toBe(8);
    for (const key of featureKeys) {
      expect(featuresDoc.includes(key), `missing ${key} in docs/features.md`).toBe(true);
    }
  });
```

Also assert the final surface size in the first test: `expect(Object.values(ENV).length).toBe(48);`

- [ ] **Step 2: Run** `nub run test -- test/settingsInventory.test.ts` — expected FAIL (missing docs/features.md). Leave red; Task 9 turns it green. Do not commit yet — Tasks 8+9 commit together.

---

### Task 9: Documentation

**Files:**
- Create: `docs/features.md`
- Modify: `docs/configuration.md` (features section replaced by a pointer to features.md; remove all rows for deleted vars; group remaining rows under Infra / Ops headings)
- Modify: `README.md` (link features.md from "How It Works"; fix the `ENABLE_REVIEW_COMMIT_STATUS` mention at :38 → `FEATURE_COMMIT_STATUS`; check `LOG_REDACT` mention at :265 still accurate)
- Modify: `CONTEXT.md` (add vocabulary: **Feature** — user-facing capability setting; **Capability mode** — off/manual/auto; **Token burner** — LLM surface other than the core review run)
- Modify: `AGENTS.md` ("Open when" table row: `Feature catalog | docs/features.md`)

`docs/features.md` skeleton (fill prose, keep the table exact):

```markdown
# Features

The eight `FEATURE_*` settings are pr-agent's entire user-facing configuration.
Everything else is deployment wiring (see docs/configuration.md).
Modes: `off` = disabled (slash commands reply with a notice), `manual` = slash
command only, `auto` = slash command + automatic trigger.

| Setting | Values | Default | Spends tokens? | What it does |
|---|---|---|---|---|
| `FEATURE_REVIEW` | `manual` `auto` | `auto` | yes | Core review. `auto` reviews each PR when opened; `/review` always available. |
| `FEATURE_DESCRIBE` | `off` `manual` `auto` | `auto` | yes | PR description generation. `auto` runs when a PR opens. |
| `FEATURE_VERIFICATION` | `off` `auto` | `auto` | yes | Re-checks open findings on new pushes and replies in their threads. |
| `FEATURE_ASK` | `off` `manual` | `manual` | yes | `/ask` and `@bot` question threads. |
| `FEATURE_TRIAGE` | `off` `manual` | `manual` | yes | `/triage` fix-suggestion runs. |
| `FEATURE_REVIEW_LABELS` | `off` `effort` `effort+security` | `effort` | no | Review-effort / security labels synced onto the PR. |
| `FEATURE_COMMIT_STATUS` | `false` `true` | `false` | no | `pr-agent/review` commit status on the PR head. |
| `FEATURE_TITLE_REWRITE` | `false` `true` | `false` | no | Allows `/describe` to rewrite the PR title. |

Removed variables fail startup with a pointer here; there are no aliases.
```

- [ ] **Step 1: Write all five docs.**
- [ ] **Step 2: Verify** `nub run test -- test/settingsInventory.test.ts` now PASSES; `nub run test` full suite PASSES.
- [ ] **Step 3: Commit (Tasks 8+9 together)**

```bash
git add -A
git commit -m "docs: add feature catalog and tiered configuration docs"
```

---

### Task 10: Full verification sweep

- [ ] **Step 1:** `nub run check:code && nub run test` — all green.
- [ ] **Step 2:** Residue grep — must return nothing outside the spec, the plan, and `REMOVED_ENV`/docs migration notes:

```bash
grep -rn "ENABLE_REVIEW_\|_AUTO_ACTIONS\|DESCRIPTION_GENERATE_TITLE\|REVIEW_INJECT_ANCHOR_MENU\|REVIEW_REQUIRE_DIFF_CACHE" \
  --include="*.ts" --include="*.md" --include="*.yml" --include="*.yaml" --include=".env.example" . \
  | grep -v node_modules | grep -v docs/superpowers | grep -v removedEnv | grep -v features.md
```

- [ ] **Step 3:** `.env.example` sanity: `grep -cE '^[A-Z0-9_]+=' .env.example` → 49 (48 ENV + `OPENAI_API_KEY`; `ANTHROPIC`/`GOOGLE` keys stay commented out).
- [ ] **Step 4:** Boot smoke (no Postgres needed for config parse): `ENABLE_REVIEW_COMMIT_STATUS=true ROLE=web nub src/index.ts` must exit with the removed-var error naming `FEATURE_COMMIT_STATUS`.
- [ ] **Step 5:** Commit any leftovers; tree clean.
