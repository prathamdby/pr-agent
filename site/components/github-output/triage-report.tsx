import type { ReactNode } from "react";
import { GhCode, GhComment, GhLabel, GhPre, GhTitle } from "@/components/github-output/primitives";

/**
 * Mirrors `renderTriageReport` under `## PR Agent Triage`: scope, evaluated head, verdict counts,
 * pushed commits, the findings table, and policy suggestions for dismissed findings.
 */
type TriageRow = {
  readonly severity: string;
  readonly finding: string;
  readonly path: string;
  readonly line: number;
  readonly verdict: ReactNode;
};

const ROWS: readonly TriageRow[] = [
  {
    severity: "P1",
    finding: "Webhook ack can race the durable write",
    path: "src/webhooks/intake.ts",
    line: 148,
    verdict: (
      <>
        Fixed <GhCode>a1b2c3d</GhCode>
      </>
    ),
  },
  {
    severity: "P2",
    finding: "Summary edit ignores stale head guard",
    path: "src/review/publish.ts",
    line: 91,
    verdict: "Already resolved",
  },
  {
    severity: "P2",
    finding: "Docs-only path skips durable ack wait",
    path: "src/webhooks/intake.ts",
    line: 162,
    verdict: "Dismissed",
  },
];

function GhGfmTable({ rows }: { readonly rows: readonly TriageRow[] }) {
  return (
    <table className="w-full border-collapse text-left text-[11px] leading-snug">
      <thead>
        <tr className="border-b border-line text-text">
          <th scope="col" className="py-1.5 pr-2 font-semibold">
            Severity
          </th>
          <th scope="col" className="py-1.5 pr-2 font-semibold">
            Finding
          </th>
          <th scope="col" className="py-1.5 pr-2 font-semibold">
            Location
          </th>
          <th scope="col" className="py-1.5 pr-2 font-semibold">
            Verdict
          </th>
          <th scope="col" className="py-1.5 font-semibold">
            Thread
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={`${row.path}-${row.line}`}
            className="border-b border-line align-top last:border-b-0"
          >
            <td className="py-1.5 pr-2 font-semibold text-text">{row.severity}</td>
            <td className="py-1.5 pr-2 text-text-secondary">{row.finding}</td>
            <td className="py-1.5 pr-2 whitespace-nowrap text-text-secondary">
              <GhCode>{row.path}</GhCode> L{row.line}
            </td>
            <td className="py-1.5 pr-2 whitespace-nowrap text-text-secondary">{row.verdict}</td>
            {/* Styled as GitHub's link, but inert: a mock has no real thread to open. */}
            <td className="py-1.5">
              <span className="text-accent-text underline decoration-line">thread</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TriageReportMock() {
  return (
    <GhComment surface="Pull request conversation" frame="window">
      <GhTitle>PR Agent Triage</GhTitle>
      <div className="space-y-2.5 text-text-secondary">
        <p>
          Full PR triage.
          <br />
          Evaluated head: <GhCode>c4f8a91b2e3d4a5b6c7d8e9f0a1b2c3d4e5f6a7b</GhCode>
        </p>
        <p className="text-text">
          1 Fixed · 1 Already resolved · 0 Skipped · 1 Dismissed · 0 Previously resolved
        </p>
        <div>
          <p className="mb-1 text-text">Pushed commits:</p>
          <ul className="space-y-0.5">
            <li>
              <GhCode>a1b2c3d</GhCode> Fix webhook ack race (1 file, +12 −3)
            </li>
          </ul>
        </div>
        <div className="overflow-x-auto">
          <GhGfmTable rows={ROWS} />
        </div>
        <section className="space-y-1.5">
          <GhLabel>Policy suggestions for dismissed findings</GhLabel>
          <p>
            Commit these to <GhCode>.pr-agent/*.mdc</GhCode> to steer future reviews:
          </p>
          <p>
            Create <GhCode>.pr-agent/src-webhooks-intake.mdc</GhCode> with:
          </p>
          <GhPre>{`---
globs:
  - "src/webhooks/intake.ts"
alwaysApply: false
---

Intentional: docs-only PRs skip the durable ack wait by design.`}</GhPre>
        </section>
      </div>
    </GhComment>
  );
}
