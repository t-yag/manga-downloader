/**
 * BookLive authentication provider.
 * Supports three login methods:
 *   1. credentials — auto-fill email/password via Puppeteer (reCAPTCHA may require manual solve)
 *   2. browser    — open booklive.jp in non-headless browser for manual login
 *   3. cookie_import — import cookies via API
 */

import fs from "fs/promises";
import { logger } from "../../logger.js";
import { launchBrowser } from "../browser.js";
import type {
  AuthProvider,
  CredentialField,
  SessionData,
} from "../base.js";

const log = logger.child({ module: "BookLiveAuth" });

const BOOKLIVE_LOGIN_URL = "https://booklive.jp/login";

/** Timeout for manual login (5 minutes) */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class BookLiveAuth implements AuthProvider {
  private session: SessionData | null = null;

  getCredentialFields(): CredentialField[] {
    return [
      {
        key: "email",
        label: "メールアドレス",
        type: "email",
        required: true,
      },
      {
        key: "password",
        label: "パスワード",
        type: "password",
        required: true,
      },
    ];
  }

  async login(credentials: Record<string, string>): Promise<boolean> {
    const { email, password } = credentials;
    const hasCredentials = email && password;

    log.info(
      hasCredentials
        ? "Logging in with credentials..."
        : "Opening browser for manual login...",
    );

    const browser = await launchBrowser({ headless: hasCredentials ? true : false });
    const page = await browser.newPage();
    page.setDefaultTimeout(LOGIN_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(LOGIN_TIMEOUT_MS);

    try {
      // Navigate to login page
      await page.goto(BOOKLIVE_LOGIN_URL, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      if (hasCredentials) {
        // Wait for login form
        await page.waitForSelector('input[name="mail_addr"]', { timeout: 30000 });

        // Enter credentials
        await page.type('input[name="mail_addr"]', email, { delay: 80 });
        await page.type('input[name="pswd"]', password, { delay: 80 });

        // Click login button
        const submitButton = await page.$("#login_button_1");
        if (!submitButton) {
          throw new Error("Login button not found");
        }

        await submitButton.click();

        try {
          await page.waitForNavigation({
            waitUntil: "networkidle2",
            timeout: 15000,
          });
        } catch {
          // Navigation timeout can be ignored
        }

        // Handle reCAPTCHA if triggered
        if (page.url().includes("/login/recaptcha")) {
          log.info("reCAPTCHA detected - waiting for manual solution (up to 120s)...");
          await page.waitForFunction(
            () => !window.location.href.includes("/login/recaptcha"),
            { timeout: 120000 }
          );
          log.info("reCAPTCHA solved");
        }
      }

      // Wait for auth cookies (manual login or after auto-fill)
      log.info("Waiting for login to complete...");

      const cdpClient = await page.createCDPSession();
      const hasAuthCookies = async (): Promise<boolean> => {
        const { cookies } = await cdpClient.send("Network.getAllCookies");
        return cookies.some(
          (c: any) =>
            c.name === "BL_MEM" && c.domain.includes("booklive.jp"),
        );
      };

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await hasAuthCookies()) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      const loggedIn = await hasAuthCookies();
      await cdpClient.detach();

      if (!loggedIn) {
        throw new Error("Login timed out: auth cookies not detected");
      }

      log.info(`Login detected via auth cookies, current URL: ${page.url()}`);

      // Wait for page to settle
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {
        log.warn("Network idle timeout, proceeding with cookie capture...");
      });
      await new Promise((r) => setTimeout(r, 2000));

      // Use CDP to get ALL cookies across all domains
      const client = await page.createCDPSession();
      const { cookies } = await client.send("Network.getAllCookies");
      await client.detach();

      // Keep only .booklive.jp cookies
      const blCookies = cookies.filter(
        (c: any) => c.domain.includes("booklive.jp"),
      );

      if (blCookies.length === 0) {
        throw new Error("No BookLive cookies captured after login");
      }

      this.session = {
        cookies: blCookies.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
        })),
      };

      log.info(`Login successful (${blCookies.length} cookies captured)`);
      return true;
    } catch (error: any) {
      log.error(`Login failed: ${error.message}`);
      return false;
    } finally {
      await browser.close();
    }
  }

  async validateSession(): Promise<boolean> {
    if (!this.session || !this.session.cookies || this.session.cookies.length === 0) {
      log.info("No session to validate");
      return false;
    }

    log.info("Validating session...");

    // Check for essential auth cookie
    const sessionCookie = this.session.cookies.find((c) => c.name === "PHPSESSID");
    if (!sessionCookie) {
      log.warn("Session invalid: PHPSESSID cookie not found");
      return false;
    }

    // Check cookie expiry
    const now = Date.now() / 1000;
    if (sessionCookie.expires && sessionCookie.expires > 0 && sessionCookie.expires < now) {
      log.warn("Session invalid: PHPSESSID cookie expired");
      return false;
    }

    log.info("Session valid");
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
    if (!this.session || !this.session.cookies || this.session.cookies.length === 0) {
      log.warn("No session to save");
      return;
    }

    try {
      await fs.writeFile(
        cookiePath,
        JSON.stringify(this.session.cookies, null, 2),
        "utf-8"
      );
      log.info(`Session saved: ${cookiePath}`);
    } catch (error: any) {
      log.error(`Failed to save session: ${error.message}`);
      throw error;
    }
  }
}
