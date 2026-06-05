import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

type FrameProps = {
  label: string;
  src: string;
  alt: string;
  className?: string;
  status?: ReactNode;
};

/**
 * A restrained window chrome around a real product screenshot.
 * Keeps the GitHub captures feeling like a live surface, not a flat image.
 */
export function Frame({ label, src, alt, className, status }: FrameProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius)] border border-border-hi bg-bg-soft shadow-[var(--shadow-soft)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-surface/80 px-4 py-3">
        <span className="size-3 rounded-full bg-border-hi" />
        <span className="size-3 rounded-full bg-border-hi" />
        <span className="size-3 rounded-full bg-border-hi" />
        <span className="ml-3 truncate font-mono text-xs text-fg-dim">{label}</span>
        {status ? <div className="ml-auto">{status}</div> : null}
      </div>
      <img src={src} alt={alt} loading="lazy" className="block w-full" />
    </div>
  );
}
