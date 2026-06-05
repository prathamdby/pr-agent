import {
  siGithub,
  siCursor,
  siAnthropic,
  siGooglegemini,
  siOpenrouter,
  siNodedotjs,
  siDocker,
  siPostgresql,
} from "simple-icons";
import type { SimpleIcon } from "simple-icons";
import type { BrandName } from "./integrations.types";

const ICONS = {
  github: siGithub,
  cursor: siCursor,
  anthropic: siAnthropic,
  gemini: siGooglegemini,
  openrouter: siOpenrouter,
  node: siNodedotjs,
  docker: siDocker,
  postgres: siPostgresql,
} satisfies Record<BrandName, SimpleIcon>;

type BrandLogoProps = {
  name: BrandName;
  className?: string;
};

/**
 * Renders a real brand mark from simple-icons as a single-colour glyph,
 * so the integration wall reads as genuine logos rather than wordmarks.
 */
export function BrandLogo({ name, className }: BrandLogoProps) {
  const icon = ICONS[name];
  return (
    <svg
      role="img"
      aria-label={icon.title}
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
    >
      <path d={icon.path} />
    </svg>
  );
}
