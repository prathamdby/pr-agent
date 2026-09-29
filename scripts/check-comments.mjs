import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rgCount(pattern, dir, fixed) {
  const out = execSync(
    `rg --no-messages -o --no-filename ${fixed ? "--fixed-strings" : ""} -i -e ${JSON.stringify(pattern)} ${JSON.stringify(path.join(ROOT, dir))} || true`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  return out.split("\n").filter((line) => line.length > 0).length;
}

// Justification markers: narration an agent writes instead of encoding the
// lesson. Why-comments that state a non-obvious constraint the code cannot
// show stay allowed (see AGENTS.md); these markers are the shapes that
// confess the constraint was NOT encoded.
const MARKERS = ["workaround", "just in case", "for now", "do not remove", "TODO remove"];

let failed = false;
for (const marker of MARKERS) {
  const count = rgCount(marker, "src", true);
  const status = count === 0 ? "ok" : "FAIL";
  console.log(`  justification:${marker}  src/**  ${count}  ${status}`);
  if (count > 0) {
    failed = true;
    console.log(`FAIL src/** contains "${marker}" — encode the lesson or drop the narration.`);
  }
}
if (failed) process.exit(1);
console.log("Comment check passed.");
