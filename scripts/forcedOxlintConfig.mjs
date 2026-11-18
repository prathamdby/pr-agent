import fs from "node:fs";
import path from "node:path";

const PLUGIN_RULE_PREFIXES = ["pr-agent/", "landmines-"];

function withoutPluginRules(rules) {
  return Object.fromEntries(
    Object.entries(rules).filter(
      ([name]) => !PLUGIN_RULE_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  );
}

export function forcedOxlintConfig(root, rule) {
  const config = JSON.parse(fs.readFileSync(path.join(root, ".oxlintrc.json"), "utf8"));
  delete config.jsPlugins;
  if (config.rules) config.rules = withoutPluginRules(config.rules);
  for (const override of config.overrides ?? []) {
    if (!override.rules) continue;
    override.rules = withoutPluginRules(override.rules);
    delete override.rules[rule];
  }
  return config;
}
