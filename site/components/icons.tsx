type IconProps = {
  readonly className?: string;
};

/** Diagonal outbound arrow — house mark for CTAs, not the stock right chevron. */
export function OutboundArrow({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12 L12 4" />
      <path d="M6 4 H12 V10" />
    </svg>
  );
}
