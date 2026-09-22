import { PROVIDER_MARKS } from "@/components/provider-logos";

/** Provider strip under the hero. Marks only: the keys and the bill stay with you. */
export function Providers() {
  return (
    <section id="providers" aria-labelledby="providers-heading" className="scroll-mt-25">
      <div className="container-x">
        <div className="flex flex-col gap-6 border-y border-line py-7 lg:flex-row lg:items-center lg:gap-12">
          <div className="max-w-sm shrink-0">
            <h2 id="providers-heading" className="text-sm font-medium text-text">
              Bring your own model keys
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
              Switch providers by changing one setting. Your GitHub workflow stays the same.
            </p>
          </div>
          <ul
            className="flex flex-wrap items-center gap-x-9 gap-y-4 text-text-tertiary lg:ml-auto"
            aria-label="Supported model providers"
          >
            {PROVIDER_MARKS.map((Mark) => (
              <li key={Mark.name} className="flex items-center">
                <Mark className="size-6" />
              </li>
            ))}
            <li className="text-[13px]">and more</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
