import { SCREENSHOTS } from "@/lib/content";

export function Gallery() {
  return (
    <section
      id="examples"
      aria-labelledby="examples-heading"
      className="px-4 py-20 sm:px-6 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h2
            id="examples-heading"
            className="max-w-[18ch] font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
          >
            Real GitHub output before you deploy
          </h2>
          <p className="max-w-sm text-sm leading-relaxed text-ink-mute sm:text-right">
            Reviews, descriptions, Q&A, security, and quality checks posted back to the pull request.
          </p>
        </div>

        <div className="mt-14 space-y-16">
          {SCREENSHOTS.map((shot, index) => (
            <figure
              key={shot.caption}
              className={`mx-auto max-w-4xl ${index % 2 === 1 ? "sm:ml-auto sm:mr-0" : "sm:ml-0 sm:mr-auto"}`}
            >
              <div className="relative overflow-hidden">
                <img
                  src={shot.src}
                  alt={shot.alt}
                  width={shot.width}
                  height={shot.height}
                  className="w-full h-auto"
                  loading="lazy"
                  decoding="async"
                  style={{
                    maskImage:
                      "linear-gradient(to bottom, transparent 0%, #000 8%, #000 88%, transparent 100%), linear-gradient(to right, transparent 0%, #000 4%, #000 96%, transparent 100%)",
                    WebkitMaskImage:
                      "linear-gradient(to bottom, transparent 0%, #000 8%, #000 88%, transparent 100%), linear-gradient(to right, transparent 0%, #000 4%, #000 96%, transparent 100%)",
                    maskComposite: "intersect",
                    WebkitMaskComposite: "source-in",
                  }}
                />
              </div>
              <figcaption className="mt-4 font-mono text-sm text-moss">{shot.caption}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
