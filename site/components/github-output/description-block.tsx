import {
  GhCode,
  GhComment,
  GhDetails,
  GhLabel,
  GhPre,
  GhTitle,
} from "@/components/github-output/primitives";

/** Mirrors `renderDescriptionAgentBlock` under `## PR Agent Description`. */
export function DescriptionBlockMock() {
  return (
    <GhComment surface="Merged into the pull request body" frame="window">
      <GhTitle>PR Agent Description</GhTitle>

      <section className="space-y-1">
        <GhLabel>PR Type</GhLabel>
        <p className="text-text-secondary">Enhancement, Documentation</p>
      </section>

      <section className="space-y-1">
        <GhLabel>Description</GhLabel>
        <ul className="list-disc space-y-0.5 pl-4 text-text-secondary">
          <li>Route review concurrency knobs through the settings module.</li>
          <li>Keep worker env reads out of feature modules.</li>
        </ul>
      </section>

      <section className="space-y-1.5">
        <GhLabel>Changes Diagram</GhLabel>
        <GhPre>{`flowchart LR
  Webhook --> Intake --> Queue --> ReviewWorker`}</GhPre>
      </section>

      <section className="space-y-1.5">
        <GhLabel>File Walkthrough</GhLabel>
        <GhDetails summary="Enhancement (2 files)">
          <p className="mb-1">
            <GhCode>src/settings/constants.ts</GhCode>
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Expose REVIEW_CONCURRENCY default</li>
          </ul>
        </GhDetails>
        <GhDetails summary="Documentation (1 file)">
          <p className="mb-1">
            <GhCode>docs/configuration.md</GhCode>
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Document the new knob and its default</li>
          </ul>
        </GhDetails>
      </section>
    </GhComment>
  );
}
