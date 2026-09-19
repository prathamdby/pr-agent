type BrandMarkProps = {
  /** File name in public/logos, without extension. */
  readonly slug: string;
  readonly className?: string;
};

/**
 * Third-party logo rendered as a CSS mask so it takes `currentColor` and follows the theme.
 * Marks come from Simple Icons, svgl, and vendor brand pages; see public/logos.
 */
export function BrandMark({ slug, className = "size-5" }: BrandMarkProps) {
  const url = `url(/logos/${slug}.svg)`;
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{
        maskImage: url,
        WebkitMaskImage: url,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}
