import { createHash } from "node:crypto";
import { automatedQualitySystemPrompt } from "../src/prompts/quality/prompt.ts";
import { automatedReviewTestsSystemPrompt } from "../src/prompts/tests/prompt.ts";
import { automatedSecuritySystemPrompt } from "../src/prompts/security/prompt.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunnerTurn } from "../src/agent/providers/interface.ts";
import type { PiSession } from "../src/agent/runtime/types.ts";
import { escalatedToolRounds, escalationForAttempt } from "../src/agentWork/retryPolicy.ts";
import { buildAskSystemPrompt } from "../src/prompts/ask/prompt.ts";
import { CI_SUMMARY_SYSTEM_PROMPT } from "../src/prompts/ci/prompt.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../src/prompts/compaction/prompt.ts";
import { descriptionSystemPrompt } from "../src/prompts/description/prompt.ts";
import { BOUND_POLICY_JUDGE_SYSTEM_PROMPT } from "../src/prompts/judge/prompt.ts";
import {
  orchestratorHarness,
  orchestratorSystemPrompt,
  renderBriefMessage,
} from "../src/prompts/orchestrator/prompt.ts";
import { triageSystemPrompt } from "../src/prompts/triage/prompt.ts";
import { verificationSystemPrompt } from "../src/prompts/verification/prompt.ts";
import { buildAutomatedSystemPrompt } from "../src/prompts/correctness/prompt.ts";
import { specialistSharedPrefix } from "../src/prompts/shared/prefix.ts";
import {
  causalPublicationContract,
  highStakesTrivialTrapGuidance,
  outOfScopeFilesGuidance,
  readOnlyReviewGuidance,
  scopePushbackGuidance,
  severityRubric,
} from "../src/prompts/shared/behavior.ts";
import { communicationGuidance } from "../src/prompts/shared/communication.ts";
import { specialistFindingsReportContract } from "../src/prompts/shared/output.ts";
import {
  agentInstructionFilesGuidance,
  priorInlineFeedbackGuidance,
  repoPolicyGuidance,
  specialistUntrustedEvidenceGuidance,
  userSupplementGuidance,
} from "../src/prompts/shared/safety.ts";
import { specialistInvestigationHarness } from "../src/prompts/shared/tools.ts";
import { MAX_TOOL_ROUNDS, SUBMIT_ONLY_MAX_TOOL_ROUNDS } from "../src/settings/index.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { NO_CANDIDATE_TEST_GAP } from "../src/review/orchestrator/testsEvidence.ts";
import { AppError } from "../src/errors/appError.ts";
import {
  SPECIALIST_REPEATED_EXECUTE_NUDGE,
  createSpecialistExecuteRepeat,
  specialistExecuteCalls,
} from "../src/agent/runtime/specialistExecuteRepeat.ts";
import { createTestEvidenceLedger, seedEvidenceForFinding } from "./helpers/evidenceTestHelpers.ts";

type AttemptBehavior =
  | { readonly kind: "report"; readonly report: Record<string, unknown> }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "pending_create"; readonly settleAfterMs: number }
  | { readonly kind: "pending_send"; readonly settleAfterMs: number }
  | { readonly kind: "no_report" }
  | { readonly kind: "pending" };

type TestSession = Pick<PiSession, "role" | "send" | "abort" | "dispose"> & {
  readonly send: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
};

const runnerMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  behaviors: [] as AttemptBehavior[],
  sessions: [] as TestSession[],
  submitResults: [] as unknown[],
  recordExecutionSpan: vi.fn(),
}));

vi.mock("../src/traces/recorder.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/traces/recorder.ts")>()),
  recordExecutionSpan: runnerMocks.recordExecutionSpan,
}));

vi.mock("../src/agent/runtime/createFeatureSession.ts", () => ({
  createFeaturePiSession: runnerMocks.createSession,
}));

import { runSpecialist } from "../src/review/orchestrator/specialistRun.ts";

const finding = {
  suggestedSeverity: "P2",
  file: "src/example.ts",
  startLine: 7,
  endLine: 7,
  title: "Handle the missing value",
  detail:
    "When input.value is missing, the changed branch dereferences it and throws instead of returning null.",
  fixPrompt: "Guard the missing value before dereferencing it.",
};

