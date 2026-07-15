import { SCREENSHOTS } from "@/lib/content";

export function Gallery() {
  return (
    <section
      id="examples"
      aria-labelledby="examples-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="examples-heading" className="text-xl mb-4">
          Look at real GitHub output before you deploy
        </h2>

        <p className="text-sm text-neutral-500 mb-4">
          Screenshots of real reviews, descriptions, Q&A, security, and quality checks posted back
          to GitHub.
        </p>

        <div className="space-y-6">
          {SCREENSHOTS.map((shot) => (
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
              <figcaption className="mt-2 text-sm text-neutral-500">{shot.caption}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
