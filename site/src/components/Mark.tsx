import { cn } from "@/lib/utils";

export function Mark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 text-[0.95rem] font-semibold tracking-tight text-fg",
        className,
      )}
    >
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#0C0E10" />
        <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" stroke="#2B323A" />
        <path
          d="M9 16.5 L14 21 L23 11"
          stroke="#34D399"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      PR Agent
    </span>
  );
}
