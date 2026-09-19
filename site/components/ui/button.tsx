import { ArrowUpRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

type ButtonLinkProps = {
  readonly href: string;
  readonly children: ReactNode;
  readonly variant?: "primary" | "secondary";
  readonly size?: "md" | "lg";
  readonly external?: boolean;
  /** Turns off the press scale where the motion would distract. */
  readonly static?: boolean;
  readonly className?: string;
};

const BASE =
  "group inline-flex items-center whitespace-nowrap rounded-control font-medium tracking-[-0.01em] transition-[background-color,color,box-shadow] duration-150 ease-out";

const VARIANT = {
  primary: "bg-accent text-accent-fg hover:bg-accent-ink hover:text-canvas",
  secondary: "bg-surface text-fg shadow-border hover:bg-well hover:shadow-border-hover",
} as const;

/* Trailing icon side gets 2px less padding than the text side, so the pair reads centred. */
const SIZE = {
  md: "h-10 gap-1.5 ps-4 pe-3.5 text-sm",
  lg: "h-12 gap-2 ps-5 pe-[18px] text-base",
} as const;

/** Anchor styled as a button. External links open in a new tab and show the outbound arrow. */
export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  external = false,
  static: isStatic = false,
  className = "",
}: ButtonLinkProps) {
  const classes = `${BASE} ${isStatic ? "" : "press"} ${VARIANT[variant]} ${SIZE[size]} ${className}`;
  const icon = (
    <ArrowUpRightIcon className="size-4 shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-px group-hover:-translate-y-px" />
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={classes}>
        {children}
        {icon}
      </a>
    );
  }
  return (
    <a href={href} className={classes}>
      {children}
      {icon}
    </a>
  );
}
