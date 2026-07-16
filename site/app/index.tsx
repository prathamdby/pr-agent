import { createFileRoute } from "@tanstack/react-router";
import { Header } from "@/components/header";
import { Hero } from "@/components/hero";
import { Features } from "@/components/features";
import { Capabilities } from "@/components/capabilities";
import { Gallery } from "@/components/gallery";
import { Providers } from "@/components/providers";
import { Pricing } from "@/components/pricing";
import { Alternatives } from "@/components/alternatives";
import { Faq } from "@/components/faq";
import { Quickstart } from "@/components/quickstart";
import { Footer } from "@/components/footer";
import { JsonLd } from "@/components/json-ld";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <>
      <JsonLd />
      <main id="main-content" className="overflow-x-hidden">
        <Header />
        <Hero />
        <Features />
        <Capabilities />
        <Gallery />
        <Pricing />
        <Providers />
        <Alternatives />
        <Faq />
        <Quickstart />
        <Footer />
      </main>
    </>
  );
}
