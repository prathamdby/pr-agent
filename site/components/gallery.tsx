const screenshots = [
  {
    src: "/screenshots/review.example.webp",
    alt: "PR Agent automated AI code review on a GitHub pull request using /review",
    caption: "/review",
    width: 806,
    height: 480,
  },
  {
    src: "/screenshots/describe.example.webp",
    alt: "PR Agent AI-generated pull request description using /describe",
    caption: "/describe",
    width: 806,
    height: 643,
  },
  {
    src: "/screenshots/ask.example.webp",
    alt: "PR Agent answering a code question on a GitHub pull request with /ask",
    caption: "/ask",
    width: 806,
    height: 745,
  },
  {
    src: "/screenshots/review-security.example.webp",
    alt: "PR Agent security code review summary on a GitHub pull request with /review-security",
    caption: "/review-security",
    width: 806,
    height: 639,
  },
  {
    src: "/screenshots/review-quality.example.webp",
    alt: "PR Agent code quality review on a GitHub pull request with /review-quality",
    caption: "/review-quality",
    width: 536,
    height: 726,
  },
];

export function Gallery() {
  return (
    <section
      id="examples"
      aria-labelledby="examples-heading"
      className="border-t border-border-line"
      data-line
    >
      <div className="grid-layout py-16">
        <div className="col-span-4 md:col-span-12 lg:col-span-24">
          <h2 id="examples-heading" className="section-title mb-4">
            AI pull request review examples on GitHub
          </h2>
          <p className="text-center text-foreground-secondary text-lg mb-10 max-w-2xl mx-auto">
            See how PR Agent looks in action on real pull requests — from code reviews to
            security analysis and Q&amp;A.
          </p>
        </div>

        {screenshots.map((shot) => (
          <figure
            key={shot.caption}
            className="col-span-4 md:col-span-6 lg:col-span-8 mb-4"
          >
            <div className="rounded-xl border border-border-secondary overflow-hidden bg-background-secondary shadow-drop-sm">
              <img
                src={shot.src}
                alt={shot.alt}
                width={shot.width}
                height={shot.height}
                className="w-full h-auto"
                loading="lazy"
                decoding="async"
              />
            </div>
            <figcaption className="mt-2 text-xs text-foreground-muted text-center">
              <code className="font-mono text-foreground-tertiary">{shot.caption}</code>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
