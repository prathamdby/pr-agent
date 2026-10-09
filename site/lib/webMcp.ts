import { AGENT_RESOURCES } from "./agentResources.js";
import { PAGE_SECTIONS, WEB_MCP_TOOLS } from "./agentTools.js";

/**
 * Inline script for the landing page.
 *
 * It runs from the HTML, not the app bundle, so a browser agent sees the tools on first parse.
 * `document.modelContext` is preferred. Older Chrome builds expose the same API on
 * `navigator.modelContext`. The signal unregisters the tools when the page is discarded.
 */
export function renderWebMcpScript(): string {
  const payload = JSON.stringify({
    tools: WEB_MCP_TOOLS,
    sections: PAGE_SECTIONS,
    resources: AGENT_RESOURCES.map((resource) => ({
      path: resource.path,
      description: resource.description,
    })),
  }).replaceAll("<", "\\u003c");

  return `(function () {
  var root = document.modelContext || navigator.modelContext;
  if (!root || typeof root.registerTool !== "function") return;
  var controller = new AbortController();
  addEventListener("pagehide", function () { controller.abort(); }, { once: true });
  var config = ${payload};
  function textResult(text) {
    return { text: text };
  }
  var runners = {
    query_pr_agent: function (input) {
      var query = input && typeof input.query === "string" ? input.query : "";
      return fetch("/llms?query=" + encodeURIComponent(query), { signal: controller.signal })
        .then(function (response) { return response.text(); })
        .then(textResult);
    },
    list_site_resources: function () {
      var lines = config.resources.map(function (resource) {
        return resource.path + ": " + resource.description;
      });
      return Promise.resolve(textResult(lines.join("\\n")));
    },
    open_section: function (input) {
      var section = input && typeof input.section === "string" ? input.section : "";
      if (config.sections.indexOf(section) === -1) {
        return Promise.resolve(textResult("Unknown section. Use one of: " + config.sections.join(", ")));
      }
      location.hash = section;
      var node = document.getElementById(section);
      if (node && typeof node.scrollIntoView === "function") node.scrollIntoView();
      return Promise.resolve(textResult("Opened #" + section));
    }
  };
  config.tools.forEach(function (tool) {
    var run = runners[tool.name];
    if (typeof run !== "function") return;
    Promise.resolve(root.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: function (input) { return run(input); }
    }, { signal: controller.signal })).catch(function () {});
  });
})();
`;
}
