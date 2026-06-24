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
    <section id="examples" aria-labelledby="examples-heading" className="section section-border">
      <div className="container-geist">
        <div className="mx-auto max-w-2xl text-center mb-10">
          <h2 id="examples-heading" className="heading-32 mb-3">
            Pull Request Review Examples
          </h2>
          <p className="copy-16 text-gray-900">
            See PR Agent in action on real GitHub pull requests.
          </p>
        </div>

        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6 sm:grid-cols-2">
          {screenshots.map((shot) => (
            <figure key={shot.caption} className="card card-compact p-4">
              <div className="overflow-hidden rounded-sm border border-gray-alpha-400 bg-gray-100">
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
              <figcaption className="mt-3 label-13 text-gray-700">
                <code>{shot.caption}</code>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
