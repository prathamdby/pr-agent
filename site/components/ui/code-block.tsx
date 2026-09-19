import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { IconSwap } from "@/components/ui/icon-swap";

type CodeBlockProps = {
  readonly code: string;
  readonly label: string;
};

/** Monospace block with a copy control. The label names the block for screen readers. */
export function CodeBlock({ code, label }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be denied. The text stays selectable, so nothing else is needed.
    }
  }

  return (
    <div className="relative rounded-[12px] bg-well shadow-[inset_0_0_0_1px_var(--color-line)]">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        className="press absolute right-2 top-2 grid size-10 place-items-center rounded-[6px] text-fg-subtle transition-[background-color,color] duration-150 ease-out hover:bg-surface hover:text-fg"
      >
        <IconSwap state={copied ? "copied" : "idle"}>
          {copied ? (
            <CheckIcon className="size-4 text-accent-ink" />
          ) : (
            <CopyIcon className="size-4" />
          )}
        </IconSwap>
      </button>
      <span role="status" className="sr-only">
        {copied ? `${label} copied to clipboard` : ""}
      </span>
      <pre className="overflow-x-auto p-4 pr-14 text-[13px] leading-relaxed text-fg">
        <code>{code}</code>
      </pre>
    </div>
  );
}
