import { Reveal, Stagger, StaggerItem } from "@/components/motion/Reveal";

const PRINCIPLES = [
  {
    n: "01",
    head: "It reads the whole change",
    body: "Not just the diff. It checks out the branch and looks at the code around your edit before saying anything.",
  },
  {
    n: "02",
    head: "It only speaks when it helps",
    body: "Every finding carries a severity and a reason. No noise, no nitpicking a missing semicolon.",
  },
  {
    n: "03",
    head: "It stays on your side",
    body: "Your servers, your model, your data. Nothing leaves the box you run it on.",
  },
];

export function Why() {
  return (
    <section className="mx-auto max-w-[1180px] px-5 py-24 sm:py-32">
      <Reveal>
        <h2 className="max-w-[20ch] text-balance text-3xl font-semibold leading-[1.1] tracking-tight text-fg sm:text-[2.7rem]">
          Good reviews are the first thing to slip when a team is busy.
        </h2>
      </Reveal>
      <Reveal delay={0.06}>
        <p className="mt-6 max-w-[60ch] text-pretty text-lg leading-relaxed text-fg-muted">
          PR Agent does not replace your reviewers. It gives them a running start, so the obvious
          problems are already flagged and the subtle ones are easier to see.
        </p>
      </Reveal>

      <Stagger className="mt-16 flex flex-col">
        {PRINCIPLES.map((p) => (
          <StaggerItem key={p.n}>
            <div className="grid grid-cols-1 gap-3 border-t border-line py-8 sm:grid-cols-[6rem_1fr] sm:gap-10 sm:py-9 lg:grid-cols-[8rem_1fr]">
              <span className="font-mono text-2xl text-accent sm:text-3xl">{p.n}</span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.3fr] sm:gap-10">
                <h3 className="text-xl font-medium tracking-tight text-fg sm:text-2xl">
                  {p.head}
                </h3>
                <p className="max-w-[44ch] leading-relaxed text-fg-muted">{p.body}</p>
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
