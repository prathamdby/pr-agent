import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Terminal } from "@/components/icons";

type Language = "bash" | "dotenv";

type CodeBlockProps = {
  readonly label: string;
  readonly code: string;
  readonly language: Language;
};

/** Minimal display colouring: enough to separate comments, commands, keys and values. */
function highlight(code: string, language: Language): ReactNode[] {
  return code.split("\n").map((line, index) => {
    const key = `${index}-${line}`;
    if (language === "bash") {
      if (line.startsWith("#")) {
        return (
          <span key={key} className="block whitespace-pre-wrap text-text-tertiary">
            {line}
          </span>
        );
      }
      const [head, ...tail] = line.split(" ");
      return (
        <span key={key} className="block">
          <span className="text-accent-text">{head}</span>
          {tail.length > 0 ? <span className="text-text"> {tail.join(" ")}</span> : null}
        </span>
      );
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      return (
        <span key={key} className="block text-text">
          {line}
        </span>
      );
    }
    return (
      <span key={key} className="block">
        <span className="text-accent-text">{line.slice(0, separator)}</span>
        <span className="text-text-tertiary">=</span>
        <span className="text-text-secondary">{line.slice(separator + 1)}</span>
      </span>
    );
  });
}

/**
 * Same shell as the use-case tabs: a grey frame with a hairline edge holds the label row, and
 * the code sits in a white box inset by the frame's padding, one radius step smaller.
 */
export function CodeBlock({ label, code, language }: CodeBlockProps) {
  return (
    <figure className="rounded-md bg-surface-raised p-1.5 shadow-ring">
      <figcaption className="flex items-center justify-between gap-3 pt-0.5 pr-0.5 pb-1.5 pl-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Terminal className="size-3.5" />
          {label}
        </span>
        <CopyButton text={code} target={`${label} snippet`} />
      </figcaption>
      <pre className="overflow-x-auto rounded-xs bg-surface p-4 text-[13px] leading-relaxed shadow-soft">
        <code>{highlight(code, language)}</code>
      </pre>
    </figure>
  );
}
