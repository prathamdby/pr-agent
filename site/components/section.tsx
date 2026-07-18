import type { ReactNode } from "react";

type SectionProps = {
  readonly id: string;
  readonly labelledBy: string;
  readonly raised?: boolean;
  readonly children: ReactNode;
};

export function Section({ id, labelledBy, raised = false, children }: SectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={
        raised
          ? "bg-navy-raised px-4 py-16 sm:px-6 sm:py-20 md:py-24"
          : "px-4 py-16 sm:px-6 sm:py-20 md:py-24"
      }
    >
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}