const correctnessBrief = {
  prIntent: "Route reviews through one orchestrator.",
  architectureNotes: "The orchestrator owns recon and synthesis.",
  riskAreas: [
    {
      area: "Incremental publishing",
      files: ["src/review/orchestrator/orchestratorRun.ts"],
      reason: "Published thread batches must survive retries.",
    },
  ],
  fileMap: "src/review/orchestrator: orchestration and specialist handoff",
  specialistFocus: {
    correctness: "Trace state transitions and failure paths.",
    security: "Inspect trust boundaries and credential handling.",
    quality: "Check module ownership and reader load.",
    tests: "Find missing regression and integration coverage.",
  },
};

const agentEventsContext = {
  pool: {} as never,
  workItemId: "work",
  installationId: 1,
  owner: "owner",
  repo: "repo",
  prNumber: 2,
  executionId: "execution",
  attemptCount: 2,
};

const findingsReport = { status: "findings", findings: [finding] } as const;
const testsFindingsReport = {
  status: "findings",
  findings: [{ ...finding, testsClaim: "invalidated_test" }],
} as const;
const emptyReport = { status: "no_findings", findings: [] } as const;

function coverageGapReport(overrides: Record<string, unknown> = {}) {
  return {
    status: "findings",
    findings: [
      {
        ...finding,
        suggestedSeverity: "P1",
        testsClaim: "coverage_gap",
        testEvidence: {
          searched: ["payment total"],
          read: [] as string[],
          gap: NO_CANDIDATE_TEST_GAP,
        },
        ...overrides,
      },
    ],
  };
}

function specialistArgs(overrides: Partial<Parameters<typeof runSpecialist>[0]> = {}) {
  return {
    cfg: makeTestConfig(),
    cwd: "/tmp/pr-agent-specialist-test",
    specialist: "correctness" as const,
    briefMessage: "Review this pull request.",
    workspaceTools: { piTools: [], executors: {} },
    timeoutMs: 10_000,
    shouldContinue: () => true,
    ...overrides,
  };
}

