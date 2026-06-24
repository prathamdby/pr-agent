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
    <section id="examples" aria-labelledby="examples-heading" data-line>
      <div className="grid-layout">
        <div className="grid-layout-inner py-16 md:py-20">
          <h2 id="examples-heading" className="section-title mb-3 text-foreground-primary">
            AI pull request review examples on GitHub
          </h2>
          <p className="mb-10 text-center text-foreground-secondary max-w-lg mx-auto">
            Real output from each slash command, published directly to your pull requests.
          </p>

          <div className="columns-1 sm:columns-2 gap-4 [&>*]:mb-4">
            {screenshots.map((shot) => (
              <figure
                key={shot.caption}
                className="break-inside-avoid rounded-[10px] border border-border-line bg-background-secondary overflow-hidden transition-shadow duration-200"
                style={{
                  boxShadow: "var(--shadow-drop-md)",
                  transitionTimingFunction: "var(--ease-out-soft)",
                }}
              >
                <img
                  src={shot.src}
                  alt={shot.alt}
                  width={shot.width}
                  height={shot.height}
                  className="w-full h-auto"
                  loading="lazy"
                  decoding="async"
                />
                <figcaption className="px-4 py-3 border-t border-border-line">
                  <code className="text-sm font-mono text-brand-base">{shot.caption}</code>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
