import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { BrandMark } from "@/components/ui/brand-mark";
import { Section, SectionHeading } from "@/components/ui/section";
import { PROVIDERS } from "@/lib/content";

type Provider = {
  readonly name: string;
  readonly id: string;
  readonly model: string;
  readonly key: string;
  /** File name in public/logos. */
  readonly mark: string;
};

/* Provider ids and env names follow the Pi provider catalog. Model names are current defaults. */
const PROVIDERS_LIST: readonly Provider[] = [
  { name: "OpenAI", id: "openai", model: "gpt-5", key: "OPENAI_API_KEY", mark: "openai" },
  {
    name: "Anthropic",
    id: "anthropic",
    model: "claude-sonnet-5",
    key: "ANTHROPIC_API_KEY",
    mark: "anthropic",
  },
  {
    name: "Google",
    id: "google",
    model: "gemini-3-pro",
    key: "GEMINI_API_KEY",
    mark: "googlegemini",
  },
  {
    name: "DeepSeek",
    id: "deepseek",
    model: "deepseek-v4",
    key: "DEEPSEEK_API_KEY",
    mark: "deepseek",
  },
  {
    name: "OpenRouter",
    id: "openrouter",
    model: "anthropic/claude-sonnet-5",
    key: "OPENROUTER_API_KEY",
    mark: "openrouter",
  },
  { name: "Groq", id: "groq", model: "llama-4-maverick", key: "GROQ_API_KEY", mark: "groq" },
  {
    name: "Mistral",
    id: "mistral",
    model: "mistral-large-3",
    key: "MISTRAL_API_KEY",
    mark: "mistralai",
  },
  { name: "xAI", id: "xai", model: "grok-4", key: "XAI_API_KEY", mark: "x" },
  { name: "Ollama", id: "ollama", model: "qwen3-coder", key: "OLLAMA_HOST", mark: "ollama" },
];

function EnvLine({ name, value }: { readonly name: string; readonly value: string }) {
  const reduce = useReducedMotion();
  return (
    <span className="block whitespace-nowrap">
      <span className="text-fg-subtle">{name}=</span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          className="inline-block text-accent-ink"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, filter: "blur(4px)" }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Pick a provider and the env block on the left updates. That is the whole switch. */
export function Providers() {
  const [active, setActive] = useState(1);
  const reduce = useReducedMotion();
  const current = PROVIDERS_LIST[active] ?? PROVIDERS_LIST[0];
  const lede = PROVIDERS[0]?.detail;

  return (
    <Section id="providers" labelledBy="providers-heading">
      <div className="grid min-w-0 gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <SectionHeading id="providers-heading" lede={lede}>
            Change models without retraining your team
          </SectionHeading>
          <pre
            aria-live="polite"
            className="card mt-8 overflow-x-auto rounded-[12px] p-5 font-mono text-[13px] leading-[1.9] text-fg"
          >
            <code>
              <EnvLine name="PI_PROVIDER" value={current.id} />
              <EnvLine name="PI_MODEL" value={current.model} />
              <EnvLine name={current.key} value="..." />
            </code>
          </pre>
          <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-fg-subtle">
            Pick a provider on the right. Those are the only lines that change.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Model provider"
          className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3"
        >
          {PROVIDERS_LIST.map((provider, index) => {
            const selected = index === active;
            return (
              <button
                key={provider.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setActive(index)}
                className={`press relative flex aspect-[4/3] min-w-0 flex-col items-start justify-between rounded-panel p-4 text-left transition-[color] duration-150 ease-out sm:p-5 ${
                  selected ? "text-fg" : "text-fg-muted hover:text-fg"
                }`}
              >
                {selected ? (
                  <motion.span
                    layoutId={reduce ? undefined : "provider-ring"}
                    className="absolute inset-0 rounded-panel bg-accent-tint"
                    style={{ boxShadow: "0 0 0 1px var(--color-accent)" }}
                    transition={{ type: "spring", duration: 0.3, bounce: 0 }}
                    aria-hidden="true"
                  />
                ) : (
                  <span className="card absolute inset-0 rounded-panel" aria-hidden="true" />
                )}
                <span className="relative">
                  <BrandMark slug={provider.mark} />
                </span>
                <span className="relative text-lg font-semibold">{provider.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );
}
