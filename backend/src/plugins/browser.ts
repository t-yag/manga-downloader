/**
 * Shared browser launch helper.
 * Integrates puppeteer-extra + stealth plugin and reads settings from DB.
 */

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, LaunchOptions } from "puppeteer";
import { getSettingValue } from "../api/routes/settings.js";
import { logger } from "../logger.js";

puppeteerExtra.use(StealthPlugin());

const log = logger.child({ module: "Browser" });

export interface LaunchBrowserOptions {
  /** Override headless setting (defaults to DB setting `browser.headless`) */
  headless?: boolean;
  /** Override viewport */
  defaultViewport?: { width: number; height: number };
}

/**
 * Launch a browser with stealth plugin enabled.
 * Reads `browser.headless` and `browser.executablePath` from settings,
 * with overrides available via options.
 */
export async function launchBrowser(
  options?: LaunchBrowserOptions
): Promise<Browser> {
  const headless =
    options?.headless ??
    getSettingValue<boolean>("browser.headless") ??
    true;

  const executablePath =
    getSettingValue<string>("browser.executablePath") ||
    process.env.CHROME_EXECUTABLE_PATH ||
    undefined;

  const launchOptions: LaunchOptions = {
    headless,
    defaultViewport: options?.defaultViewport ?? { width: 1280, height: 800 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  log.info(
    `Launching browser (headless=${headless}, stealth=enabled${executablePath ? `, path=${executablePath}` : ""})`
  );

  return puppeteerExtra.launch(launchOptions) as unknown as Browser;
}
