import { execFileSync } from "node:child_process";

// PR commit-message gate: conventional formatting rules mirrored from the
// /commit skill. Diff-trace, type-vs-hunks, and what-vs-why are reviewer-owned
// semantic checks this linter does not perform.
const ALLOWED_TYPES = ["feat", "fix", "refactor", "docs", "test", "chore", "style", "perf"];
const MAX_SUBJECT = 50;
const MAX_BODY_LINE = 72;
const MAX_BULLETS = 5;

// Non-imperative first words the skill rejects ("fixed", "fixes", "adding",
// and matching inflections), plus vague verbs (update/change/address/improve)
// the shared rejection check only allows when no concrete verb fits.
const NON_IMPERATIVE = new Set([
  "fixed",
  "fixes",
  "fixing",
  "added",
  "adds",
  "adding",
  "removed",
  "removes",
  "removing",
  "refactored",
  "refactors",
  "refactoring",
]);
const VAGUE =
  /^(updates?|updated|updating|changes?|changed|changing|address(es)?|addressed|addressing|improv(es?|ed|ing))$/;

// Review-session framing the shared rejection check bans, matched
// case-insensitively against subject and body.
const REVIEW_PHRASES = [
  "address review feedback",
  "address review findings",
  "address pr feedback",
  "review follow-up",
  "review followup",
  "per review",
];

// Banned trailer keys in `Key: value` form and harness footers as
// case-insensitive whole-line substring matches.
const BANNED_TRAILER_KEYS = ["co-authored-by", "signed-off-by", "made-with"];
const BANNED_FOOTERS = ["made with cursor", "generated with claude"];

// Standards identifiers (UTF-8, SHA-256, ISO-8601, CVE-...) and six-digit
// hex colors are content, not ticket references.
const STANDARD_ID = /\b(?:UTF|SHA|ISO|RFC|ECMA|AES|TLS|CVE)-[0-9][0-9-]*\b/g;
const HEX_COLOR = /#[0-9a-fA-F]{6}\b/;

function usage() {
  return [
    "usage: node scripts/check-commit-messages.mjs [--base <ref>] [--head <ref>]",
    "",
    "Checks every non-merge commit in <base>..<head> against the /commit",
    "skill's conventional style. Defaults: --base origin/main --head HEAD.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { base: "origin/main", head: "HEAD" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if ((flag === "--base" || flag === "--head") && i + 1 < argv.length) {
      args[flag.slice(2)] = argv[++i];
      continue;
    }
    console.error(`unknown argument: ${flag}\n${usage()}`);
    process.exit(2);
  }
  return args;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function listPrCommits(base, head) {
  let mergeBase;
  try {
    mergeBase = git(["merge-base", base, head]).trim();
  } catch {
    console.error(`Cannot resolve merge-base of ${base} and ${head}. Fetch full history first.`);
    process.exit(2);
  }
  const out = git(["rev-list", "--no-merges", "--reverse", `${mergeBase}..${head}`]).trim();
  return out.length === 0 ? [] : out.split("\n");
}

function firstWordLower(text) {
  const match = text.match(/[A-Za-z]+/);
  return match ? match[0].toLowerCase() : "";
}

