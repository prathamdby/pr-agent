const GLYPHS = [
  "+",
  "-",
  "/",
  "#",
  "{",
  "}",
  "*",
  "~",
  ">",
  "|",
  ".",
  ":",
  ";",
  "=",
  "?",
  "!",
  "[",
  "]",
  "(",
  ")",
  "`",
  "^",
  "%",
  "&",
] as const;

function buildField(seed: number, count: number): string[] {
  const out: string[] = [];
  let n = seed;
  for (let i = 0; i < count; i += 1) {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    out.push(GLYPHS[n % GLYPHS.length]!);
  }
  return out;
}

const FIELD = buildField(42, 280);

type DiffFieldProps = {
  readonly className?: string;
};

/** Low-contrast drifting diff glyphs. Decorative only; sits behind content. */
export function DiffField({ className }: DiffFieldProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden select-none ${className ?? ""}`}
      aria-hidden="true"
    >
      <div className="animate-diff-drift absolute -inset-16 grid grid-cols-[repeat(20,minmax(0,1fr))] gap-x-3 gap-y-2 font-mono text-[11px] leading-none text-moss/25 sm:text-xs">
        {FIELD.map((glyph, index) => (
          <span key={`${glyph}-${index}`} className="justify-self-center">
            {glyph}
          </span>
        ))}
      </div>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,transparent_0%,var(--color-forge)_68%)]" />
    </div>
  );
}
