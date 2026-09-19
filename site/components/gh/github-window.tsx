import {
  CheckCircleIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  CaretDownIcon,
  LockIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AskComment,
  DescribeComment,
  ReviewComment,
  TriageComment,
} from "@/components/gh/comments";
import { GhCode, GhComment, HumanAvatar, ghLine } from "@/components/gh/primitives";

/*
  Interactive GitHub pull request inside a 16:9 browser window. The Conversation tab shows a
  PR Agent review. Typing or picking a slash command posts the human comment and PR Agent's
  reply, the way it would on a real pull request. Files changed and Checks are small static
  views so the tabs feel real. All names and content are invented.
*/

type Command = "/describe" | "/ask" | "/triage";

const COMMANDS: readonly { readonly command: Command; readonly prompt: string }[] = [
  { command: "/describe", prompt: "/describe" },
  { command: "/ask", prompt: "/ask why does the retry stop when the lease expires?" },
  { command: "/triage", prompt: "/triage" },
];

const REPLY: Record<Command, () => ReactNode> = {
  "/describe": () => <DescribeComment />,
  "/ask": () => <AskComment />,
  "/triage": () => <TriageComment />,
};

type Posted = { readonly id: number; readonly command: Command; readonly text: string };

type Tab = "Conversation" | "Commits" | "Checks" | "Files changed";
const TABS: readonly { readonly id: Tab; readonly short: string }[] = [
  { id: "Conversation", short: "Conversation" },
  { id: "Commits", short: "Commits" },
  { id: "Checks", short: "Checks" },
  { id: "Files changed", short: "Files" },
];

function detect(text: string): Command | null {
  const head = text.trim().split(/\s+/)[0]?.toLowerCase();
  return head === "/describe" || head === "/ask" || head === "/triage" ? head : null;
}

