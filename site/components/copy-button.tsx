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
  /** Screen-reader-only words after the label, so repeated "Copy" buttons stay distinguishable. */
  readonly target?: string;
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
  target,
}: CopyButtonProps) {
  // A timestamp rather than a flag, so copying again restarts the confirmation window.
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const copied = copiedAt !== null;

  useEffect(() => {
    if (copiedAt === null) {
      return undefined;
    }
    const timer = setTimeout(() => setCopiedAt(null), 1800);
    return () => clearTimeout(timer);
  }, [copiedAt]);

  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopiedAt(Date.now()))
      .catch(() => {
        // Clipboard access can be denied. The text stays visible and selectable beside the button.
      });
  };

  const chassis = {
    primary: "btn btn-primary btn-leading h-9 rounded-xs text-[13px]",
    // Marks before the label and the icon after it: both sides take the tighter icon padding.
    secondary: prefix ? "btn btn-secondary px-3" : "btn btn-secondary btn-trailing",
    ghost: "btn btn-ghost h-7 gap-1.5 rounded-xs pr-2 pl-1.5 text-xs",
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

  const targetText = target ? <span className="sr-only"> {target}</span> : null;

  // The status region sits beside the button so the confirmation never joins the button's name.
  return (
    <>
      <button type="button" onClick={copy} className={chassis}>
        {prefix}
        {iconAfter ? null : icon}
        <span className="grid">
          <span
            className={copied ? "invisible col-start-1 row-start-1" : "col-start-1 row-start-1"}
          >
            {label}
            {targetText}
          </span>
          <span
            className={copied ? "col-start-1 row-start-1" : "invisible col-start-1 row-start-1"}
          >
            Copied
            {targetText}
          </span>
        </span>
        {iconAfter ? icon : null}
      </button>
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </>
  );
}
