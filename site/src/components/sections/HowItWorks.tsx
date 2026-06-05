import { Reveal } from "@/components/motion/Reveal";
import { STEPS } from "@/content";

export function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-[1180px] px-5 py-24 sm:py-28">
      <Reveal>
        <h2 className="max-w-[22ch] text-balance text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-[2.6rem]">
          Built to never drop a review, even under load.
        </h2>
        <p className="mt-5 max-w-[58ch] text-pretty text-lg leading-relaxed text-fg-muted">
          The work is split in two. A web service accepts events and a worker does the thinking, so
          a flood of pull requests slows nothing down and loses nothing.
        </p>
      </Reveal>

      <ol className="relative mt-16 grid grid-cols-1 gap-y-10 md:grid-cols-4 md:gap-x-8 md:gap-y-0">
        {/* Connecting rail behind the nodes on desktop. */}
        <span
          aria-hidden="true"
          className="absolute left-[15px] top-2 hidden h-px w-full bg-gradient-to-r from-border-hi via-border to-transparent md:block"
        />
        {STEPS.map((step, i) => (
          <Reveal key={step.title} delay={i * 0.08}>
            <li className="relative md:pr-6">
              <div className="flex items-center gap-3 md:block">
                <span className="relative z-10 flex size-8 items-center justify-center rounded-full border border-border-hi bg-bg-soft font-mono text-sm text-accent">
                  {i + 1}
                </span>
                <h3 className="text-lg font-medium tracking-tight text-fg md:mt-5">{step.title}</h3>
              </div>
              <p className="mt-3 max-w-[40ch] leading-relaxed text-fg-muted">{step.body}</p>
            </li>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}
