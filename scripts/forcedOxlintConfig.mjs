import fs from "node:fs";
import path from "node:path";

const LOCAL_RULE_PREFIX = "pr-agent/";

function withoutLocalRules(rules) {
  return Object.fromEntries(
    Object.entries(rules).filter(([name]) => !name.startsWith(LOCAL_RULE_PREFIX)),
  );
}

export function forcedOxlintConfig(root, rule) {
  const config = JSON.parse(fs.readFileSync(path.join(root, ".oxlintrc.json"), "utf8"));
  delete config.jsPlugins;
  if (config.rules) config.rules = withoutLocalRules(config.rules);
  for (const override of config.overrides ?? []) {
    if (!override.rules) continue;
    override.rules = withoutLocalRules(override.rules);
    delete override.rules[rule];
  }
  return config;
}
