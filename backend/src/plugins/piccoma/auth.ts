import { Browser } from "puppeteer";
import fs from "fs/promises";
import { logger } from "../../logger.js";
import { launchBrowser } from "../browser.js";
import type {
  AuthProvider,
  CredentialField,
  SessionData,
} from "../base.js";

const log = logger.child({ module: "PiccomaAuth" });

export class PiccomaAuth implements AuthProvider {
  private session: SessionData | null = null;

  getCredentialFields(): CredentialField[] {
    return [
      { key: "email", label: "Email", type: "email", required: true },
      { key: "password", label: "Password", type: "password", required: true },
    ];
  }

  async login(credentials: Record<string, string>): Promise<boolean> {
    const { email, password } = credentials;
    if (!email || !password) {
      throw new Error("Email and password are required");
    }

    log.info("Logging in with browser...");

    const browser: Browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    try {
      await page.goto("https://piccoma.com/web/acc/email/signin", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      await page.waitForSelector('input[type="email"]', { timeout: 10000 });
      await page.type('input[type="email"]', email, { delay: 80 });
      await page.type('input[type="password"]', password, { delay: 80 });

      const submitBtn = await page.$('input[type="submit"]');
      if (!submitBtn) throw new Error("Submit button not found");
      await submitBtn.click();

      try {
        await page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
      } catch {
        // SPA navigation may not trigger full navigation
      }

      const finalUrl = page.url();
      if (finalUrl.includes("/signin") || finalUrl.includes("/login")) {
        throw new Error("Login failed: still on login page");
      }

      // Wait for tracking scripts to set their cookies
      await new Promise((r) => setTimeout(r, 3000));

      // Navigate to a page to ensure all cookies are captured
      await page.goto("https://piccoma.com/web/", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await new Promise((r) => setTimeout(r, 2000));

      const cookies = await page.cookies();
      this.session = {
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
        })),
      };

      log.info(`Login successful (${cookies.length} cookies)`);
      return true;
    } catch (error: any) {
      log.error(`Login failed: ${error.message}`);
      return false;
    } finally {
      await browser.close();
    }
  }

  async validateSession(): Promise<boolean> {
    if (!this.session?.cookies?.length) {
      log.info("No session to validate");
      return false;
    }

    const pksid = this.session.cookies.find((c) => c.name === "pksid");
    if (!pksid) {
      log.warn("Session invalid: pksid cookie not found");
      return false;
    }

    const now = Date.now() / 1000;
    if (pksid.expires && pksid.expires > 0 && pksid.expires < now) {
      log.warn("Session invalid: pksid expired");
      return false;
    }

    log.info("Session valid (pksid present, not expired)");
    return true;
  }

  getSession(): SessionData | null {
    return this.session;
  }

  async loadSession(cookiePath: string): Promise<boolean> {
    try {
      const data = await fs.readFile(cookiePath, "utf-8");
      const cookies = JSON.parse(data);
      this.session = { cookies };
      log.info(`Session loaded: ${cookies.length} cookies`);
      return true;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        log.info("No saved session found");
      } else {
        log.error(`Failed to load session: ${error.message}`);
      }
      return false;
    }
  }

  async saveSession(cookiePath: string): Promise<void> {
    if (!this.session?.cookies?.length) {
      log.warn("No session to save");
      return;
    }

    await fs.writeFile(
      cookiePath,
      JSON.stringify(this.session.cookies, null, 2),
      "utf-8",
    );
    log.info(`Session saved: ${cookiePath}`);
  }
}
