import { spawn } from "node:child_process";
import { Command } from "commander";
import { registerLinkedInCommands } from "./linkedin.js";
import { LoginRequiredError } from "../core/throttle.js";
import { launchPersistentChrome, closeContext } from "../core/browser.js";
import { runLinkedInLogin } from "../providers/linkedin/pages/login.js";

const program = new Command();

program
  .name("supersocial")
  .description("Automation LinkedIn (et X plus tard) via Playwright, stockage markdown local")
  .version("0.1.0");

registerLinkedInCommands(program);

function notifyMac(title: string, message: string): void {
  if (process.platform !== "darwin") return;
  const escape = (s: string) => s.replace(/["\\]/g, "\\$&");
  const script = `display notification "${escape(message)}" with title "${escape(title)}" sound name "Glass"`;
  const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function handleLoginRequired(err: LoginRequiredError): Promise<void> {
  process.stderr.write("\x07");
  notifyMac("supersocial: connexion LinkedIn requise", "Ouverture de la fenêtre de login Chrome.");
  console.error(err.message);
  const context = await launchPersistentChrome({ headless: false });
  try {
    await runLinkedInLogin(context);
    console.error("Session restaurée. Relance la commande précédente.");
  } finally {
    await closeContext(context);
  }
}

program.parseAsync(process.argv).catch(async (err) => {
  if (err instanceof LoginRequiredError) {
    try {
      await handleLoginRequired(err);
    } catch (loginErr) {
      console.error(loginErr instanceof Error ? loginErr.message : loginErr);
    }
    process.exitCode = 1;
    return;
  }
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
