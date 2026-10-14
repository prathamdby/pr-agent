import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "@/components/icons";

type CopyButtonProps = {
  readonly text: string;
  readonly label?: string;
  readonly variant?: "ghost" | "primary" | "secondary";
  readonly iconAfter?: boolean;
  readonly prefix?: ReactNode;
  readonly target?: string;
};

export function CopyButton({
  text,
  label = "Copy",
  variant = "ghost",
  iconAfter = false,
  prefix,
  target,
}: CopyButtonProps) {
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
      .catch(() => {});
  };

  const chassis = {
    primary: "btn btn-primary btn-leading h-9 rounded-xs text-label",
    secondary: prefix ? "btn btn-secondary px-3" : "btn btn-secondary btn-trailing",
    ghost: "btn btn-ghost h-7 gap-1.5 rounded-xs pr-2 pl-1.5 text-xs",
  }[variant];

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
