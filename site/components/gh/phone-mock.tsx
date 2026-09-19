import { CheckCircleIcon, GitPullRequestIcon, LockIcon } from "@phosphor-icons/react";
import { BotAvatar, GhCode, GhLabel, GhNote, ghLine } from "@/components/gh/primitives";

/*
  Phone-only snapshot of a review comment. The interactive GitHub window starts at the tablet
  breakpoint; this card is static so a 390px viewport never has to scroll a 16:9 desktop mock.
*/

export function GithubPhoneMock() {
  return (
    <figure className="min-w-0 md:hidden">
      <div
        className="overflow-hidden rounded-panel text-[13px] leading-[1.5] shadow-[0_0_0_1px_var(--gh-line),0_2px_4px_hsl(var(--shadow-color)/0.1),0_24px_48px_-24px_hsl(var(--shadow-color)/0.55)]"
        style={{
          background: "var(--gh-bg)",
          color: "var(--gh-fg)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div
          className="flex items-center gap-3 px-3 py-2"
          style={{ background: "var(--gh-chrome)", borderBottom: ghLine }}
          aria-hidden="true"
        >
          <span className="flex gap-1.5 pointer-events-none">
            <span className="size-2.5 rounded-full" style={{ background: "#ff5f57" }} />
            <span className="size-2.5 rounded-full" style={{ background: "#febc2e" }} />
            <span className="size-2.5 rounded-full" style={{ background: "#28c840" }} />
          </span>
          <span
            className="mx-auto flex h-7 min-w-0 max-w-full items-center justify-center gap-1.5 rounded-[6px] px-2 text-[11px]"
            style={{ background: "var(--gh-bg)", border: ghLine, color: "var(--gh-muted)" }}
          >
            <LockIcon weight="fill" className="size-3 shrink-0" />
            <span className="truncate">github.com/acme/billing-service/pull/482</span>
          </span>
        </div>

        <div className="space-y-3 p-3" style={{ background: "var(--gh-canvas)" }}>
          <div>
            <p className="text-[15px] font-semibold leading-snug">
              Retry webhook dispatch on transient GitHub failures
              <span className="tabular ps-1.5 font-normal" style={{ color: "var(--gh-muted)" }}>
                #482
              </span>
            </p>
            <p
              className="mt-2 flex flex-wrap items-center gap-2 text-[12px]"
              style={{ color: "var(--gh-muted)" }}
            >
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-white"
                style={{ background: "#1f883d" }}
              >
                <GitPullRequestIcon className="size-3.5" />
                Open
              </span>
              <span>
                <span className="font-semibold" style={{ color: "var(--gh-fg)" }}>
                  mkoval
                </span>{" "}
                wants to merge 3 commits
              </span>
            </p>
          </div>

          <div
            className="overflow-hidden rounded-[4px]"
            style={{ background: "var(--gh-bg)", border: ghLine }}
          >
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"
              style={{ background: "var(--gh-subtle)", borderBottom: ghLine }}
            >
              <BotAvatar />
              <span className="font-semibold">pr-agent</span>
              <GhLabel>Bot</GhLabel>
            </div>
            <div className="space-y-3 px-3 py-3">
              <p className="text-[16px] font-semibold leading-tight">PR Agent Review</p>
              <GhNote>1 finding blocks merge. CI is green.</GhNote>
              <div className="rounded-[6px] p-3" style={{ border: ghLine }}>
                <p className="text-[12px] font-semibold" style={{ color: "var(--gh-muted)" }}>
                  P1 · c4
                </p>
                <p className="mt-1 font-semibold" style={{ color: "var(--gh-link)" }}>
                  Retry loop re-enqueues a delivery after its lease has already expired
                </p>
                <p className="mt-1 italic" style={{ color: "var(--gh-muted)" }}>
                  <GhCode>src/webhooks/retryDispatcher.ts</GhCode>
                </p>
              </div>
              <p className="flex items-center gap-1.5">
                <CheckCircleIcon
                  weight="fill"
                  className="size-4"
                  style={{ color: "var(--gh-success)" }}
                />
                <span>3 of 3 checks passed</span>
              </p>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Static preview of a PR Agent review comment on a GitHub pull request.
      </figcaption>
    </figure>
  );
}
