import { BrandLogo } from "@/components/BrandLogo";
import { Reveal } from "@/components/motion/Reveal";
import { INTEGRATIONS } from "@/content";

export function Integrations() {
  return (
    <section className="border-y border-border bg-bg-soft/40">
      <div className="mx-auto max-w-[1180px] px-5 py-14">
        <Reveal>
          <p className="text-center text-sm text-fg-dim">
            Runs on infrastructure you already trust, with the model you already chose
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="mt-9 grid grid-cols-2 items-center gap-x-6 gap-y-9 sm:grid-cols-4 lg:grid-cols-8">
            {INTEGRATIONS.map((brand) => (
              <div key={brand.name} className="flex items-center justify-center">
                <BrandLogo
                  name={brand.name}
                  className="h-7 w-auto text-fg-dim transition-colors duration-300 hover:text-fg"
                />
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