describe("runSpecialist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerMocks.behaviors.length = 0;
    runnerMocks.sessions.length = 0;
    runnerMocks.submitResults.length = 0;
    vi.spyOn(Math, "random").mockReturnValue(0);
    runnerMocks.createSession.mockImplementation(async (params) => {
      const behavior = runnerMocks.behaviors.shift();
      if (!behavior) throw new Error("missing specialist test behavior");
      if (behavior.kind === "pending_create") {
        const session: TestSession = {
          role: "specialist",
          send: vi.fn(async () => ({ text: "", end: "completed" as const })),
          abort: vi.fn(async () => undefined),
          dispose: vi.fn(async () => undefined),
        };
        runnerMocks.sessions.push(session);
        return new Promise<TestSession>((resolve) => {
          setTimeout(() => resolve(session), behavior.settleAfterMs);
        });
      }
      let rejectPending: ((error: Error) => void) | undefined;
      const abort = vi.fn(async () => {
        rejectPending?.(new Error("specialist session aborted"));
      });
      const session: TestSession = {
        role: "specialist",
        send: vi.fn(async () => {
          if (behavior.kind === "error") throw behavior.error;
          if (behavior.kind === "pending_send") {
            return new Promise<AgentRunnerTurn>((resolve) => {
              setTimeout(() => resolve({ text: "", end: "completed" }), behavior.settleAfterMs);
            });
          }
          if (behavior.kind === "pending") {
            return new Promise<AgentRunnerTurn>((_, reject) => {
              rejectPending = reject;
            });
          }
          if (behavior.kind === "no_report") return { text: "", end: "completed" as const };
          runnerMocks.submitResults.push(
            await params.executors.submit_findings_report(behavior.report),
          );
          return { text: "", end: "completed" as const };
        }),
        abort,
        dispose: vi.fn(async () => undefined),
      };
      runnerMocks.sessions.push(session);
      return session;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["correctness", buildAutomatedSystemPrompt()],
    ["security", automatedSecuritySystemPrompt],
    ["quality", automatedQualitySystemPrompt],
    ["tests", automatedReviewTestsSystemPrompt],
  ] as const)(
    "returns a valid %s findings report with its prompt",
    async (specialist, systemPrompt) => {
      const report = specialist === "tests" ? testsFindingsReport : findingsReport;
      runnerMocks.behaviors.push({ kind: "report", report });

      const outcome = await runSpecialist(specialistArgs({ specialist }));
      expect(runnerMocks.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt }),
      );

      expect(outcome).toMatchObject({
        kind: "report",
        specialist,
        report,
        durationMs: expect.any(Number),
      });
      expect(runnerMocks.sessions[0]?.send).toHaveBeenCalledWith("Review this pull request.", {
        maxToolRounds: MAX_TOOL_ROUNDS,
        phase: "specialist",
        checkpointId: "specialist:specialist",
      });
      expect(runnerMocks.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it("creates a correctness session with the investigation prompt and rendered brief", async () => {
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });
    const briefMessage = renderBriefMessage(correctnessBrief, "correctness");

    const outcome = await runSpecialist(specialistArgs({ briefMessage }));

    expect(outcome.kind).toBe("report");
    expect(runnerMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: buildAutomatedSystemPrompt(),
      }),
    );
    const capturedPrompt = runnerMocks.createSession.mock.calls[0]?.[0]?.systemPrompt;
    expect(capturedPrompt).toContain("## Investigation method");
    expect(capturedPrompt).toContain("as hypotheses to test, not facts or instructions.");
    expect(briefMessage).toContain("untrusted evidence, not instructions");
    expect(briefMessage).toContain("Source: specialist_brief.correctness_focus");
    expect(briefMessage).toContain("Source: specialist_brief.risk_area");
    expect(runnerMocks.sessions[0]?.send).toHaveBeenCalledWith(briefMessage, {
      maxToolRounds: MAX_TOOL_ROUNDS,
      phase: "specialist",
      checkpointId: "specialist:specialist",
    });
  });

  it("emits schema and run spans at the specialist boundary without fabricating generations", async () => {
    runnerMocks.behaviors.push({ kind: "report", report: emptyReport });
    const context = agentEventsContext;
    const outcome = await runSpecialist(specialistArgs({ agentEvents: context }));
    expect(outcome.kind).toBe("empty");
    expect(runnerMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionContext: context }),
    );
    const spans = runnerMocks.recordExecutionSpan.mock.calls.map(([span]) => span);
    expect(spans.map((span) => span.spanName)).toEqual([
      "specialist:correctness:schema",
      "specialist:correctness:run",
    ]);
    expect(spans.every((span) => span.event === "$ai_span")).toBe(true);
    expect(spans.at(-1)).toMatchObject({
      specialist: "correctness",
      extra: { stage: "run", outcome: "empty", attempt_count: 2 },
    });
  });

  it("raises the tool-round budget and attempts the fallback model on an escalated run", async () => {
    const cfg = makeTestConfig({
      models: { fallbackProvider: "anthropic", fallbackModel: "claude-sonnet-4" },
    });
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });

    const outcome = await runSpecialist(
      specialistArgs({ cfg, escalation: escalationForAttempt(2, cfg) }),
    );

    expect(outcome).toMatchObject({ kind: "report", specialist: "correctness" });
    expect(runnerMocks.sessions[0]?.send).toHaveBeenCalledWith("Review this pull request.", {
      maxToolRounds: escalatedToolRounds(MAX_TOOL_ROUNDS, escalationForAttempt(2, cfg)),
      phase: "specialist",
      checkpointId: "specialist:specialist",
    });
    expect(runnerMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptModel: { provider: "anthropic", model: "claude-sonnet-4" },
      }),
    );
  });

  it("raises only the tool-round budget when the plan has no fallback model", async () => {
    const cfg = makeTestConfig();
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });

    await runSpecialist(specialistArgs({ cfg, escalation: escalationForAttempt(2, cfg) }));

    expect(runnerMocks.sessions[0]?.send).toHaveBeenCalledWith(
      "Review this pull request.",
      expect.objectContaining({
        maxToolRounds: escalatedToolRounds(MAX_TOOL_ROUNDS, escalationForAttempt(2, cfg)),
      }),
    );
    expect(runnerMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ attemptModel: undefined }),
    );
  });

  it("grants an escalated attempt the same tools, prompt, and trust inputs", async () => {
    const cfg = makeTestConfig({
      models: { fallbackProvider: "anthropic", fallbackModel: "claude-sonnet-4" },
    });
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });
    await runSpecialist(specialistArgs({ cfg }));
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });
    await runSpecialist(specialistArgs({ cfg, escalation: escalationForAttempt(2, cfg) }));

    const baselineParams = runnerMocks.createSession.mock.calls[0]?.[0];
    const escalatedParams = runnerMocks.createSession.mock.calls[1]?.[0];
    expect(escalatedParams?.tools).toEqual(baselineParams?.tools);
    expect(Object.keys(escalatedParams?.executors ?? {})).toEqual(
      Object.keys(baselineParams?.executors ?? {}),
    );
    expect(escalatedParams?.systemPrompt).toBe(baselineParams?.systemPrompt);
    expect(escalatedParams?.cwd).toBe(baselineParams?.cwd);
    expect(escalatedParams?.specialistId).toBe(baselineParams?.specialistId);
    expect(escalatedParams?.attemptModel).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(baselineParams?.attemptModel).toBeUndefined();
  });

  it("keeps the evidence gate authoritative on an escalated attempt", async () => {
    const cfg = makeTestConfig({
      models: { fallbackProvider: "anthropic", fallbackModel: "claude-sonnet-4" },
    });
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });
    const evidenceLedger = createTestEvidenceLedger();

    await expect(
      runSpecialist(
        specialistArgs({
          cfg,
          escalation: escalationForAttempt(2, cfg),
          evidenceLedger,
          headSha: evidenceLedger.headSha,
        }),
      ),
    ).resolves.toMatchObject({ kind: "empty", specialist: "correctness" });
  });

  it("repairs a single-object findings report at the parse seam", async () => {
    runnerMocks.behaviors.push({
      kind: "report",
      report: { status: "findings", findings: finding },
    });

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome).toMatchObject({
      kind: "report",
      specialist: "correctness",
      report: findingsReport,
    });
  });

  it("returns empty for a valid no_findings report", async () => {
    runnerMocks.behaviors.push({ kind: "report", report: emptyReport });

    await expect(runSpecialist(specialistArgs())).resolves.toMatchObject({
      kind: "empty",
      specialist: "correctness",
      durationMs: expect.any(Number),
    });
  });

  it("keeps the tests prompt on the coverage-gap ceiling and the vacuous exclusions", () => {
    expect(automatedReviewTestsSystemPrompt).toContain(NO_CANDIDATE_TEST_GAP);
    expect(automatedReviewTestsSystemPrompt).toContain("coverage_gap");
    expect(automatedReviewTestsSystemPrompt).toContain("invalidated_test");
    expect(automatedReviewTestsSystemPrompt).toContain(
      "still passes if every imported function returned undefined",
    );
    expect(automatedReviewTestsSystemPrompt).toContain("P2 is the ceiling for test-gap findings");
    expect(automatedReviewTestsSystemPrompt).toContain("criticalPath");
  });

  it("starts the four specialist prompts with one prefix and the ordered leftover", () => {
    const prompts = [
      buildAutomatedSystemPrompt(),
      automatedSecuritySystemPrompt,
      automatedQualitySystemPrompt,
      automatedReviewTestsSystemPrompt,
    ] as const;
    const identities = [
      "You are the correctness specialist investigator for this pull request. Your job is to find the real, actionable defects its changes introduce: each one has a trigger path you can show from the code. Style, taste, and speculation belong to no specialist.",
      "You are the security specialist investigator for this pull request, focused on web application security, authentication systems, and modern frameworks. Think like an attacker: the valuable findings are subtle logic flaws such as race conditions, auth bypasses through parameter manipulation, and trust-boundary violations.",
      "You are the quality specialist investigator for this pull request. Your job is to find structural causes of present harm: invalid ownership, diverged duplicates, unsafe fallbacks, unreachable cleanup, contradictory sources of truth, and layer-boundary failures with an observable caller impact.",
      "You are the tests specialist investigator for this pull request. Think in failure modes: for each changed behaviour, ask what input, state, or sequencing would expose a bug, then draft the test that proves the code handles it. The testing posture below decides whether this project wants test suggestions at all.",
    ] as const;
    const blocks = [
      readOnlyReviewGuidance,
      specialistInvestigationHarness,
      specialistUntrustedEvidenceGuidance,
      userSupplementGuidance,
      severityRubric,
      causalPublicationContract,
      highStakesTrivialTrapGuidance,
      priorInlineFeedbackGuidance,
      agentInstructionFilesGuidance,
      repoPolicyGuidance,
      outOfScopeFilesGuidance,
      scopePushbackGuidance,
      communicationGuidance,
      specialistFindingsReportContract,
    ] as const;
    const leftoverSha256 = [
      "902a82903551a998b6f40fb6ee9a95b12a3fe045bec4fa0fd8f1ec0031002f88",
      "e0941694f5262c4988a26b12ea9c6ddbc4739c3d53dcdaba9c9ec5c04cc1dbf0",
      "36a203e03b2df9874a80118c2d64900719921792be56c4ab45e76492cb667cd8",
      "4bed622a7f2116c562377c64cf1891aa56c572bc0874f7abe3c7b81d04451999",
    ] as const;
    expect(new Set(prompts).size).toBe(prompts.length);
    for (const sentence of identities) {
      expect(specialistSharedPrefix.includes(sentence)).toBe(false);
    }
    prompts.forEach((prompt, index) => {
      const head = `${specialistSharedPrefix}\n\n`;
      expect(prompt.startsWith(head)).toBe(true);
      const body = prompt.slice(head.length);
      expect(body.startsWith(identities[index] ?? "")).toBe(true);
      expect(createHash("sha256").update(body).digest("hex")).toBe(leftoverSha256[index]);
      for (const block of blocks) {
        const at = prompt.indexOf(block);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBe(prompt.lastIndexOf(block));
        expect(body.includes(block)).toBe(false);
      }
    });
    const securityBody = automatedSecuritySystemPrompt.slice(specialistSharedPrefix.length + 2);
    for (const text of [
      specialistSharedPrefix,
      securityBody,
      orchestratorHarness,
      buildAskSystemPrompt(),
    ]) {
      expect(text).not.toContain("resolveLibraryId");
      expect(text).not.toContain("getLibraryDocs");
    }
    expect(buildAskSystemPrompt()).toContain("Ground your answer in code you read in this session");
    const correctnessBody = buildAutomatedSystemPrompt().slice(specialistSharedPrefix.length + 2);
    const methodBegin = correctnessBody.indexOf("<!-- BEGIN_SHARED_METHODOLOGY -->");
    const method = correctnessBody.indexOf("## Investigation method");
    const methodEnd = correctnessBody.indexOf("<!-- END_SHARED_METHODOLOGY -->");
    expect(method).toBeGreaterThan(methodBegin);
    expect(methodEnd).toBeGreaterThan(method);
    expect(automatedReviewTestsSystemPrompt.indexOf("For a coverage_gap finding")).toBeGreaterThan(
      automatedReviewTestsSystemPrompt.indexOf(severityRubric) + severityRubric.length,
    );
  });

  it("keeps the scope rule once in each review prompt", () => {
    const carry = [
      specialistSharedPrefix,
      orchestratorSystemPrompt,
      buildAskSystemPrompt(),
      CI_SUMMARY_SYSTEM_PROMPT,
      triageSystemPrompt,
      verificationSystemPrompt,
    ];
    for (const prompt of carry) {
      expect(prompt.split(scopePushbackGuidance).length - 1).toBe(1);
    }
    for (const prompt of [
      descriptionSystemPrompt,
      SUMMARIZATION_SYSTEM_PROMPT,
      BOUND_POLICY_JUDGE_SYSTEM_PROMPT,
    ]) {
      expect(prompt.includes(scopePushbackGuidance)).toBe(false);
    }
  });

  async function rejectedTestsReport(report: Record<string, unknown>, cfg = makeTestConfig()) {
    runnerMocks.behaviors.push({ kind: "report", report }, { kind: "report", report });
    const outcome = await runSpecialist(
      specialistArgs({
        specialist: "tests",
        cfg,
        evidenceLedger: cfg.review.testsEvidence ? createTestEvidenceLedger() : undefined,
        headSha: cfg.review.testsEvidence ? "abc1234" : undefined,
      }),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return outcome;
    expect(outcome.error.cause).toMatchObject({ kind: "specialist_invalid_report" });
    const repairPrompt = String(runnerMocks.sessions[0]?.send.mock.calls[1]?.[0]);
    expect(repairPrompt).toContain("Fix the report and call submit_findings_report");
    expect(repairPrompt).not.toContain("were dropped");
    return outcome;
  }

  it("rejects a coverage gap whose read path was only opened", async () => {
    const ledger = createTestEvidenceLedger();
    ledger.noteOpened("test/pay.test.ts");
    seedEvidenceForFinding(ledger, finding);
    const report = coverageGapReport({
      testEvidence: {
        searched: ["payment total"],
        read: ["test/pay.test.ts"],
        gap: "The zero-total branch is unread.",
        criticalPath: "money",
      },
    });
    runnerMocks.behaviors.push({ kind: "report", report }, { kind: "report", report });

    const outcome = await runSpecialist(
      specialistArgs({
        specialist: "tests",
        cfg: makeTestConfig({ review: { testsEvidence: true } }),
        evidenceLedger: ledger,
        headSha: ledger.headSha,
      }),
    );

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.error.cause).toMatchObject({ kind: "specialist_invalid_report" });
    expect(String(runnerMocks.sessions[0]?.send.mock.calls[1]?.[0])).toContain("no content read");
    expect(String(runnerMocks.sessions[0]?.send.mock.calls[1]?.[0])).not.toContain("were dropped");
  });

  it("rejects a coverage-gap path outside the workspace and a sensitive path", async () => {
    const outside = await rejectedTestsReport(
      coverageGapReport({
        testEvidence: {
          searched: ["payment total"],
          read: ["../secret.txt"],
          gap: "The neighbor is outside the checkout.",
        },
      }),
    );
    expect(String(runnerMocks.sessions[0]?.send.mock.calls[1]?.[0])).toContain(
      "outside the workspace",
    );
    expect(outside.kind).toBe("error");

    runnerMocks.behaviors.length = 0;
    runnerMocks.sessions.length = 0;
    const sensitive = await rejectedTestsReport(
      coverageGapReport({
        testEvidence: {
          searched: ["payment total"],
          read: [".env"],
          gap: "The neighbor is a secret file.",
        },
      }),
    );
    expect(String(runnerMocks.sessions.at(-1)?.send.mock.calls[1]?.[0])).toContain("sensitive");
    expect(sensitive.kind).toBe("error");
  });

  it("rejects a pure coverage-gap P0 and accepts the two P0 shapes", async () => {
    const illegal = await rejectedTestsReport(
      coverageGapReport({
        suggestedSeverity: "P0",
        testEvidence: {
          searched: ["payment total"],
          read: [],
          gap: NO_CANDIDATE_TEST_GAP,
        },
      }),
    );
    expect(String(runnerMocks.sessions[0]?.send.mock.calls[1]?.[0])).toContain("ceiling P1");
    expect(illegal.kind).toBe("error");

    runnerMocks.behaviors.length = 0;
    runnerMocks.sessions.length = 0;
    const emptyRead = coverageGapReport({
      suggestedSeverity: "P0",
      testEvidence: {
        searched: ["payment total"],
        read: [],
        gap: NO_CANDIDATE_TEST_GAP,
        criticalPath: "money",
      },
    });
    runnerMocks.behaviors.push({ kind: "report", report: emptyRead });
    await expect(runSpecialist(specialistArgs({ specialist: "tests" }))).resolves.toMatchObject({
      kind: "report",
      specialist: "tests",
      report: emptyRead,
    });

    const ledger = createTestEvidenceLedger();
    seedEvidenceForFinding(ledger, finding);
    seedEvidenceForFinding(ledger, {
      file: "test/pay.test.ts",
      startLine: 1,
      endLine: 1,
    });
    const neighbor = coverageGapReport({
      suggestedSeverity: "P0",
      testEvidence: {
        searched: ["payment total"],
        read: ["test/pay.test.ts"],
        gap: "The zero-total branch has no assertion.",
        criticalPath: "data_integrity",
      },
    });
    runnerMocks.behaviors.push({ kind: "report", report: neighbor });
    await expect(
      runSpecialist(
        specialistArgs({
          specialist: "tests",
          cfg: makeTestConfig({ review: { testsEvidence: true } }),
          evidenceLedger: ledger,
          headSha: ledger.headSha,
        }),
      ),
    ).resolves.toMatchObject({ kind: "report", report: neighbor });
  });

  it("drops a tests cite recorded only on another specialist ledger", async () => {
    const security = createTestEvidenceLedger();
    const tests = createTestEvidenceLedger();
    seedEvidenceForFinding(security, finding);
    runnerMocks.behaviors.push({ kind: "report", report: testsFindingsReport });

    const dropped = await runSpecialist(
      specialistArgs({
        specialist: "tests",
        evidenceLedger: tests,
        headSha: tests.headSha,
      }),
    );

    expect(dropped.kind).toBe("empty");
    expect(runnerMocks.submitResults[0]).toMatchObject({
      accepted: false,
      droppedFindings: [{ reasonCode: "no_evidence", file: finding.file }],
    });
    expect(security.covers(finding.file, finding.startLine, finding.endLine)).toBe(true);
    expect(tests.covers(finding.file, finding.startLine, finding.endLine)).toBe(false);

    runnerMocks.behaviors.length = 0;
    runnerMocks.sessions.length = 0;
    runnerMocks.submitResults.length = 0;
    seedEvidenceForFinding(tests, finding);
    runnerMocks.behaviors.push({ kind: "report", report: testsFindingsReport });
    await expect(
      runSpecialist(
        specialistArgs({
          specialist: "tests",
          evidenceLedger: tests,
          headSha: tests.headSha,
        }),
      ),
    ).resolves.toMatchObject({ kind: "report", report: testsFindingsReport });
  });

  it("accepts an invalidated test without testEvidence and a never-read path when the flag is off", async () => {
    runnerMocks.behaviors.push({ kind: "report", report: testsFindingsReport });
    await expect(runSpecialist(specialistArgs({ specialist: "tests" }))).resolves.toMatchObject({
      kind: "report",
      report: testsFindingsReport,
    });

    const ledger = createTestEvidenceLedger();
    seedEvidenceForFinding(ledger, finding);
    ledger.noteOpened("test/pay.test.ts");
    const unread = coverageGapReport({
      suggestedSeverity: "P1",
      testEvidence: {
        searched: ["payment total"],
        read: ["test/pay.test.ts"],
        gap: "The zero-total branch has no assertion.",
      },
    });
    runnerMocks.behaviors.push({ kind: "report", report: unread });
    await expect(
      runSpecialist(
        specialistArgs({
          specialist: "tests",
          evidenceLedger: ledger,
          headSha: ledger.headSha,
        }),
      ),
    ).resolves.toMatchObject({ kind: "report", report: unread });
  });

  it("keeps the evidence gate authoritative over an otherwise valid report", async () => {
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });
    const evidenceLedger = createTestEvidenceLedger();

    await expect(
      runSpecialist(
        specialistArgs({
          evidenceLedger,
          headSha: evidenceLedger.headSha,
        }),
      ),
    ).resolves.toMatchObject({
      kind: "empty",
      specialist: "correctness",
    });
  });

  it("uses one fresh-session retry after an ordinary failure", async () => {
    runnerMocks.behaviors.push(
      { kind: "error", error: new Error("provider disconnected") },
      { kind: "report", report: findingsReport },
    );

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome.kind).toBe("report");
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(2);
    expect(runnerMocks.sessions.every((session) => session.dispose.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("returns review.specialist_failed after two ordinary failures", async () => {
    runnerMocks.behaviors.push(
      { kind: "error", error: new Error("first ordinary failure") },
      { kind: "error", error: new Error("second ordinary failure") },
    );

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome).toMatchObject({
      kind: "error",
      specialist: "correctness",
      error: {
        code: "review.specialist_failed",
        context: { classification: "unknown", attempts: 2, deadlineHit: false },
      },
    });
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(2);
  });

  it("exhausts validation repair rounds when no report is submitted", async () => {
    runnerMocks.behaviors.push({ kind: "no_report" }, { kind: "no_report" });

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "unknown", attempts: 2 },
      },
    });
    expect(runnerMocks.sessions).toHaveLength(2);
    expect(runnerMocks.sessions.every((session) => session.send.mock.calls.length === 4)).toBe(
      true,
    );
    const repairOptions = runnerMocks.sessions[0]?.send.mock.calls.slice(1).map((call) => call[1]);
    expect(repairOptions).toEqual([
      {
        traceValidationRepair: true,
        maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS,
        phase: "specialist",
        checkpointId: "specialist:specialist",
      },
      {
        traceValidationRepair: true,
        maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS,
        phase: "specialist",
        checkpointId: "specialist:specialist",
      },
      {
        traceValidationRepair: true,
        maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS,
        phase: "specialist",
        checkpointId: "specialist:specialist",
      },
    ]);
  });

  it("aborts the active session before disposal when the deadline expires", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push({ kind: "pending" });

    const outcomePromise = runSpecialist(
      specialistArgs({ timeoutMs: 100, agentEvents: agentEventsContext }),
    );
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    const session = runnerMocks.sessions[0];
    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "timeout", attempts: 1, deadlineHit: true },
      },
    });
    const run = runnerMocks.recordExecutionSpan.mock.calls
      .map(([span]) => span)
      .find((span) => span.spanName === "specialist:correctness:run");
    expect(run).toMatchObject({
      extra: { outcome: "error", classification: "timeout", attempts: 1, deadline_hit: true },
    });
    expect(session?.abort).toHaveBeenCalledTimes(1);
    expect(session?.dispose).toHaveBeenCalledTimes(1);
    expect(session?.abort.mock.invocationCallOrder[0]).toBeLessThan(
      session?.dispose.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("returns at the hard deadline and disposes after a late send settles", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push({ kind: "pending_send", settleAfterMs: 200 });
    let outcome: Awaited<ReturnType<typeof runSpecialist>> | undefined;

    void runSpecialist(specialistArgs({ timeoutMs: 100 })).then((result) => {
      outcome = result;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "timeout", attempts: 1 },
      },
    });
    expect(runnerMocks.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(runnerMocks.sessions[0]?.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(runnerMocks.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns at the hard deadline and cleans up a late session creation afterward", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push({ kind: "pending_create", settleAfterMs: 200 });
    let outcome: Awaited<ReturnType<typeof runSpecialist>> | undefined;

    void runSpecialist(specialistArgs({ timeoutMs: 100 })).then((result) => {
      outcome = result;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "timeout", attempts: 1 },
      },
    });
    expect(runnerMocks.sessions[0]?.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(runnerMocks.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(runnerMocks.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves the ordinary retry after a rate limit failure", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push(
      { kind: "error", error: new Error("429 rate limit exceeded") },
      { kind: "error", error: new Error("provider disconnected") },
      { kind: "report", report: findingsReport },
    );

    const outcomePromise = runSpecialist(specialistArgs());
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("report");
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(3);
  });

  it("never creates more than three sessions", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push(
      { kind: "error", error: new Error("429 rate limit exceeded") },
      { kind: "error", error: new Error("429 rate limit exceeded") },
      { kind: "error", error: new Error("429 rate limit exceeded") },
      { kind: "report", report: findingsReport },
    );

    const outcomePromise = runSpecialist(specialistArgs());
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "rate_limit", attempts: 3 },
      },
    });
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(3);
    expect(runnerMocks.behaviors).toHaveLength(1);
  });

  it("aborts and disposes the active session when the external signal fires", async () => {
    runnerMocks.behaviors.push({ kind: "pending" });
    const controller = new AbortController();

    const outcomePromise = runSpecialist(specialistArgs({ signal: controller.signal }));
    await vi.waitFor(() => expect(runnerMocks.sessions[0]?.send).toHaveBeenCalledTimes(1));
    controller.abort();
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "cancelled", attempts: 1 },
      },
    });
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(1);
    expect(runnerMocks.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(runnerMocks.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("nudges once at three identical executes and stops that session at six", () => {
    const repeat = createSpecialistExecuteRepeat();
    const same = (result = "value") => ({
      toolName: "execute",
      code: "return coverage",
      result,
    });
    const feed = (
      calls: readonly { toolName: string; code: string; result: string }[],
      refused = false,
    ) => {
      const action = repeat.observe({ refused, calls });
      return { action, nudges: repeat.takeNudges() };
    };

    expect(feed([same(), same()]).nudges).toEqual([]);
    expect(feed([same()])).toEqual({
      action: "continue",
      nudges: [SPECIALIST_REPEATED_EXECUTE_NUDGE],
    });
    expect(feed([same()]).nudges).toEqual([]);
    expect(feed([same()]).nudges).toEqual([]);
    expect(feed([same()]).action).toBe("stop");

    const changed = createSpecialistExecuteRepeat();
    for (let index = 0; index < 7; index += 1) {
      const action = changed.observe({
        refused: false,
        calls: [{ toolName: "execute", code: "return coverage", result: `r${index}` }],
      });
      expect(action).toBe("continue");
      expect(changed.takeNudges()).toEqual([]);
    }

    const refused = createSpecialistExecuteRepeat();
    expect(
      refused.observe({
        refused: true,
        calls: [same(), same(), same(), same(), same(), same()],
      }),
    ).toBe("continue");
    expect(refused.takeNudges()).toEqual([]);

    const submit = createSpecialistExecuteRepeat();
    expect(
      submit.observe({
        refused: false,
        calls: Array.from({ length: 6 }, () => ({
          toolName: "submit_findings_report",
          code: "return coverage",
          result: "same",
        })),
      }),
    ).toBe("continue");
    expect(submit.takeNudges()).toEqual([]);
  });

  it("returns review.specialist_repeated_execute without another session", async () => {
    runnerMocks.behaviors.push({
      kind: "error",
      error: new AppError({
        domain: "review",
        kind: "specialist_repeated_execute",
        message: "Specialist repeated one execute result six times",
      }),
    });

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome).toMatchObject({
      kind: "error",
      error: { code: "review.specialist_repeated_execute" },
    });
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(1);
    expect(runnerMocks.sessions[0]?.send.mock.calls[0]?.[0]).not.toContain(
      SPECIALIST_REPEATED_EXECUTE_NUDGE,
    );
  });

  it("counts an execute only when its result is paired by call id", () => {
    expect(
      specialistExecuteCalls({
        calls: [
          { id: "e1", name: "execute", arguments: { code: "return 1" } },
          { id: "s1", name: "submit_findings_report", arguments: { status: "no_findings" } },
        ],
        results: [{ toolCallId: "e1", text: "1" }],
      }),
    ).toEqual([{ toolName: "execute", code: "return 1", result: "1" }]);
  });
});
