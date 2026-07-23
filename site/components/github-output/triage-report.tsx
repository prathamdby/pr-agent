import type { ReactNode } from "react";
import { GhCode, OutputFrame } from "@/components/github-output/primitives";

/**
 * Mirrors `renderTriageReport` under `## PR Agent Triage`:
 * scope, evaluated head (`<code>`), verdict counts, optional pushed commits,
 * GFM findings table, optional policy suggestions for dismissed findings.
 */
type TriageRow = {
  readonly severity: string;
  readonly finding: string;
  readonly path: string;
  readonly line: number;
  readonly verdict: ReactNode;
  readonly threadUrl: string;
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
    threadUrl: "https://github.com/example/pr-agent/pull/1#discussion_r101",
  },
  {
    severity: "P2",
    finding: "Summary edit ignores stale head guard",
    path: "src/review/publish.ts",
    line: 91,
    verdict: "Already resolved",
    threadUrl: "https://github.com/example/pr-agent/pull/1#discussion_r102",
  },
  {
    severity: "P2",
    finding: "Docs-only path skips durable ack wait",
    path: "src/webhooks/intake.ts",
    line: 162,
    verdict: "Dismissed",
    threadUrl: "https://github.com/example/pr-agent/pull/1#discussion_r103",
  },
];

function GhGfmTable({ rows }: { readonly rows: readonly TriageRow[] }) {
  return (
    <table className="w-full border-collapse text-left text-[11px] leading-snug">
      <thead>
        <tr className="border-b border-edge text-ink-soft">
          <th scope="col" className="py-1 pr-2 font-semibold">
            Severity
          </th>
          <th scope="col" className="py-1 pr-2 font-semibold">
            Finding
          </th>
          <th scope="col" className="py-1 pr-2 font-semibold">
            Location
          </th>
          <th scope="col" className="py-1 pr-2 font-semibold">
            Verdict
          </th>
          <th scope="col" className="py-1 font-semibold">
            Thread
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={`${row.path}-${row.line}`}
            className="border-b border-edge/70 align-top last:border-b-0"
          >
            <td className="py-1.5 pr-2 font-semibold text-ink-soft">{row.severity}</td>
            <td className="py-1.5 pr-2 text-ink-mute">{row.finding}</td>
            <td className="whitespace-nowrap py-1.5 pr-2 text-ink-mute">
              <GhCode>{row.path}</GhCode> L{row.line}
            </td>
            <td className="whitespace-nowrap py-1.5 pr-2 text-ink-mute">{row.verdict}</td>
            <td className="py-1.5">
              <a
                href={row.threadUrl}
                className="text-sky underline decoration-sky/40 underline-offset-2"
              >
                thread
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TriageReportMock() {
  return (
    <OutputFrame title="PR Agent Triage" surface="PR conversation comment">
      <div className="space-y-2 text-xs leading-relaxed text-ink-mute">
        <p className="text-ink-soft">
          Full PR triage.
          <br />
          Evaluated head: <GhCode>c4f8a91b2e3d4a5b6c7d8e9f0a1b2c3d4e5f6a7b</GhCode>
        </p>
        <p className="text-ink-soft">
          1 Fixed · 1 Already resolved · 0 Skipped · 1 Dismissed · 0 Previously resolved
        </p>
        <div>
          <p className="mb-1 text-ink-soft">Pushed commits:</p>
          <ul className="space-y-0.5">
            <li>
              <GhCode>a1b2c3d</GhCode> Fix webhook ack race (1 files, +12 -3)
            </li>
          </ul>
        </div>
        <div className="overflow-x-auto">
          <GhGfmTable rows={ROWS} />
        </div>
        <section className="space-y-1">
          <h4 className="text-xs font-semibold text-ink">Policy suggestions for dismissed findings</h4>
          <p className="text-ink-soft">
            Commit these to <GhCode>.pr-agent/*.mdc</GhCode> to steer future reviews:
          </p>
          <p>
            Create <GhCode>.pr-agent/src-webhooks-intake.mdc</GhCode> with:
          </p>
          <pre className="surface-inset edge-self overflow-x-auto p-2 font-mono text-[11px] leading-relaxed text-ink-soft">
            <code>{`---
globs:
  - "src/webhooks/intake.ts"
alwaysApply: false
---

Intentional: docs-only PRs skip the durable ack wait by design.`}</code>
          </pre>
        </section>
      </div>
    </OutputFrame>
  );
}
