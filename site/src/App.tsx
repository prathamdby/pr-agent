import { Nav } from "@/components/sections/Nav";
import { Hero } from "@/components/sections/Hero";
import { Integrations } from "@/components/sections/Integrations";
import { Problem } from "@/components/sections/Problem";
import { Features } from "@/components/sections/Features";
import { Showcase } from "@/components/sections/Showcase";
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
        <Problem />
        <Features />
        <Showcase />
        <HowItWorks />
        <SelfHosted />
        <SocialProof />
        <Faq />
        <CtaFooter />
      </main>
    </div>
  );
}
