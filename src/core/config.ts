import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, "..", "..");

loadDotenv({ path: resolve(projectRoot, ".env"), quiet: true });

export type ThrottleProfile = "conservative" | "normal" | "aggressive";

export interface Config {
  timezone: string;
  throttleProfile: ThrottleProfile;
  chromeProfileDir: string;
  headless: boolean;
  dataDir: string;
  stateDir: string;
}

export const config: Config = {
  timezone: process.env.SUPERSOCIAL_TIMEZONE ?? "Europe/Paris",
  throttleProfile: (process.env.SUPERSOCIAL_THROTTLE_PROFILE as ThrottleProfile) ?? "conservative",
  chromeProfileDir: resolve(projectRoot, process.env.SUPERSOCIAL_CHROME_PROFILE_DIR ?? ".chrome-profile"),
  headless: process.env.SUPERSOCIAL_HEADLESS === "true",
  dataDir: resolve(projectRoot, "data"),
  stateDir: resolve(projectRoot, "data", ".state"),
};
