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
      title={command}
      className="press group mt-0 flex min-h-12 w-full max-w-full items-center gap-3 rounded-control bg-surface py-2.5 ps-4 pe-3.5 shadow-border transition-[box-shadow] duration-150 ease-out hover:shadow-border-hover sm:w-auto sm:ps-5 sm:pe-[18px]"
    >
      <span className="min-w-0 text-left font-mono text-[13px] leading-snug text-fg-muted sm:text-sm">
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
