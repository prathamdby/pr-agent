import { type Icon, ListChecks, ChatCircleText, Article, ShieldCheck, Diamond } from "@phosphor-icons/react";
import { Reveal, Stagger, StaggerItem } from "@/components/motion/Reveal";
import { Spotlight } from "@/components/motion/Spotlight";
import { AskDemo } from "@/components/demos/AskDemo";
import { SEVERITIES } from "@/content";

const TONE: Record<string, string> = {
  danger: "bg-danger/15 text-danger",
  warn: "bg-warn/15 text-warn",
  muted: "bg-surface-hi text-fg-dim",
};

function CellShell({
  icon: Glyph,
  command,
  title,
  body,
  children,
  className,
}: {
  icon: Icon;
  command: string;
  title: string;
  body: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Spotlight
      as="article"
      className={`flex h-full flex-col rounded-[var(--radius)] border border-line bg-surface/50 p-6 transition-colors duration-300 hover:border-line-hi lg:p-7 ${className ?? ""}`}
    >
      <div className="relative flex items-center justify-between">
        <span className="flex size-11 items-center justify-center rounded-xl border border-line-hi bg-bg-soft text-accent">
          <Glyph size={22} weight="regular" />
        </span>
        <code className="rounded-full border border-line-hi bg-bg-soft px-3 py-1 font-mono text-xs text-fg-dim">
          {command}
        </code>
      </div>
      <h3 className="relative mt-6 text-xl font-medium tracking-tight text-fg">{title}</h3>
      <p className="relative mt-3 text-[0.95rem] leading-relaxed text-fg-muted">{body}</p>
      {children}
    </Spotlight>
  );
}

export function Capabilities() {
  return (
    <section id="capabilities" className="border-t border-line">
      <div className="mx-auto max-w-[1180px] px-5 py-24 sm:py-32">
        <Reveal>
          <h2 className="max-w-[18ch] text-balance text-3xl font-semibold leading-[1.1] tracking-tight text-fg sm:text-[2.7rem]">
            Five jobs, all done on the pull request.
          </h2>
          <p className="mt-5 max-w-[56ch] text-pretty text-lg leading-relaxed text-fg-muted">
            Reviews and descriptions run the moment a change lands. The rest are a short comment
            away when you want them.
          </p>
        </Reveal>

        <Stagger className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-6" gap={0.07}>
          <StaggerItem className="md:col-span-3">
            <CellShell
              icon={ListChecks}
              command="/review"
              title="Reviews that explain themselves"
              body="Each change gets a summary, with the issues that matter pinned inline and ranked so the riskiest lines are the ones you see first."
            >
              <ul className="relative mt-6 space-y-2.5 border-t border-line pt-5">
                {SEVERITIES.map((s) => (
                  <li key={s.tag} className="flex items-center gap-3 text-sm">
                    <span
                      className={`rounded-md px-1.5 py-0.5 font-mono text-[0.68rem] font-semibold ${TONE[s.tone]}`}
                    >
                      {s.tag}
                    </span>
                    <span className="font-medium text-fg">{s.label}</span>
                    <span className="mono-caption ml-auto hidden text-right sm:inline">
                      {s.note}
                    </span>
                  </li>
                ))}
              </ul>
            </CellShell>
          </StaggerItem>

          <StaggerItem className="md:col-span-3">
            <CellShell
              icon={ChatCircleText}
              command="/ask"
              title="Answers on the exact line"
              body="Reply with a question on the conversation or on a single line of the diff. It reads the code at that point and answers in plain language."
            >
              <div className="relative mt-5 border-t border-line pt-5">
                <AskDemo />
              </div>
            </CellShell>
          </StaggerItem>

          <StaggerItem className="md:col-span-2">
            <CellShell
              icon={Article}
              command="/describe"
              title="Descriptions written for you"
              body="A clear summary, a short file walkthrough, and an optional diagram, merged into the PR body without touching your own words."
            />
          </StaggerItem>

          <StaggerItem className="md:col-span-2">
            <CellShell
              icon={ShieldCheck}
              command="/review-security"
              title="A security pass on demand"
              body="Ask for a focused security read when a change deserves one. It posts its own summary and stays quiet until you call it."
            />
          </StaggerItem>

          <StaggerItem className="md:col-span-2">
            <CellShell
              icon={Diamond}
              command="/review-quality"
              title="A quality pass on demand"
              body="A closer look at structure and maintainability, reviewed through a different lens and kept in its own separate notes."
            />
          </StaggerItem>
        </Stagger>
      </div>
    </section>
  );
}
