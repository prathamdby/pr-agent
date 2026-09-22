import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "@/components/icons";

type CopyButtonProps = {
  readonly text: string;
  readonly label?: string;
  readonly variant?: "ghost" | "primary" | "secondary";
  /** Put the copy icon after the label instead of before it. */
  readonly iconAfter?: boolean;
  /** Decoration before the label, such as a row of small marks. */
  readonly prefix?: ReactNode;
};

/**
 * Writes `text` to the clipboard and confirms with both an icon swap and a label change, so the
 * state never rests on colour alone. The live region repeats it for screen readers.
 */
export function CopyButton({
  text,
  label = "Copy",
  variant = "ghost",
  iconAfter = false,
  prefix,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => {
        // Clipboard access can be denied. The text stays visible and selectable beside the button.
      });
  };

  const chassis = {
    primary: "btn btn-primary btn-leading h-9 rounded-xs text-[13px]",
    secondary: "btn btn-secondary btn-trailing",
    ghost: "btn btn-ghost btn-leading h-7 gap-1.5 rounded-xs px-2 text-xs",
  }[variant];

  // The swap state sits on wrapper spans: the icon component does not forward data attributes.
  const icon = (
    <span className="swap size-4" aria-hidden="true">
      <span data-shown={!copied} className="grid place-items-center">
        <Copy className={iconAfter ? "size-4 text-text-tertiary" : "size-3.5"} />
      </span>
      <span data-shown={copied} className="grid place-items-center">
        <Check className={iconAfter ? "size-4 text-success" : "size-3.5 text-success"} />
      </span>
    </span>
  );

  return (
    <button type="button" onClick={copy} className={chassis} aria-live="off">
      {prefix}
      {iconAfter ? null : icon}
      <span className="grid">
        <span className={copied ? "invisible col-start-1 row-start-1" : "col-start-1 row-start-1"}>
          {label}
        </span>
        <span className={copied ? "col-start-1 row-start-1" : "invisible col-start-1 row-start-1"}>
          Copied
        </span>
      </span>
      {iconAfter ? icon : null}
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}
