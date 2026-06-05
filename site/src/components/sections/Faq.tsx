import { Reveal } from "@/components/motion/Reveal";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FAQS } from "@/content";

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-[1180px] px-5 py-24 sm:py-28">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <Reveal>
          <h2 className="text-balance text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-[2.6rem]">
            Questions, answered plainly.
          </h2>
          <p className="mt-5 max-w-[40ch] text-pretty leading-relaxed text-fg-muted">
            Still wondering about something? The README and docs go deeper on every point below.
          </p>
        </Reveal>

        <Reveal delay={0.06}>
          <Accordion type="single" collapsible defaultValue="item-0" className="w-full">
            {FAQS.map((faq, i) => (
              <AccordionItem key={faq.q} value={`item-${i}`}>
                <AccordionTrigger>{faq.q}</AccordionTrigger>
                <AccordionContent>{faq.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  );
}