function validateCommit(raw) {
  const errors = [];
  const text = raw.replace(/\n+$/, "");
  if (text.length === 0) {
    return ["empty commit message"];
  }
  const lines = text.split("\n");
  const subject = lines[0];

  const typeMatch = subject.match(/^([A-Za-z]+): (.+)$/);
  if (subject.match(/^[A-Za-z]+\([^)]*\):/)) {
    errors.push("scope notation is forbidden (use 'type: description' with no scope)");
  } else if (!typeMatch) {
    errors.push("subject must be 'type: description' (e.g. 'fix: charge retries at admission')");
  } else {
    const [, type, description] = typeMatch;
    if (!ALLOWED_TYPES.includes(type)) {
      errors.push(`type '${type}' is not allowed (use ${ALLOWED_TYPES.join(", ")})`);
    }
    if (subject.length > MAX_SUBJECT) {
      errors.push(`subject is ${subject.length} chars, limit is ${MAX_SUBJECT}`);
    }
    if (subject.endsWith(".")) {
      errors.push("subject must not end with a period");
    }
    const desc = description.trim();
    if (desc.length === 0) {
      errors.push("description after 'type: ' must not be empty");
    } else {
      const firstWord = desc.match(/^[A-Za-z]+/)?.[0] ?? "";
      const initialism = /^[A-Z]{2,}$/.test(firstWord);
      if (/^[A-Z]/.test(desc) && !initialism) {
        errors.push(
          "description must start lowercase (all-caps initialisms such as LLM stay capped)",
        );
      }
      const first = firstWordLower(desc);
      if (NON_IMPERATIVE.has(first)) {
        errors.push(
          `description starts with non-imperative '${first}' (write "If applied, this commit will ${desc}")`,
        );
      } else if (VAGUE.test(first)) {
        errors.push(
          `description starts with vague verb '${first}' (name the concrete action the hunks prove)`,
        );
      }
    }
  }

  if (lines.length >= 2 && lines[1].trim().length !== 0) {
    errors.push("second line must be blank (subject/body are separate -m arguments)");
  }

  const body = lines.length > 2 ? lines.slice(2) : [];
  if (lines.length > 1 && body.length === 0 && lines[1].trim().length === 0) {
    errors.push("trailing blank line with no body (use one -m for subject-only commits)");
  }
  if (body.length > 0) {
    if (body.some((line) => line.trim().length === 0)) {
      errors.push("body must not contain blank lines (bullets belong to one -m argument)");
    }
    const bullets = body.filter((line) => line.startsWith("- "));
    for (const line of body) {
      if (line.startsWith("- ") || line.startsWith("  ")) continue;
      errors.push(`body line is neither a '- ' bullet nor a two-space continuation: '${line}'`);
      break;
    }
    if (bullets.length === 0) {
      errors.push("body must be '- ' bullets (one to five, no prose paragraphs)");
    } else {
      if (bullets.length > MAX_BULLETS) {
        errors.push(`body has ${bullets.length} bullets, limit is ${MAX_BULLETS}`);
      }
      const subjectDesc = typeMatch ? typeMatch[2].trim().toLowerCase() : "";
      for (const bullet of bullets) {
        const content = bullet.slice(2);
        if (!/^[A-Z]/.test(content)) {
          errors.push(`bullet must start capitalized: '${bullet}'`);
        }
        if (subjectDesc.length > 0 && content.trim().toLowerCase() === subjectDesc) {
          errors.push(`bullet restates the subject instead of adding what/why: '${bullet}'`);
        }
      }
      for (const line of body) {
        if (line.length > MAX_BODY_LINE) {
          errors.push(`body line is ${line.length} chars, limit is ${MAX_BODY_LINE}: '${line}'`);
        }
        if (line.endsWith(".")) {
          errors.push(`body line must not end with a period: '${line}'`);
        }
        if (/^   +/.test(line)) {
          errors.push(`continuation indent is two spaces, not more: '${line}'`);
        }
      }
    }
  }

  for (const line of lines) {
    const trailer = line.match(/^\s*([A-Za-z-]+)\s*:\s*\S/);
    if (trailer && BANNED_TRAILER_KEYS.includes(trailer[1].toLowerCase())) {
      errors.push(`banned trailer '${trailer[1]}:' (trailers default to denied)`);
    }
    const lowered = line.toLowerCase();
    for (const footer of BANNED_FOOTERS) {
      if (lowered.includes(footer)) {
        errors.push(`banned harness footer '${line.trim()}'`);
        break;
      }
    }
    const ticketStripped = line.replace(STANDARD_ID, "").replace(/\bADR-\d+\b/g, "");
    const hashTicket = [...line.matchAll(/#\d+\b/g)].some((match) => !HEX_COLOR.test(match[0]));
    if (hashTicket || /\bissue-\d+\b/i.test(line) || /\b[A-Z]{2,}-\d+\b/.test(ticketStripped)) {
      errors.push(`ticket ID in commit message: '${line.trim()}'`);
    }
    for (const phrase of REVIEW_PHRASES) {
      if (lowered.includes(phrase)) {
        errors.push(`review-session framing '${phrase}' is not commit content`);
        break;
      }
    }
  }

  return errors;
}

const { base, head } = parseArgs(process.argv.slice(2));
const shas = listPrCommits(base, head);
if (shas.length === 0) {
  console.log(`Commit-message check passed: no non-merge commits in ${base}..${head}.`);
  process.exit(0);
}

let failed = 0;
for (const sha of shas) {
  const raw = git(["log", "-1", "--format=%B", sha]);
  const short = git(["log", "-1", "--format=%s", sha]).trim();
  const errors = validateCommit(raw);
  if (errors.length === 0) {
    console.log(`ok ${sha.slice(0, 8)} ${short}`);
  } else {
    failed += 1;
    console.error(`FAIL ${sha.slice(0, 8)} ${short}`);
    for (const error of errors) console.error(`  - ${error}`);
  }
}

if (failed > 0) {
  console.error(`\nCommit-message check failed: ${failed}/${shas.length} commits rejected.`);
  process.exit(1);
}
console.log(`\nCommit-message check passed: ${shas.length}/${shas.length} commits.`);
