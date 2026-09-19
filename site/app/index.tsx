import { createFileRoute } from "@tanstack/react-router";
import { Alternatives } from "@/components/alternatives";
import { Capabilities } from "@/components/capabilities";
import { Examples } from "@/components/examples";
import { Faq } from "@/components/faq";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { Hero } from "@/components/hero";
import { HowItWorks } from "@/components/how-it-works";
import { Install } from "@/components/install";
import { JsonLd } from "@/components/json-ld";
import { Pricing } from "@/components/pricing";
import { Providers } from "@/components/providers";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <>
      <JsonLd />
      <Header />
      <main id="main-content" className="min-w-0 overflow-x-clip">
        <Hero />
        <HowItWorks />
        <Capabilities />
        <Examples />
        <Pricing />
        <Providers />
        <Alternatives />
        <Faq />
        <Install />
      </main>
      <Footer />
    </>
  );
}
