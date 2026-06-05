import { Reveal } from "@/components/motion/Reveal";
import { Pipeline } from "@/components/demos/Pipeline";

export function HowItWorks() {
  return (
    <section id="how" className="border-t border-line bg-bg-soft/40">
      <div className="mx-auto max-w-[1180px] px-5 py-24 sm:py-32">
        <Reveal>
          <h2 className="max-w-[22ch] text-balance text-3xl font-semibold leading-[1.1] tracking-tight text-fg sm:text-[2.7rem]">
            Built to never drop a review, even under load.
          </h2>
          <p className="mt-5 max-w-[58ch] text-pretty text-lg leading-relaxed text-fg-muted">
            The work splits in two. A web service accepts events and a worker does the thinking, so
            a flood of pull requests loses nothing and slows nothing down.
          </p>
        </Reveal>

        <div className="mt-16">
          <Pipeline />
        </div>
      </div>
    </section>
  );
}
