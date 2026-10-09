/**
 * Tool definitions shared by the read-only MCP server and the WebMCP page script.
 *
 * The page script is serialized into HTML, so this module stays free of Node builtins.
 */

export const QUERY_TOOL_NAME = "query_pr_agent";
export const LIST_TOOL_NAME = "list_site_resources";
export const OPEN_SECTION_TOOL_NAME = "open_section";

/** Section ids on the landing page. `open_section` refuses anything else. */
export const PAGE_SECTIONS = [
  "features",
  "examples",
  "capabilities",
  "pricing",
  "faq",
  "usage",
] as const;

export type PageSection = (typeof PAGE_SECTIONS)[number];

type JsonSchema = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
};

export type AgentToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
};

const QUERY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Question about PR Agent. 300 characters at most.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

const LIST_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const OPEN_SECTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    section: {
      type: "string",
      description: "Landing page section id.",
      enum: PAGE_SECTIONS,
    },
  },
  required: ["section"],
  additionalProperties: false,
};

export const QUERY_TOOL: AgentToolDefinition = {
  name: QUERY_TOOL_NAME,
  description:
    "Answer a question about PR Agent from this site's profile. Broad values such as all or profile return the whole profile.",
  inputSchema: QUERY_SCHEMA,
};

export const LIST_TOOL: AgentToolDefinition = {
  name: LIST_TOOL_NAME,
  description:
    "List the machine-readable URLs this site publishes, with a one-line description of each.",
  inputSchema: LIST_SCHEMA,
};

export const OPEN_SECTION_TOOL: AgentToolDefinition = {
  name: OPEN_SECTION_TOOL_NAME,
  description: `Scroll the landing page to a section: ${PAGE_SECTIONS.join(", ")}.`,
  inputSchema: OPEN_SECTION_SCHEMA,
};

/** Tools a remote MCP client can call. `open_section` needs the page, so it stays in WebMCP. */
export const MCP_TOOLS: readonly AgentToolDefinition[] = [QUERY_TOOL, LIST_TOOL];

/** Tools the landing page registers for a browser agent. */
export const WEB_MCP_TOOLS: readonly AgentToolDefinition[] = [
  QUERY_TOOL,
  LIST_TOOL,
  OPEN_SECTION_TOOL,
];
