import type { ReactNode } from "react";

type SectionProps = {
  readonly id: string;
  readonly labelledBy: string;
  readonly children: ReactNode;
  readonly tone?: "canvas" | "surface";
  readonly className?: string;
};

/** Page section with the shared container width and vertical rhythm. */
export function Section({
  id,
  labelledBy,
  children,
  tone = "canvas",
  className = "",
}: SectionProps) {
  const toneClass = tone === "surface" ? "border-y border-line bg-surface" : "";
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={`${toneClass} py-16 sm:py-20 md:py-28 xl:py-32 ${className}`}
    >
      <div className="page-wrap">{children}</div>
    </section>
  );
}

type HeadingProps = {
  readonly id: string;
  readonly children: ReactNode;
  readonly lede?: ReactNode;
};

/** Section headline with an optional stacked explainer. Never a split header. */
export function SectionHeading({ id, children, lede }: HeadingProps) {
  return (
    <div className="max-w-[40rem]">
      <h2 id={id} className="text-[length:var(--text-title)] font-semibold leading-[1.08] text-fg">
        {children}
      </h2>
      {lede ? (
        <p className="mt-4 max-w-[65ch] text-base leading-relaxed text-fg-muted md:text-lg">
          {lede}
        </p>
      ) : null}
    </div>
  );
}
