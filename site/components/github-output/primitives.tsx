import type { ReactNode } from "react";

/** GitHub `[!NOTE]` alert, restyled to the logo navy system. */
export function GhNote({ children }: { readonly children: ReactNode }) {
  return (
    <div className="border-l-[3px] border-sky bg-sky/10 px-2.5 py-1.5 text-xs leading-relaxed text-ink-soft">
      <p className="mb-0.5 text-[10px] font-semibold tracking-wide text-sky">Note</p>
      <div className="line-clamp-2">{children}</div>
    </div>
  );
}

export function GhCode({ children }: { readonly children: ReactNode }) {
  return (
    <code className="rounded-sm bg-navy-inset px-1 py-0.5 font-mono text-[11px] text-bolt">
      {children}
    </code>
  );
}

type KvRow = {
  readonly label: ReactNode;
  readonly value: ReactNode;
};

/** Mirrors `renderKeyValueTable` — HTML table, no GFM header row. */
export function GhKvTable({ rows }: { readonly rows: readonly KvRow[] }) {
  return (
    <table className="w-full border-collapse text-left text-xs">
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-b border-edge align-top last:border-b-0">
            <th scope="row" className="w-[6.5rem] py-1.5 pr-2 font-semibold text-ink-soft sm:w-28">
              {row.label}
            </th>
            <td className="py-1.5 text-ink-mute">{row.value}</td>
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
    <details className="surface-inset edge-self group">
      <summary className="cursor-pointer list-none px-2.5 py-1.5 text-xs text-ink-soft marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-ink-faint transition-transform group-open:rotate-90">
            ▸
          </span>
          <span className="truncate">{summary}</span>
        </span>
      </summary>
      <div className="border-t border-edge px-2.5 py-2 text-xs text-ink-mute">{children}</div>
    </details>
  );
}

/** Shared fixed shell so every slash-command mock shares one size. */
export function OutputFrame({
  title,
  surface = "PR conversation",
  children,
}: {
  readonly title?: string;
  readonly surface?: string;
  readonly children: ReactNode;
}) {
  return (
    <article className="chamfer surface-panel edge-self flex h-[24rem] w-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-edge px-3 py-2.5">
        <img src="/logo.png" alt="" width={22} height={22} className="h-[22px] w-[22px] shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-ink">PR Agent</p>
          <p className="truncate font-mono text-[10px] text-ink-faint">{surface}</p>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden px-3 py-3">
        <div className="space-y-2.5">
          {title ? (
            <h3 className="font-display text-base leading-tight text-ink sm:text-lg">{title}</h3>
          ) : null}
          {children}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-navy-panel to-transparent" />
      </div>
    </article>
  );
}
