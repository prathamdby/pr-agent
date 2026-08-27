import { createFileRoute } from "@tanstack/react-router";
import { Compare } from "@/components/compare";
import { Faq } from "@/components/faq";
import { Footer } from "@/components/footer";
import { Gallery } from "@/components/gallery";
import { Header } from "@/components/header";
import { JsonLd } from "@/components/json-ld";
import { Opening } from "@/components/opening";
import { Quickstart } from "@/components/quickstart";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <>
      <JsonLd />
      <Header />
      <main id="main-content" className="overflow-x-hidden">
        <Opening />
        <Gallery />
        <Compare />
        <Faq />
        <Quickstart />
      </main>
      <Footer />
    </>
  );
}
