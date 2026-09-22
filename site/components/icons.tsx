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
  HelpCircleIcon,
  InformationCircleIcon,
  Menu01Icon,
  MinusSignIcon,
  NoteEditIcon,
  PlusSignIcon,
  RefreshIcon,
  SecurityCheckIcon,
  ServerStack01Icon,
  StarIcon,
  TerminalIcon,
  Tick02Icon,
  ViewIcon,
  Wallet01Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

type IconProps = {
  readonly className?: string;
};

/**
 * Hugeicons, stroke-rounded set. The 1.5 stroke matches Geist at 400–500 weight, so an icon beside
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
export const Terminal = fromGlyph(TerminalIcon);
export const Server = fromGlyph(ServerStack01Icon);
export const PullRequest = fromGlyph(GitPullRequestIcon);
export const Scan = fromGlyph(Bug01Icon);
export const Comment = fromGlyph(Comment01Icon);
export const Gauge = fromGlyph(DashboardSpeed01Icon);
export const Eye = fromGlyph(ViewIcon);
export const Document = fromGlyph(NoteEditIcon);
export const Question = fromGlyph(HelpCircleIcon);
export const Refresh = fromGlyph(RefreshIcon);
export const Wrench = fromGlyph(Wrench01Icon);
export const Feather = fromGlyph(FeatherIcon);
export const Wallet = fromGlyph(Wallet01Icon);
export const Shield = fromGlyph(SecurityCheckIcon);
export const Star = fromGlyph(StarIcon);
export const CheckCircle = fromGlyph(CheckmarkCircle02Icon);
export const XCircle = fromGlyph(CancelCircleIcon);
export const Info = fromGlyph(InformationCircleIcon);
