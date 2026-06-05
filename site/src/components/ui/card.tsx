import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border border-line bg-surface/60 p-6 shadow-[var(--shadow-lift)]",
        className,
      )}
      {...props}
    />
  );
}
