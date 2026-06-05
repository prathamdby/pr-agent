import { type Icon, Key, Cpu, Database, ShieldCheck } from "@phosphor-icons/react";
import { Reveal, Stagger, StaggerItem } from "@/components/motion/Reveal";
import { DeploySequence } from "@/components/demos/DeploySequence";

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
    body: "Replies redact secret-shaped text before posting, and probes for internals get a polite refusal.",
  },
];

export function SelfHosted() {
  return (
    <section id="self-hosted" className="border-t border-line">
      <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-12 px-5 py-24 sm:py-32 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
        <div>
          <Reveal>
            <h2 className="max-w-[18ch] text-balance text-3xl font-semibold leading-[1.1] tracking-tight text-fg sm:text-[2.7rem]">
              The whole thing runs on your side of the fence.
            </h2>
          </Reveal>
          <Stagger className="mt-10 grid grid-cols-1 gap-x-8 gap-y-7 sm:grid-cols-2" gap={0.06}>
            {GUARANTEES.map(({ icon: Glyph, head, body }) => (
              <StaggerItem key={head}>
                <div className="flex gap-4">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-line-hi bg-surface text-accent">
                    <Glyph size={19} weight="regular" />
                  </span>
                  <div>
                    <h3 className="font-medium text-fg">{head}</h3>
                    <p className="mt-1 max-w-[40ch] text-sm leading-relaxed text-fg-muted">
                      {body}
                    </p>
                  </div>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>

        <Reveal delay={0.1} className="lg:pt-2">
          <DeploySequence />
          <p className="mt-4 px-1 text-sm leading-relaxed text-fg-dim">
            One command brings up Postgres, the web service, and the worker together. A health check
            tells your orchestrator when it is ready.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
