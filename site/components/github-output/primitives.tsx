import type { ReactNode } from "react";
import { ChevronRight, Info } from "@/components/icons";

type Frame = "inline" | "window";

type GhCommentProps = {
  /** Where this output lands on GitHub, shown in the comment header. */
  readonly surface: string;
  readonly frame?: Frame;
  readonly children: ReactNode;
};

/** A GitHub timeline comment authored by the App bot, in GitHub's light palette. */
export function GhComment({ surface, frame = "inline", children }: GhCommentProps) {
  const chassis = frame === "window" ? "window" : "rounded-sm bg-surface shadow-soft";
  return (
    <article className={`overflow-hidden text-xs leading-relaxed text-text ${chassis}`}>
      <header className="flex items-center gap-2 border-b border-line bg-surface-raised px-3 py-2">
        <img
          src="/logo.png"
          alt=""
          width={20}
          height={20}
          className="size-5 shrink-0 rounded-xs outline-none"
        />
        <p className="min-w-0 truncate">
          <span className="font-semibold">pr-agent</span>{" "}
          <span className="rounded-xs px-1 py-px text-[10px] font-medium text-text-secondary shadow-ring">
            bot
          </span>{" "}
          <span className="text-text-secondary">commented just now</span>
        </p>
        <span className="ml-auto hidden shrink-0 text-[11px] text-text-tertiary sm:inline">
          {surface}
        </span>
      </header>
      <div className="space-y-3 px-3.5 py-3">{children}</div>
    </article>
  );
}

/** Markdown `##` heading as GitHub renders it, with the rule underneath. */
export function GhTitle({ children }: { readonly children: ReactNode }) {
  return <p className="border-b border-line pb-1.5 text-sm font-semibold text-text">{children}</p>;
}

/** GitHub `[!NOTE]` alert. */
export function GhNote({ children }: { readonly children: ReactNode }) {
  return (
    <div className="border-l-[3px] border-accent-solid py-0.5 pl-3 text-text-secondary">
      <p className="mb-0.5 inline-flex items-center gap-1 font-medium text-accent-text">
        <Info className="size-3.5" />
        Note
      </p>
      <div>{children}</div>
    </div>
  );
}

export function GhCode({ children }: { readonly children: ReactNode }) {
  return (
    <code className="rounded-xs bg-surface-raised px-1 py-px font-mono text-[11px] text-text">
      {children}
    </code>
  );
}

export function GhLabel({ children }: { readonly children: ReactNode }) {
  return <p className="font-semibold text-text">{children}</p>;
}

type KvRow = {
  readonly label: ReactNode;
  readonly value: ReactNode;
};

/** Mirrors `renderKeyValueTable`: an HTML table with a bold first column and no header row. */
export function GhKvTable({ rows }: { readonly rows: readonly KvRow[] }) {
  return (
    <table className="w-full border-collapse text-left">
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-b border-line align-top last:border-b-0">
            <th scope="row" className="w-24 py-2 pr-3 font-semibold text-text sm:w-28">
              {row.label}
            </th>
            <td className="py-2 text-text-secondary">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function GhDetails({
  summary,
  children,
}: {
  readonly summary: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="disclosure group">
      <summary className="hit-area inline-flex items-center gap-1.5 text-text-secondary">
        <ChevronRight className="size-3.5 transition-transform duration-200 ease-out-quart group-open:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="mt-2 text-text-secondary">{children}</div>
    </details>
  );
}

type Tone = "success" | "danger" | "warning" | "neutral" | "accent";

const TONES: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-surface-raised text-text-secondary shadow-ring",
  accent: "bg-accent-soft text-accent-text",
};

export function GhPill({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function GhPre({ children }: { readonly children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xs bg-surface-raised p-2.5 font-mono text-[11px] leading-relaxed text-text">
      <code>{children}</code>
    </pre>
  );
}