function FilesChanged() {
  const rows = [
    ["src/webhooks/retryDispatcher.ts", "+38", "-6"],
    ["src/agentWork/deferredDeliveries.ts", "+12", "-1"],
    ["test/webhooks/retryDispatcher.test.ts", "+64", "-0"],
  ] as const;
  return (
    <div className="rounded-[6px]" style={{ border: ghLine }}>
      {rows.map(([file, add, del], index) => (
        <div
          key={file}
          className="flex items-center justify-between gap-3 px-3 py-2"
          style={{ borderTop: index === 0 ? undefined : ghLine }}
        >
          <span className="truncate font-mono text-[12px]">{file}</span>
          <span className="tabular shrink-0 font-mono text-[12px]">
            <span style={{ color: "var(--gh-success)" }}>{add}</span>{" "}
            <span style={{ color: "#f85149" }}>{del}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Checks() {
  const rows = ["build", "unit tests", "PR Agent Review"] as const;
  return (
    <div className="rounded-[6px]" style={{ border: ghLine }}>
      {rows.map((name, index) => (
        <div
          key={name}
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: index === 0 ? undefined : ghLine }}
        >
          <CheckCircleIcon
            weight="fill"
            className="size-4"
            style={{ color: "var(--gh-success)" }}
          />
          <span className="font-medium">{name}</span>
          <span className="ml-auto text-[12px]" style={{ color: "var(--gh-muted)" }}>
            Successful in {index + 1}m
          </span>
        </div>
      ))}
    </div>
  );
}

function Commits() {
  const rows = [
    ["a41f0c2", "Add bounded retry to webhook dispatcher"],
    ["5be9d10", "Skip retry once the actor lease expires"],
    ["c91e7ad", "Record attempts on the delivery row"],
  ] as const;
  return (
    <div className="rounded-[6px]" style={{ border: ghLine }}>
      {rows.map(([sha, title], index) => (
        <div
          key={sha}
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: index === 0 ? undefined : ghLine }}
        >
          <GitCommitIcon className="size-4" style={{ color: "var(--gh-muted)" }} />
          <span className="truncate font-medium">{title}</span>
          <span className="ml-auto shrink-0">
            <GhCode>{sha}</GhCode>
          </span>
        </div>
      ))}
    </div>
  );
}

export function GithubWindow() {
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<Tab>("Conversation");
  const [posted, setPosted] = useState<Posted[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const [atEnd, setAtEnd] = useState(false);

  function onScroll() {
    const el = scrollRef.current;
    if (el) {
      setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
    }
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return undefined;
    }
    const measure = () => setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [tab, posted.length]);

  function scrollDown() {
    scrollRef.current?.scrollBy({ top: 320, behavior: reduce ? "auto" : "smooth" });
  }

  useEffect(() => {
    if (posted.length > 0) {
      endRef.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
    }
  }, [posted.length, reduce]);

  function post(text: string) {
    const command = detect(text);
    if (!command) {
      return;
    }
    nextId.current += 1;
    setPosted((list) => [...list, { id: nextId.current, command, text: text.trim() }]);
    setTab("Conversation");
  }

  return (
    <div
      className="flex h-[min(42rem,80dvh)] w-full min-w-0 flex-col overflow-hidden rounded-[12px] text-[13px] leading-[1.5] shadow-[0_0_0_1px_var(--gh-line),0_2px_4px_hsl(var(--shadow-color)/0.1),0_40px_80px_-32px_hsl(var(--shadow-color)/0.6)] lg:aspect-video lg:h-auto xl:min-h-[36rem]"
      style={{ background: "var(--gh-bg)", color: "var(--gh-fg)", fontFamily: "var(--font-sans)" }}
    >
      <div
        className="flex shrink-0 items-center gap-3 px-3.5 py-2"
        style={{ background: "var(--gh-chrome)", borderBottom: ghLine }}
      >
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="size-3 rounded-full" style={{ background: "#ff5f57" }} />
          <span className="size-3 rounded-full" style={{ background: "#febc2e" }} />
          <span className="size-3 rounded-full" style={{ background: "#28c840" }} />
        </span>
        <span
          className="tabular mx-auto flex h-7 w-full min-w-0 max-w-[26rem] items-center justify-center gap-1.5 rounded-[6px] px-2 text-[11px] sm:px-3 sm:text-[12px]"
          style={{ background: "var(--gh-bg)", border: ghLine, color: "var(--gh-muted)" }}
        >
          <LockIcon weight="fill" className="size-3 shrink-0" />
          <span className="truncate">github.com/acme/billing-service/pull/482</span>
        </span>
        <span className="hidden w-[3.25rem] sm:block" aria-hidden="true" />
      </div>

      <div className="shrink-0 px-3 pt-3 sm:px-5 sm:pt-4" style={{ borderBottom: ghLine }}>
        <p className="text-[12px]" style={{ color: "var(--gh-muted)" }}>
          acme / billing-service
        </p>
        <p className="mt-0.5 text-[16px] font-semibold leading-tight sm:text-[19px]">
          Retry webhook dispatch on transient GitHub failures
          <span className="tabular ps-2 font-normal" style={{ color: "var(--gh-muted)" }}>
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
            wants to merge 3 commits into <GhCode>main</GhCode> from{" "}
            <GhCode>fix/webhook-retry</GhCode>
          </span>
        </p>
        <div
          role="tablist"
          aria-label="Pull request views"
          className="mt-3 flex flex-wrap gap-1 text-[12px]"
        >
          {TABS.map((item) => {
            const selected = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(item.id)}
                className="relative min-h-10 rounded-t-[6px] px-2 pb-2 pt-1 transition-[color,background-color] duration-150 ease-out sm:px-2.5"
                style={{ color: selected ? "var(--gh-fg)" : "var(--gh-muted)" }}
              >
                <span className={selected ? "font-semibold" : undefined}>
                  <span className="sm:hidden">{item.short}</span>
                  <span className="hidden sm:inline">{item.id}</span>
                </span>
                {selected ? (
                  <motion.span
                    layoutId={reduce ? undefined : "gh-tab"}
                    className="absolute inset-x-0 -bottom-px h-0.5 rounded-full"
                    style={{ background: "#fd8c73" }}
                    transition={{ type: "spring", duration: 0.3, bounce: 0 }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-x-clip overflow-y-auto px-3 py-4 sm:px-5"
          style={{ background: "var(--gh-canvas)" }}
        >
          {tab === "Conversation" ? (
            <div className="space-y-4">
              <ReviewComment />
              <AnimatePresence initial={false}>
                {posted.map((item) => (
                  <motion.div
                    key={item.id}
                    className="space-y-4"
                    initial={reduce ? false : { opacity: 0, y: 12, filter: "blur(4px)" }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      filter: "blur(0px)",
                      transition: { duration: 0.3, ease: [0.23, 1, 0.32, 1] },
                    }}
                  >
                    <GhComment
                      author="mkoval"
                      when="just now"
                      avatar={<HumanAvatar seed="mkoval" />}
                    >
                      <p>{item.text}</p>
                    </GhComment>
                    {REPLY[item.command]()}
                  </motion.div>
                ))}
              </AnimatePresence>
              <div className="flex gap-3">
                <span className="hidden size-10 shrink-0 sm:block">
                  <HumanAvatar seed="mkoval" />
                </span>
                <div
                  className="min-w-0 flex-1 space-y-3 rounded-[6px] p-4"
                  style={{ border: ghLine, background: "var(--gh-bg)" }}
                >
                  <p className="font-semibold">Add a comment</p>
                  <p style={{ color: "var(--gh-muted)" }}>
                    Pick a command to see what PR Agent posts back.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {COMMANDS.map((item) => (
                      <button
                        key={item.command}
                        type="button"
                        onClick={() => post(item.prompt)}
                        className="press min-h-10 rounded-[6px] px-3 py-1.5 font-mono text-[12px] transition-[background-color,color] duration-150 ease-out hover:bg-[var(--gh-subtle)]"
                        style={{ border: ghLine, color: "var(--gh-fg)" }}
                      >
                        {item.command}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div ref={endRef} />
            </div>
          ) : tab === "Files changed" ? (
            <FilesChanged />
          ) : tab === "Checks" ? (
            <Checks />
          ) : (
            <Commits />
          )}
        </div>
        <button
          type="button"
          onClick={scrollDown}
          aria-label="Scroll the pull request"
          className="press absolute bottom-3 left-1/2 grid size-11 -translate-x-1/2 place-items-center rounded-full transition-[opacity,scale] duration-150 ease-out"
          style={{
            background: "var(--gh-bg)",
            color: "var(--gh-fg)",
            boxShadow: "0 0 0 1px var(--gh-line), 0 6px 16px -6px hsl(var(--shadow-color) / 0.5)",
            opacity: atEnd || tab !== "Conversation" ? 0 : 1,
            pointerEvents: atEnd || tab !== "Conversation" ? "none" : "auto",
          }}
        >
          <CaretDownIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
