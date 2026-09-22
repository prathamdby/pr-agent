import type { ReactNode } from "react";
import type { AlternativeId } from "@/lib/content";

type LogoProps = {
  readonly className?: string;
};

/**
 * Competitor marks, taken from each company's own brand kit and reduced to bare geometry filled
 * with `currentColor`, so they take the text colour of the surface they sit on instead of
 * shipping a fixed palette. Sources: coderabbit.ai/press-kit (black mark), greptile.com/design
 * (dark logo mark), cursor.com/brand (2D cube), macroscope.com/brand-kit (black mark).
 */
function mark(viewBox: string, children: ReactNode) {
  return function Mark({ className }: LogoProps) {
    return (
      <svg
        viewBox={viewBox}
        fill="currentColor"
        className={className}
        aria-hidden="true"
        focusable="false"
      >
        {children}
      </svg>
    );
  };
}

export const CodeRabbitMark = mark(
  "0 0 200 200",
  <>
    <path d="M100 0C155.229 0 200 44.7715 200 100C200 155.229 155.229 200 100 200C44.7715 200 0 155.228 0 100C1.61086e-06 44.7716 44.7715 0.000155396 100 0ZM81.8057 26.9258C86.1373 58.8782 104.026 50.5527 114.561 72.5762C114.534 72.5387 96.761 47.7854 67.5566 56.9082C67.5566 56.9082 78.209 79.8587 109.718 84.5479C109.718 84.5479 112.243 93.4297 113.004 94.9932C112.907 94.9413 64.4627 69.073 49.7432 118.866C38.7778 116.318 35.0997 128.533 47.7031 136.878C47.7031 136.878 49.8483 128.139 55.0703 125.545C55.0703 125.545 43.8635 138.371 57.041 153.73H104.339C105.482 151.788 110.54 141.566 98.0303 133.829C106.861 133.7 114.048 150.793 121.781 153.849H133.029C133.41 152.9 134.205 150.057 132.337 147.5C129.456 144.11 123.15 144.569 123.206 138.299C125.384 109.131 168.003 118.088 166.648 82.9844H166.65C166.65 82.9844 152.918 64.9735 135.658 63.9434C124.521 63.2689 121.823 64.7955 121.339 65.9326C120.648 60.0356 115.736 32.7156 81.8057 26.9258Z" />
  </>,
);

export const GreptileMark = mark(
  "0 0 367 420",
  <>
    <path d="M240.269 49.8154L166.804 115.963L115.966 159.44L181.335 220.585L249.784 162.048L196.78 112.47L253.068 61.7881L362.605 164.246L178.739 321.489L3.14502 157.242L187.011 0L240.269 49.8154Z" />
    <rect
      width="236.453"
      height="83.4566"
      transform="matrix(0.75471 -0.656059 0 1 188.017 336.544)"
    />
    <rect width="236.453" height="83.4566" transform="matrix(0.731354 0.681998 0 1 0 174.962)" />
  </>,
);

export const CursorMark = mark(
  "674.5 356.5 251 287",
  <>
    <path d="M920.015 424.958L805.919 359.086C802.256 356.97 797.735 356.97 794.071 359.086L679.981 424.958C676.901 426.736 675 430.025 675 433.587V566.419C675 569.981 676.901 573.269 679.981 575.048L794.077 640.92C797.74 643.036 802.261 643.036 805.925 640.92L920.02 575.048C923.1 573.269 925.001 569.981 925.001 566.419V433.587C925.001 430.025 923.1 426.736 920.02 424.958H920.015ZM912.848 438.911L802.706 629.682C801.961 630.968 799.995 630.443 799.995 628.954V504.039C799.995 501.543 798.662 499.234 796.498 497.981L688.321 435.526C687.036 434.781 687.561 432.816 689.05 432.816H909.334C912.462 432.816 914.417 436.206 912.853 438.917H912.848V438.911Z" />
  </>,
);

export const MacroscopeMark = mark(
  "0 0 352 352",
  <>
    <path d="M72.246 72.2768C129.485 14.992 222.29 14.992 279.529 72.2768C336.769 129.562 336.769 222.439 279.529 279.724C222.29 337.009 129.485 337.009 72.246 279.724C15.0065 222.439 15.0066 129.562 72.246 72.2768ZM261.172 90.5864C214.539 43.9121 138.932 43.9122 92.2997 90.5864C29.8477 153.094 112.379 168.911 147.647 204.21C182.916 239.51 198.719 322.117 261.172 259.609C307.804 212.935 307.804 137.261 261.172 90.5864ZM128.127 127.152C154.774 100.454 197.978 100.454 224.625 127.152C251.272 153.85 251.272 197.135 224.625 223.832C192.762 255.755 192.084 218.127 162.952 188.94C133.82 159.753 96.2645 159.075 128.127 127.152Z" />
  </>,
);

type BrandLogoProps = LogoProps & {
  readonly name: AlternativeId;
};

/** One logo per comparison row. PR Agent keeps its full-colour raster mark. */
export function BrandLogo({ name, className }: BrandLogoProps) {
  switch (name) {
    case "pr-agent":
      return (
        <img
          src="/logo.png"
          alt=""
          width={20}
          height={20}
          className={`rounded-xs outline-none ${className ?? ""}`}
        />
      );
    case "coderabbit":
      return <CodeRabbitMark className={className} />;
    case "greptile":
      return <GreptileMark className={className} />;
    case "cursor":
      return <CursorMark className={className} />;
    case "macroscope":
      return <MacroscopeMark className={className} />;
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}
