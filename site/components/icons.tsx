import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Bug01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Comment01Icon,
  Copy01Icon,
  DashboardSpeed01Icon,
  FeatherIcon,
  GitPullRequestIcon,
  GithubIcon,
  InformationCircleIcon,
  Linkedin02Icon,
  Menu01Icon,
  MinusSignIcon,
  NewTwitterIcon,
  PlusSignIcon,
  ServerStack01Icon,
  TerminalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

type IconProps = {
  readonly className?: string;
};

/**
 * Hugeicons, stroke-rounded set. The 1.5 stroke matches IBM Plex Sans at 400–500 weight, so an icon beside
 * a label reads as the same ink. Every icon here is decorative: the text next to it carries the
 * meaning, so the SVG is hidden from assistive tech.
 */
function fromGlyph(glyph: IconSvgElement) {
  return function Icon({ className }: IconProps) {
    return (
      <HugeiconsIcon
        icon={glyph}
        strokeWidth={1.5}
        color="currentColor"
        className={className}
        aria-hidden="true"
        focusable="false"
      />
    );
  };
}

export const ChevronRight = fromGlyph(ArrowRight01Icon);
export const ArrowUpRight = fromGlyph(ArrowUpRight01Icon);
export const Plus = fromGlyph(PlusSignIcon);
export const Minus = fromGlyph(MinusSignIcon);
export const Check = fromGlyph(Tick02Icon);
export const Copy = fromGlyph(Copy01Icon);
export const Menu = fromGlyph(Menu01Icon);
export const X = fromGlyph(Cancel01Icon);
export const GitHubMark = fromGlyph(GithubIcon);
export const XMark = fromGlyph(NewTwitterIcon);
export const LinkedInMark = fromGlyph(Linkedin02Icon);
export const Terminal = fromGlyph(TerminalIcon);
export const Server = fromGlyph(ServerStack01Icon);
export const PullRequest = fromGlyph(GitPullRequestIcon);
export const Scan = fromGlyph(Bug01Icon);
export const Comment = fromGlyph(Comment01Icon);
export const Gauge = fromGlyph(DashboardSpeed01Icon);
export const Feather = fromGlyph(FeatherIcon);
export const CheckCircle = fromGlyph(CheckmarkCircle02Icon);
export const XCircle = fromGlyph(CancelCircleIcon);
export const Info = fromGlyph(InformationCircleIcon);
