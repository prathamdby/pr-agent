import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";

type Common = {
  readonly variant?: Variant;
  readonly className?: string;
  /** Icon after the label. Padding on that side shrinks so the pair looks centred. */
  readonly trailingIcon?: ReactNode;
  readonly leadingIcon?: ReactNode;
  readonly children: ReactNode;
};

function classes({ variant = "primary", className, trailingIcon, leadingIcon }: Common): string {
  return [
    "btn",
    `btn-${variant}`,
    trailingIcon ? "btn-trailing" : "",
    leadingIcon ? "btn-leading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

type ButtonLinkProps = Common & {
  readonly href: string;
  /** Opens in a new tab and marks the link as leaving the site. */
  readonly external?: boolean;
  readonly onClick?: () => void;
};

export function ButtonLink({ href, external = false, onClick, ...rest }: ButtonLinkProps) {
  const externalProps = external ? { target: "_blank", rel: "noopener noreferrer" } : {};
  return (
    <a href={href} className={classes(rest)} onClick={onClick} {...externalProps}>
      {rest.leadingIcon}
      <span>{rest.children}</span>
      {rest.trailingIcon}
    </a>
  );
}

type ButtonProps = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

export function Button({
  variant,
  className,
  trailingIcon,
  leadingIcon,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes({ variant, className, trailingIcon, leadingIcon, children })}
      {...rest}
    >
      {leadingIcon}
      <span>{children}</span>
      {trailingIcon}
    </button>
  );
}
