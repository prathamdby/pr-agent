import type { Context, Message } from "@earendil-works/pi-ai";

const CURSOR_APPROX_CHARS_PER_TOKEN = 4;

function formatMessageContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[image omitted from transcript]";
      if (block.type === "toolCall") {
        return `Tool call (${block.name}, id ${block.id}): ${JSON.stringify(block.arguments)}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatMessage(message: Message): string {
  switch (message.role) {
    case "user":
      return `User:\n${formatMessageContent(message.content)}`;
    case "assistant":
      return `Assistant:\n${formatMessageContent(message.content)}`;
    case "toolResult": {
      const text = message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
      const prefix = message.isError ? "Tool error" : "Tool result";
      return `${prefix} (${message.toolName}):\n${text}`;
    }
    default:
      return "";
  }
}

export function buildCursorPrompt(context: Context): {
  text: string;
  inputChars: number;
} {
  const sections: string[] = [];
  if (context.systemPrompt?.trim()) {
    sections.push(`System:\n${context.systemPrompt.trim()}`);
  }
  for (const message of context.messages) {
    const formatted = formatMessage(message);
    if (formatted.trim()) sections.push(formatted);
  }
  const text = sections.join("\n\n");
  return { text, inputChars: text.length };
}

export function approximateCursorUsage(
  inputChars: number,
  outputChars: number,
): {
  input: number;
  output: number;
  totalTokens: number;
} {
  const input = Math.ceil(inputChars / CURSOR_APPROX_CHARS_PER_TOKEN);
  const output = Math.ceil(outputChars / CURSOR_APPROX_CHARS_PER_TOKEN);
  return { input, output, totalTokens: input + output };
}
