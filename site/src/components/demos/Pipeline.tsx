import { type Icon, GithubLogo, Database, Cpu, GitPullRequest } from "@phosphor-icons/react";
import { Stagger, StaggerItem } from "@/components/motion/Reveal";

type Stage = {
  icon: Icon;
  title: string;
  body: string;
  tag: string;
};

const STAGES: Stage[] = [
  {
    icon: GithubLogo,
    title: "A webhook arrives",
    body: "A pull request opens, updates, or someone types a command. GitHub sends the event.",
    tag: "event",
  },
  {
    icon: Database,
    title: "Saved before a reply",
    body: "The job is written to your Postgres and queued, so a busy backlog can never drop it.",
    tag: "durable intake",
  },
  {
    icon: Cpu,
    title: "A worker reads the code",
    body: "It checks out the branch, inspects the diff with its tools, and runs the model you picked.",
    tag: "worker",
  },
  {
    icon: GitPullRequest,
    title: "Results land on the PR",
    body: "The summary, inline notes, or answer post straight to the pull request your team already uses.",
    tag: "publish",
  },
];

export function Pipeline() {
  return (
    <div className="relative">
      {/* Horizontal connector with a sweeping packet, desktop only. */}
      <div
        aria-hidden="true"
        className="absolute left-[12.5%] right-[12.5%] top-7 hidden h-px bg-line md:block"
      >
        <div className="pipe-flow-x absolute inset-0 motion-reduce:hidden" />
      </div>

      <Stagger
        className="grid grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-4 md:gap-y-0"
        gap={0.12}
      >
        {STAGES.map(({ icon: Glyph, title, body, tag }) => (
          <StaggerItem key={title}>
            <div className="relative flex gap-4 md:block">
              {/* Vertical connector for the stacked mobile layout. */}
              <div
                aria-hidden="true"
                className="absolute left-[27px] top-14 h-[calc(100%-1rem)] w-px bg-line last:hidden md:hidden"
              />
              <div className="relative z-10 flex size-14 shrink-0 items-center justify-center rounded-full border border-line-hi bg-bg-soft md:bg-bg">
                <Glyph size={24} weight="regular" className="text-accent" />
              </div>
              <div className="md:mt-6">
                <span className="mono-caption">{tag}</span>
                <h3 className="mt-1 text-lg font-medium tracking-tight text-fg">{title}</h3>
                <p className="mt-2 max-w-[34ch] text-sm leading-relaxed text-fg-muted">{body}</p>
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  );
}
