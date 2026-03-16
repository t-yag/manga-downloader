import puppeteer from "puppeteer";

type LaunchOptions = Parameters<typeof puppeteer.launch>[0];

export function launchOptions(): LaunchOptions {
  const opts: LaunchOptions = {
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };
  if (process.env.CHROME_EXECUTABLE_PATH) {
    opts.executablePath = process.env.CHROME_EXECUTABLE_PATH;
  }
  return opts;
}
