#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const entry = resolve(projectRoot, "src/cli/index.ts");
const tsx = resolve(projectRoot, "node_modules/.bin/tsx");

const child = spawn(tsx, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: projectRoot,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
