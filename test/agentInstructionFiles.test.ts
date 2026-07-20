import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAgentInstructionFiles,
  renderAgentInstructionFilesBlock,
} from "../src/review/agentInstructionFiles.js";
import { MAX_AGENT_INSTRUCTION_FILE_BYTES } from "../src/settings/reviewConstants.js";

async function checkoutWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-instruction-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content, "utf8");
  }
  return root;
}

describe("loadAgentInstructionFiles", () => {
  it("returns absent when none of the root files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-instruction-absent-"));
    await expect(loadAgentInstructionFiles(root)).resolves.toEqual({ kind: "absent" });
  });

  it("loads AGENTS.md, CLAUDE.md, and GEMINI.md in fixed order", async () => {
    const root = await checkoutWith({
      "GEMINI.md": "Gemini rules.",
      "AGENTS.md": "Agents rules.\n\nUse nub.",
      "CLAUDE.md": "@AGENTS.md",
      "README.md": "ignored",
    });
    const result = await loadAgentInstructionFiles(root);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.files.map((file) => file.filename)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
    ]);
    expect(result.files[0].body).toContain("Use nub.");
    expect(result.files[1].body).toBe("@AGENTS.md");
  });

  it("skips empty files and still returns ok for remaining files", async () => {
    const root = await checkoutWith({
      "AGENTS.md": "   \n",
      "CLAUDE.md": "Keep going.",
    });
    const result = await loadAgentInstructionFiles(root);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.files).toEqual([{ filename: "CLAUDE.md", body: "Keep going." }]);
  });

  it("skips files over the per-file byte cap", async () => {
    const root = await checkoutWith({
      "AGENTS.md": "x".repeat(MAX_AGENT_INSTRUCTION_FILE_BYTES + 1),
      "CLAUDE.md": "small",
    });
    const result = await loadAgentInstructionFiles(root);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.files).toEqual([{ filename: "CLAUDE.md", body: "small" }]);
  });

  it("stops accepting further files when aggregate budget would be exceeded", async () => {
    const root = await checkoutWith({
      "AGENTS.md": "a".repeat(40),
      "CLAUDE.md": "b".repeat(40),
    });
    const result = await loadAgentInstructionFiles(root, 50);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe("AGENTS.md");
  });

  it("ignores nested AGENTS.md outside the checkout root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-instruction-nested-"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "AGENTS.md"), "nested", "utf8");
    await expect(loadAgentInstructionFiles(root)).resolves.toEqual({ kind: "absent" });
  });
});

describe("renderAgentInstructionFilesBlock", () => {
  it("returns empty string for no files", () => {
    expect(renderAgentInstructionFilesBlock({ files: [] })).toBe("");
  });

  it("preserves newlines and names each file", () => {
    const block = renderAgentInstructionFilesBlock({
      files: [
        { filename: "AGENTS.md", body: "Line one.\nLine two." },
        { filename: "CLAUDE.md", body: "@AGENTS.md" },
      ],
    });
    expect(block).toContain("Trusted context (agent instruction files):");
    expect(block).toContain("### File `AGENTS.md`");
    expect(block).toContain("Line one.\nLine two.");
    expect(block).toContain("### File `CLAUDE.md`");
    expect(block).toContain("@AGENTS.md");
    expect(block).not.toContain("Line one. Line two.");
  });
});
