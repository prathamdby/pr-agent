import type { ReactNode } from "react";

/*
  GitHub-styled primitives for the mock pull request. Everything reads from the --gh-* tokens
  so the same markup sits on GitHub's light or dark palette with the page's colour scheme.
*/

export const ghLine = "1px solid var(--gh-line)";

export function GhCode({ children }: { readonly children: ReactNode }) {
  return (
    <code
      className="rounded-[4px] px-[0.35em] py-[0.1em] font-mono text-[0.92em]"
      style={{ background: "var(--gh-code)" }}
    >
      {children}
    </code>
  );
}

export function GhLabel({
  children,
  tone = "muted",
}: {
  readonly children: ReactNode;
  readonly tone?: "muted" | "success" | "attention" | "done";
}) {
  const color =
    tone === "muted"
      ? "var(--gh-muted)"
      : tone === "success"
        ? "var(--gh-success)"
        : tone === "attention"
          ? "var(--gh-attention)"
          : "var(--gh-done)";
  return (
    <span
      className="whitespace-nowrap rounded-full px-2 text-[11px] font-medium leading-[18px]"
      style={{ border: `1px solid ${color}`, color }}
    >
      {children}
    </span>
  );
}

export function GhNote({ children }: { readonly children: ReactNode }) {
  return (
    <div className="py-1 pl-4" style={{ borderLeft: "4px solid var(--gh-accent)" }}>
      <p className="mb-1 font-semibold" style={{ color: "var(--gh-accent)" }}>
        Note
      </p>
      <div>{children}</div>
    </div>
  );
}

export function GhTable({ children }: { readonly children: ReactNode }) {
  return (
    <table className="w-full border-collapse" style={{ border: ghLine }}>
      <tbody>{children}</tbody>
    </table>
  );
}

export function GhRow({
  label,
  children,
  last = false,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly last?: boolean;
}) {
  return (
    <tr style={{ borderBottom: last ? undefined : ghLine }}>
      <th
        scope="row"
        className="w-[7.5em] whitespace-nowrap px-3 py-2 text-left align-top font-semibold"
        style={{ borderRight: ghLine }}
      >
        {label}
      </th>
      <td className="px-3 py-2 align-top">{children}</td>
    </tr>
  );
}

type GhCommentProps = {
  readonly author: string;
  readonly bot?: boolean;
  readonly when: string;
  readonly avatar: ReactNode;
  readonly children: ReactNode;
};

/** A timeline comment: avatar outside, header strip, body. */
export function GhComment({ author, bot = false, when, avatar, children }: GhCommentProps) {
  return (
    <div className="flex gap-3">
      <span className="hidden size-10 shrink-0 sm:block">{avatar}</span>
      <div
        className="min-w-0 flex-1 rounded-[6px]"
        style={{ background: "var(--gh-bg)", border: ghLine }}
      >
        <div
          className="flex items-center gap-2 rounded-t-[6px] px-4 py-2"
          style={{ background: "var(--gh-subtle)", borderBottom: ghLine }}
        >
          <span className="whitespace-nowrap font-semibold">{author}</span>
          {bot ? <GhLabel>Bot</GhLabel> : null}
          <span className="truncate" style={{ color: "var(--gh-muted)" }}>
            commented {when}
          </span>
        </div>
        <div className="space-y-3 px-4 py-3">{children}</div>
      </div>
    </div>
  );
}

export function BotAvatar() {
  return <img src="/logo.png" alt="" width={40} height={40} className="size-10 rounded-[10px]" />;
}

function hash(seed: string): number {
  let h = 2166136261;
  for (const ch of seed) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  }
  return h >>> 0;
}

/** GitHub-style identicon: a mirrored 5x5 grid and one hue, both derived from the seed. */
export function HumanAvatar({ seed }: { readonly seed: string }) {
  const h = hash(seed);
  const hue = h % 360;
  const cells: boolean[] = [];
  for (let i = 0; i < 15; i += 1) {
    cells.push(((h >>> i) & 1) === 1);
  }
  return (
    <svg viewBox="0 0 5 5" className="size-10 rounded-full" aria-hidden="true">
      <rect width="5" height="5" fill="#f0f0f0" />
      {Array.from({ length: 25 }, (_, i) => {
        const x = i % 5;
        const y = Math.floor(i / 5);
        const col = x < 3 ? x : 4 - x;
        return cells[y * 3 + col] ? (
          <rect key={i} x={x} y={y} width="1" height="1" fill={`hsl(${hue} 55% 50%)`} />
        ) : null;
      })}
    </svg>
  );
}
