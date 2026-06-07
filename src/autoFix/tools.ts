import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AutoFixWorkspace } from "./workspace.js";

type AutoFixTool<TSchema extends z.ZodType = z.ZodType> = {
  readonly description: string;
  readonly schema: TSchema;
  readonly run: (parsed: z.infer<TSchema>) => Promise<unknown>;
};

function defineAutoFixTool<TSchema extends z.ZodType>(
  tool: AutoFixTool<TSchema>,
): AutoFixTool<TSchema> {
  return tool;
}

type AutoFixSubmitState =
  | { readonly submitted: false }
  | {
      readonly submitted: true;
      readonly outcome: "fixed" | "skipped" | "failed";
      readonly summary: string;
    };

export type MutableAutoFixSubmitState = {
  value: AutoFixSubmitState;
};

function toPiTool(name: string, tool: AutoFixTool): PiTool {
  return {
    name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.schema, { unrepresentable: "any" }) as PiTool["parameters"],
  };
}

function toExecutor(tool: AutoFixTool): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => tool.run(tool.schema.parse(args));
}

export function buildAutoFixTools(
  workspace: AutoFixWorkspace,
  submitState: MutableAutoFixSubmitState,
): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const listFixChangedFiles = defineAutoFixTool({
    description: "List files changed in this pull request from GitHub PR file metadata.",
    schema: z.object({}),
    run: async () => ({
      files: workspace.changedFiles,
    }),
  });

  const readFixFile = defineAutoFixTool({
    description:
      "Read a text file from the server-owned auto-fix checkout. Paths are relative to the repository root.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => ({ path, ...(await workspace.readTextFile(path)) }),
  });

  const searchFixWorkspace = defineAutoFixTool({
    description: "Search the server-owned auto-fix checkout for a literal string.",
    schema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().optional().default(20),
    }),
    run: async ({ query, maxResults }) => workspace.search(query, maxResults),
  });

  const getFixPrDiff = defineAutoFixTool({
    description:
      "Return the original PR unified diff. Pass a path to narrow to one changed file, or omit it for all available patches.",
    schema: z.object({ path: z.string().min(1).optional() }),
    run: async ({ path }) => ({ path, diff: await workspace.getPrDiff(path) }),
  });

  const editFixFile = defineAutoFixTool({
    description:
      "Replace the first exact oldText occurrence in a text file in the server-owned auto-fix checkout.",
    schema: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
    }),
    run: async ({ path, oldText, newText }) => {
      await workspace.editTextFile(path, oldText, newText);
      return { ok: true, path };
    },
  });

  const writeFixFile = defineAutoFixTool({
    description:
      "Write a complete text file in the server-owned auto-fix checkout. Creates parent directories.",
    schema: z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    run: async ({ path, content }) => {
      await workspace.writeTextFile(path, content);
      return { ok: true, path };
    },
  });

  const deleteFixPath = defineAutoFixTool({
    description:
      "Delete a file or directory in the server-owned auto-fix checkout. Paths are relative to the repository root.",
    schema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      await workspace.deletePath(path);
      return { ok: true, path };
    },
  });

  const getFixWorktreeDiff = defineAutoFixTool({
    description: "Return the current server-owned auto-fix checkout diff.",
    schema: z.object({}),
    run: async () => ({ diff: await workspace.getWorktreeDiff() }),
  });

  const submitAutoFixResult = defineAutoFixTool({
    description:
      "Submit the auto-fix result for this target group. Use fixed only after editing files, skipped when no valid fix is needed, or failed when blocked.",
    schema: z.object({
      outcome: z.enum(["fixed", "skipped", "failed"]),
      summary: z.string().min(1).max(2000),
    }),
    run: async ({ outcome, summary }) => {
      submitState.value = { submitted: true, outcome, summary };
      return { ok: true, outcome };
    },
  });

  const tools = {
    listFixChangedFiles,
    readFixFile,
    searchFixWorkspace,
    getFixPrDiff,
    editFixFile,
    writeFixFile,
    deleteFixPath,
    getFixWorktreeDiff,
    submitAutoFixResult,
  };

  return {
    piTools: Object.entries(tools).map(([name, tool]) => toPiTool(name, tool)),
    executors: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, toExecutor(tool)]),
    ),
  };
}
