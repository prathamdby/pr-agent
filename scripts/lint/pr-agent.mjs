import noComments from "./no-comments.mjs";
import { promptImports, promptLayout } from "./prompts.mjs";

export default {
  meta: { name: "pr-agent" },
  rules: {
    "no-comments": noComments,
    "prompt-layout": promptLayout,
    "prompt-imports": promptImports,
  },
};
