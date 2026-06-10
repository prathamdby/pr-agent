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
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="examples-heading" className="text-xl mb-4">
          AI pull request review examples on GitHub
        </h2>

        <div className="space-y-6">
          {screenshots.map((shot) => (
            <figure key={shot.caption}>
              <div className="rounded-md border border-neutral-200 overflow-hidden">
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
              <figcaption className="mt-2 text-sm text-neutral-500">
                <code>{shot.caption}</code>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
