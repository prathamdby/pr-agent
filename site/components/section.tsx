import type { ReactNode } from "react";

type SectionProps = {
  readonly id: string;
  readonly labelledBy: string;
  readonly className?: string;
  readonly children: ReactNode;
};

/** Page band with the shared horizontal container and room under the sticky header for anchors. */
export function Section({ id, labelledBy, className, children }: SectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={`scroll-mt-25 py-16 sm:py-20 lg:py-24 ${className ?? ""}`}
    >
      <div className="container-x">{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { readonly children: ReactNode }) {
  return (
    <p className="inline-flex items-center gap-2 text-[13px] font-medium text-text-secondary">
      <span aria-hidden="true" className="h-1.5 w-3.5 rounded-full bg-accent-solid" />
      {children}
    </p>
  );
}

type SectionHeadingProps = {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string;
  /** Rendered beside the copy on wide screens, under it on narrow ones. */
  readonly action?: ReactNode;
};

export function SectionHeading({ id, eyebrow, title, description, action }: SectionHeadingProps) {
  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-12">
      <div className="max-w-2xl">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2
          id={id}
          className="mt-4 text-[clamp(1.875rem,3.4vw,2.625rem)] font-medium leading-[1.12] tracking-[-0.025em] text-text"
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-text-secondary sm:text-[1.0625rem]">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
