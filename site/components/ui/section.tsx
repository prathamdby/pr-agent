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
      className={`${toneClass} px-5 py-20 sm:px-8 md:py-28 ${className}`}
    >
      <div className="mx-auto w-full max-w-[1200px]">{children}</div>
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
      <h2 id={id} className="text-3xl font-semibold leading-[1.08] text-fg md:text-[2.75rem]">
        {children}
      </h2>
      {lede ? (
        <p className="mt-4 max-w-[60ch] text-base leading-relaxed text-fg-muted md:text-lg">
          {lede}
        </p>
      ) : null}
    </div>
  );
}
