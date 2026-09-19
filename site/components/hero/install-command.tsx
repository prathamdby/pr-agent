import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { IconSwap } from "@/components/ui/icon-swap";

type InstallCommandProps = {
  readonly command: string;
};

/** One-line shell command the visitor can copy. The whole row is the button. */
export function InstallCommand({ command }: InstallCommandProps) {
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
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied. The text stays visible, so nothing else is needed.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied install command" : "Copy install command"}
      className="press group mt-7 flex h-12 items-center gap-3 rounded-control bg-surface ps-5 pe-[18px] shadow-border transition-[box-shadow] duration-150 ease-out hover:shadow-border-hover sm:mt-8"
    >
      <span className="whitespace-nowrap font-mono text-sm text-fg-muted">
        <span className="text-accent-ink">$</span> {command}
      </span>
      <IconSwap
        state={copied ? "copied" : "idle"}
        className="text-fg-subtle transition-colors duration-150 ease-out group-hover:text-fg-muted"
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-accent-ink" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </IconSwap>
      <span role="status" className="sr-only">
        {copied ? "Install command copied to clipboard" : ""}
      </span>
    </button>
  );
}
