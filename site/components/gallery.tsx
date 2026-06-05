import Image from "next/image";

const screenshots = [
  {
    src: "/screenshots/review.example.png",
    alt: "PR Agent automated AI code review on a GitHub pull request using /review",
    caption: "/review",
  },
  {
    src: "/screenshots/describe.example.png",
    alt: "PR Agent AI-generated pull request description using /describe",
    caption: "/describe",
  },
  {
    src: "/screenshots/ask.example.png",
    alt: "PR Agent answering a code question on a GitHub pull request with /ask",
    caption: "/ask",
  },
  {
    src: "/screenshots/review-security.example.png",
    alt: "PR Agent security code review summary on a GitHub pull request with /review-security",
    caption: "/review-security",
  },
  {
    src: "/screenshots/review-quality.example.png",
    alt: "PR Agent code quality review on a GitHub pull request with /review-quality",
    caption: "/review-quality",
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
                <Image
                  src={shot.src}
                  alt={shot.alt}
                  width={800}
                  height={450}
                  className="w-full h-auto"
                  loading="lazy"
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
