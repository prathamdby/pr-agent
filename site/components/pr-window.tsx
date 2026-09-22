import { ReviewSummaryMock } from "@/components/github-output/review-summary";
import { GhCode, GhPill } from "@/components/github-output/primitives";
import { CheckCircle, XCircle } from "@/components/icons";

const TABS = [
  { label: "Conversation", count: null, active: true },
  { label: "Commits", count: 3, active: false },
  { label: "Checks", count: 2, active: false },
  { label: "Files changed", count: 6, active: false },
] as const;

/**
 * A pull request page on GitHub with the review already posted. Decorative: it sits behind the
 * hero copy, cropped by the wash card, so the real output examples live in the use-cases section.
 */
export function PrWindow() {
  return (
    <div
      className="window w-full overflow-hidden text-xs leading-relaxed text-text"
      aria-hidden="true"
    >
      <div className="flex items-center gap-3 border-b border-line bg-surface-raised px-3 py-2">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-line" />
          <span className="size-2.5 rounded-full bg-line" />
          <span className="size-2.5 rounded-full bg-line" />
        </span>
        <span className="tabular flex-1 truncate rounded-xs bg-surface px-2.5 py-1 text-center text-[11px] text-text-tertiary shadow-ring">
          github.com/acme/api/pull/284
        </span>
      </div>

      <div className="px-4 pt-3.5">
        <p className="text-[15px] leading-snug font-semibold tracking-[-0.01em]">
          Route env knobs through settings{" "}
          <span className="tabular font-normal text-text-tertiary">#284</span>
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-text-secondary">
          <GhPill tone="success">Open</GhPill>
          <span>
            pratham wants to merge 3 commits into <GhCode>main</GhCode> from{" "}
            <GhCode>pd/settings-knobs</GhCode>
          </span>
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-5 border-b border-line text-text-secondary">
          {TABS.map((tab) => (
            <li
              key={tab.label}
              className={
                tab.active
                  ? "-mb-px flex items-center gap-1.5 border-b-2 border-accent-solid pb-2 font-medium text-text"
                  : "flex items-center gap-1.5 pb-2"
              }
            >
              {tab.label}
              {tab.count === null ? null : (
                <span className="tabular rounded-full bg-surface-raised px-1.5 text-[10px] text-text-secondary shadow-ring">
                  {tab.count}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3 px-4 py-4">
        <ReviewSummaryMock compact />

        <div className="overflow-hidden rounded-sm shadow-ring">
          <div className="flex items-center gap-2 border-b border-line bg-surface-raised px-3 py-2">
            <XCircle className="size-4 shrink-0 text-danger" />
            <p className="font-medium text-text">Some checks were not successful</p>
            <span className="ml-auto text-text-tertiary">1 failing, 1 successful</span>
          </div>
          <ul className="divide-y divide-line">
            <li className="flex items-center gap-2 px-3 py-2">
              <XCircle className="size-3.5 shrink-0 text-danger" />
              <span className="font-medium">PR Agent Review</span>
              <span className="truncate text-text-tertiary">Failing after 2m. One P1 finding.</span>
              <span className="ml-auto shrink-0 text-accent-text">Details</span>
            </li>
            <li className="flex items-center gap-2 px-3 py-2">
              <CheckCircle className="size-3.5 shrink-0 text-success" />
              <span className="font-medium">ci / test</span>
              <span className="truncate text-text-tertiary">Successful in 4m</span>
              <span className="ml-auto shrink-0 text-accent-text">Details</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
