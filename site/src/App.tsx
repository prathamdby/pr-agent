import { Nav } from "@/components/sections/Nav";
import { Hero } from "@/components/sections/Hero";
import { Integrations } from "@/components/sections/Integrations";
import { Why } from "@/components/sections/Why";
import { Capabilities } from "@/components/sections/Capabilities";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { SelfHosted } from "@/components/sections/SelfHosted";
import { SocialProof } from "@/components/sections/SocialProof";
import { Faq } from "@/components/sections/Faq";
import { CtaFooter } from "@/components/sections/CtaFooter";

export function App() {
  return (
    <div className="min-h-[100dvh] bg-bg">
      <Nav />
      <main>
        <Hero />
        <Integrations />
        <Why />
        <Capabilities />
        <HowItWorks />
        <SelfHosted />
        <SocialProof />
        <Faq />
        <CtaFooter />
      </main>
    </div>
  );
}
