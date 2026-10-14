import noComments from "./no-comments.mjs";
import { promptImports, promptLayout, promptSinks } from "./prompts.mjs";

export default {
  meta: { name: "pr-agent" },
  rules: {
    "no-comments": noComments,
    "prompt-layout": promptLayout,
    "prompt-imports": promptImports,
    "prompt-sinks": promptSinks,
  },
};
