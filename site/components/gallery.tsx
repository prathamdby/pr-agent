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
      className="border-t border-gray-alpha-200 bg-background-100 px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2 id="examples-heading" className="text-heading-24 text-primary sm:text-heading-32">
          AI Pull Request Review Examples on GitHub
        </h2>
        <p className="mt-3 max-w-2xl text-copy-16 text-secondary">
          See PR Agent in action on real pull request workflows.
        </p>

        <div className="mt-10 columns-1 gap-4 sm:columns-2">
          {screenshots.map((shot) => (
            <figure key={shot.caption} className="mb-4 break-inside-avoid">
              <div className="overflow-hidden rounded-md border border-gray-alpha-200 bg-background-200 shadow-card">
                <img
                  src={shot.src}
                  alt={shot.alt}
                  width={shot.width}
                  height={shot.height}
                  className="h-auto w-full"
                  loading="lazy"
                  decoding="async"
                />
              </div>
              <figcaption className="mt-2 text-copy-13-mono text-secondary">
                {shot.caption}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
