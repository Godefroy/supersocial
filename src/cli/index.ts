import { Command } from "commander";
import { registerLinkedInCommands } from "./linkedin.js";

const program = new Command();

program
  .name("supersocial")
  .description("Automation LinkedIn (et X plus tard) via Playwright, stockage markdown local")
  .version("0.1.0");

registerLinkedInCommands(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
