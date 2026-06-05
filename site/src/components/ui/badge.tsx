import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border-hi bg-surface/70 px-3 py-1 text-xs font-medium text-fg-muted backdrop-blur",
        className,
      )}
      {...props}
    />
  );
}
