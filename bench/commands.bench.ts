import { bench, describe } from "vitest";
import { parseAskQuestion, parseAskQuestionResult } from "../src/commands/parseAskQuestion.js";
import { parseSlashCommand } from "../src/commands/parseSlashCommand.js";

const slashBody = [
  "",
  "   ",
  "/review please take a careful look at the authentication changes",
  "and let me know if anything looks off.",
].join("\n");

const askBody = [
  '/ask "What is the time complexity of the new diff indexing routine, and',
  'does it allocate proportionally to the number of hunks?"',
].join("\n");

const plainBody = [
  "This is a regular pull request comment without any slash command.",
  "It spans multiple lines and includes prose that the parser must scan",
  "before deciding there is no command to handle here.",
].join("\n");

describe("command parsing", () => {
  bench("parseSlashCommand - command", () => {
    parseSlashCommand(slashBody);
  });

  bench("parseSlashCommand - plain comment", () => {
    parseSlashCommand(plainBody);
  });

  bench("parseAskQuestion - quoted question", () => {
    parseAskQuestion(askBody);
  });

  bench("parseAskQuestionResult - plain comment", () => {
    parseAskQuestionResult(plainBody);
  });
});
