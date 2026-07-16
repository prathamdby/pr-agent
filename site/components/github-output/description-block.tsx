import { GhCode, GhDetails, OutputFrame } from "@/components/github-output/primitives";

/** Mirrors `renderDescriptionAgentBlock` under `## PR Agent Description`. */
export function DescriptionBlockMock() {
  return (
    <OutputFrame title="PR Agent Description" surface="merged into the pull request body">
      <section className="space-y-1">
        <h4 className="text-xs font-semibold text-ink">PR Type</h4>
        <p className="text-xs text-ink-mute">Enhancement, Documentation</p>
      </section>

      <section className="space-y-1">
        <h4 className="text-xs font-semibold text-ink">Description</h4>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-mute">
          <li>Route review concurrency knobs through the settings module.</li>
          <li>Keep worker env reads out of feature modules.</li>
        </ul>
      </section>

      <section className="space-y-1">
        <h4 className="text-xs font-semibold text-ink">Changes Diagram</h4>
        <pre className="surface-inset edge-self overflow-x-auto p-2 font-mono text-[11px] leading-relaxed text-ink-soft">
          <code>{`flowchart LR
  Webhook --> Intake --> Queue --> ReviewWorker`}</code>
        </pre>
      </section>

      <section className="space-y-1">
        <h4 className="text-xs font-semibold text-ink">File Walkthrough</h4>
        <GhDetails summary="Enhancement (2 files)">
          <p className="mb-1">
            <GhCode>src/settings/constants.ts</GhCode>
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Expose REVIEW_CONCURRENCY default</li>
          </ul>
        </GhDetails>
      </section>
    </OutputFrame>
  );
}
