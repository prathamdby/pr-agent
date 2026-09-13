import type { CiRollup } from "./classifySnapshot.js";

const CI_ROLLUP_RE =
  /<!--\s*pr-agent:ci-rollup((?:\s+\w+=[^\s]+)*)\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-rollup\s*-->/;

export type CiRollupMarker = {
  readonly head: string | null;
  readonly version: number;
};

function attrsFromMatch(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (raw == null || raw.length === 0) return attrs;
  for (const part of raw.trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    attrs[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return attrs;
}

export function renderCiRollupMarker(headSha: string, version: number, rollup: CiRollup): string {
  return `<!-- pr-agent:ci-rollup head=${headSha} v=${version} -->${rollup}<!-- /pr-agent:ci-rollup -->`;
}

export function parseCiRollupMarker(body: string): CiRollupMarker | null {
  const match = CI_ROLLUP_RE.exec(body);
  if (match == null) return null;
  const attrs = attrsFromMatch(match[1]);
  const versionRaw = attrs.v;
  const parsed = versionRaw != null ? Number(versionRaw) : 0;
  return {
    head: attrs.head ?? null,
    version: Number.isSafeInteger(parsed) ? parsed : 0,
  };
}

export function shouldReplaceCiRollupMarker(
  body: string,
  headSha: string,
  version: number,
): boolean {
  const marker = parseCiRollupMarker(body);
  if (marker == null) return false;
  if (marker.head != null && marker.head !== headSha) return false;
  return marker.version < version;
}

export function replaceCiRollupMarkerIfNewer(
  body: string,
  nextMarker: string,
  headSha: string,
  version: number,
): string | null {
  if (!shouldReplaceCiRollupMarker(body, headSha, version)) return null;
  const next = body.replace(CI_ROLLUP_RE, nextMarker);
  return next === body ? null : next;
}
