import { createFileRoute } from "@tanstack/react-router";
import { Alternatives } from "@/components/alternatives";
import { Capabilities } from "@/components/capabilities";
import { CtaBanner } from "@/components/cta-banner";
import { Faq } from "@/components/faq";
import { Features } from "@/components/features";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { Hero } from "@/components/hero";
import { JsonLd } from "@/components/json-ld";
import { Pricing } from "@/components/pricing";
import { Providers } from "@/components/providers";
import { Quickstart } from "@/components/quickstart";
import { UseCases } from "@/components/use-cases";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <>
      <JsonLd />
      <Header />
      <main id="main-content">
        <Hero />
        <Providers />
        <Features />
        <UseCases />
        <Capabilities />
        <Pricing />
        <Alternatives />
        <Faq />
        <Quickstart />
        <CtaBanner />
      </main>
      <Footer />
    </>
  );
}
