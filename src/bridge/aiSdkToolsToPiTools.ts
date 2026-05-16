import type { Tool as AiSdkTool } from "ai";
import { Type } from "@earendil-works/pi-ai";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { ToolExecutionOptions } from "ai";
import { z } from "zod";

/** More descriptive than an empty object schema; still permissive for zod-backed SDK tools. */
const looseParams = Type.Record(Type.String(), Type.Any());

function isExecutableTool(t: unknown): t is AiSdkTool<any, any> {
	return typeof t === "object" && t !== null && typeof (t as AiSdkTool<any, any>).execute === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isZodSchema(value: unknown): value is z.ZodType {
	return isRecord(value) && "_zod" in value;
}

function isJsonSchema(value: unknown): value is PiTool["parameters"] {
	return isRecord(value) && typeof value.type === "string";
}

function toolParameters(t: AiSdkTool<any, any>): PiTool["parameters"] {
	const inputSchema = (t as AiSdkTool<any, any> & { inputSchema?: unknown; parameters?: unknown }).inputSchema ?? (t as AiSdkTool<any, any> & { parameters?: unknown }).parameters;

	if (isZodSchema(inputSchema)) {
		return z.toJSONSchema(inputSchema, { unrepresentable: "any" }) as PiTool["parameters"];
	}

	if (isJsonSchema(inputSchema)) {
		return inputSchema;
	}

	return looseParams;
}

function formatToolExecuteError(toolName: string, err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	const hint =
		/workflow|use step|durable|approval required/i.test(msg) ?
			" Hint: this GitHub tool may expect the Vercel Workflow / AI SDK approval runtime; running plain Node may not satisfy it."
		:	"";
	return `Error executing ${toolName}: ${msg}${hint}`;
}

/**
 * Maps partial GitHub AI SDK tools into pi-ai `Tool[]` and a single executor that forwards to AI SDK `execute`.
 */
export function bridgeGithubToolsToPi(ghTools: Record<string, unknown>) {
	const entries = Object.entries(ghTools).filter(([, v]) => isExecutableTool(v)) as [string, AiSdkTool<any, any>][];

	const piTools: PiTool[] = entries.map(([name, t]) => ({
		name,
		description: typeof t.description === "string" ? t.description : `GitHub tool: ${name}`,
		parameters: toolParameters(t),
	}));

	const byName = Object.fromEntries(entries) as Record<string, AiSdkTool<any, any>>;

	async function executeTool(name: string, args: Record<string, unknown>, toolCallId: string): Promise<unknown> {
		const tool = byName[name];
		if (!tool?.execute) {
			throw new Error(`Unknown or non-executable tool: ${name}`);
		}
		const options: ToolExecutionOptions = {
			toolCallId,
			messages: [],
		};
		try {
			return await tool.execute(args as never, options);
		} catch (e) {
			throw new Error(formatToolExecuteError(name, e));
		}
	}

	return { piTools, executeTool };
}
