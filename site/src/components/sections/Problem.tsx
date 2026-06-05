import { Reveal } from "@/components/motion/Reveal";

const SLIPS = [
  {
    head: "The first review is the slow one",
    body: "A pull request can sit for hours waiting on a teammate before anyone reads a single line.",
  },
  {
    head: "Context gets lost",
    body: "Large changes arrive with a one line title, and reviewers spend their time figuring out what happened instead of whether it is correct.",
  },
  {
    head: "Tools you cannot host are a hard no",
    body: "Plenty of teams are not allowed to send their source code to a service they do not run themselves.",
  },
];

export function Problem() {
  return (
    <section className="mx-auto max-w-[1180px] px-5 py-24 sm:py-28">
      <Reveal>
        <h2 className="mx-auto max-w-[18ch] text-balance text-center text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-[2.6rem]">
          Good reviews are the first thing to slip when a team gets busy.
        </h2>
      </Reveal>
      <Reveal delay={0.06}>
        <p className="mx-auto mt-6 max-w-[58ch] text-pretty text-center text-lg leading-relaxed text-fg-muted">
          PR Agent does not replace your reviewers. It gives them a head start, so the easy issues
          are already caught and the hard ones are easier to find.
        </p>
      </Reveal>

      <div className="mx-auto mt-16 max-w-3xl divide-y divide-border border-t border-border">
        {SLIPS.map((item, i) => (
          <Reveal key={item.head} delay={i * 0.06}>
            <div className="grid grid-cols-1 gap-2 py-7 sm:grid-cols-[1fr_1.4fr] sm:gap-10">
              <h3 className="text-lg font-medium text-fg">{item.head}</h3>
              <p className="leading-relaxed text-fg-muted">{item.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
