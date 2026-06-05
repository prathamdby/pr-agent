import { type Icon, Key, Cpu, Database, ShieldCheck } from "@phosphor-icons/react";
import { Reveal, Stagger, StaggerItem } from "@/components/motion/Reveal";

const GUARANTEES: { icon: Icon; head: string; body: string }[] = [
  {
    icon: Key,
    head: "Your servers, your keys",
    body: "It runs on your own infrastructure with your own GitHub App credentials. Nothing phones home.",
  },
  {
    icon: Cpu,
    head: "Your model, your choice",
    body: "Code reaches only the provider you configure, and only while a worker is reviewing a change.",
  },
  {
    icon: Database,
    head: "Your data stays put",
    body: "Webhook payloads and workflow state live in your Postgres database, not someone else's.",
  },
  {
    icon: ShieldCheck,
    head: "Careful with answers",
    body: "Replies redact secret-shaped text before posting, and questions that fish for internals get a polite refusal.",
  },
];

const TERMINAL_LINES = [
  { text: "cp .env.example .env", accent: false },
  { text: "docker compose build", accent: false },
  { text: "docker compose up", accent: true },
];

export function SelfHosted() {
  return (
    <section id="self-hosted" className="border-y border-border bg-bg-soft/40">
      <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-12 px-5 py-24 sm:py-28 lg:grid-cols-2 lg:gap-16">
        <div>
          <Reveal>
            <h2 className="max-w-[18ch] text-balance text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-[2.6rem]">
              The whole thing runs on your side of the fence.
            </h2>
          </Reveal>
          <Stagger className="mt-10 space-y-7" gap={0.06}>
            {GUARANTEES.map(({ icon: Glyph, head, body }) => (
              <StaggerItem key={head}>
                <div className="flex gap-4">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border-hi bg-surface text-accent">
                    <Glyph size={19} weight="regular" />
                  </span>
                  <div>
                    <h3 className="font-medium text-fg">{head}</h3>
                    <p className="mt-1 max-w-[46ch] leading-relaxed text-fg-muted">{body}</p>
                  </div>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>

        <Reveal delay={0.1} className="lg:pt-4">
          <div className="overflow-hidden rounded-[var(--radius)] border border-border-hi bg-bg shadow-[var(--shadow-soft)]">
            <div className="flex items-center gap-2 border-b border-border bg-surface/80 px-4 py-3">
              <span className="size-3 rounded-full bg-border-hi" />
              <span className="size-3 rounded-full bg-border-hi" />
              <span className="size-3 rounded-full bg-border-hi" />
              <span className="ml-3 font-mono text-xs text-fg-dim">your-server: ~/pr-agent</span>
            </div>
            <div className="space-y-3 p-6 font-mono text-sm leading-relaxed">
              {TERMINAL_LINES.map((line) => (
                <div key={line.text} className="flex gap-3">
                  <span className="select-none text-fg-dim">$</span>
                  <span className={line.accent ? "text-accent" : "text-fg"}>{line.text}</span>
                </div>
              ))}
              <div className="flex gap-3 pt-2 text-fg-dim">
                <span className="select-none">#</span>
                <span>web, worker, and postgres come up together</span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
