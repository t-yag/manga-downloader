/**
 * DMMBooks authentication provider.
 * Supports three login methods:
 *   1. credentials — auto-fill email/password via headless Puppeteer (reCAPTCHA v3 + Stealth)
 *   2. browser    — open accounts.dmm.com in non-headless browser for manual login
 *   3. cookie_import — import cookies via API
 *
 * Session validation uses the BFF auth endpoint:
 *   GET /ajax/bff/users/auth/ → { is_login: boolean }
 */

import fs from "fs/promises";
import { logger } from "../../logger.js";
import { launchBrowser } from "../browser.js";
import type {
  AuthProvider,
  CredentialField,
  SessionData,
} from "../base.js";

const log = logger.child({ module: "DmmBooksAuth" });

const DMM_LOGIN_URL = "https://accounts.dmm.com/service/login/password";
const DMM_BOOKS_URL = "https://book.dmm.com/";
const AUTH_CHECK_URL = "https://book.dmm.com/ajax/bff/users/auth/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/** Timeout for manual login (5 minutes) */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class DmmBooksAuth implements AuthProvider {
  private session: SessionData | null = null;

  getCredentialFields(): CredentialField[] {
    return [
      { key: "email", label: "メールアドレス", type: "email", required: true },
      { key: "password", label: "パスワード", type: "password", required: true },
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
      await page.goto(DMM_LOGIN_URL, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      if (hasCredentials) {
        // Auto-fill credentials
        await page.waitForSelector('input[name="login_id"]', { timeout: 10000 });
        await page.type('input[name="login_id"]', email, { delay: 80 });
        await page.type('input[name="password"]', password, { delay: 80 });

        // Click submit button
        const submitButton = await page.$('button[type="submit"]');
        if (!submitButton) {
          throw new Error("Login submit button not found");
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
      }

      // Wait for login_session_id cookie (manual login or after auto-fill)
      log.info("Waiting for login to complete...");

      const cdpClient = await page.createCDPSession();
      const hasAuthCookies = async (): Promise<boolean> => {
        const { cookies } = await cdpClient.send("Network.getAllCookies");
        return cookies.some(
          (c: any) =>
            c.name === "login_session_id" && c.domain.includes("dmm.com"),
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

      // Navigate to book.dmm.com to capture all relevant cookies
      if (!page.url().includes("book.dmm.com")) {
        await page.goto(DMM_BOOKS_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      }

      // Wait for page to settle
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {
        log.warn("Network idle timeout, proceeding with cookie capture...");
      });
      await new Promise((r) => setTimeout(r, 2000));

      // Use CDP to get ALL cookies across all domains
      const client = await page.createCDPSession();
      const { cookies } = await client.send("Network.getAllCookies");
      await client.detach();

      // Keep only .dmm.com cookies
      const dmmCookies = cookies.filter(
        (c: any) => c.domain.includes("dmm.com"),
      );

      if (dmmCookies.length === 0) {
        throw new Error("No DMM cookies captured after login");
      }

      this.session = {
        cookies: dmmCookies.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
        })),
      };

      log.info(`Login successful (${dmmCookies.length} cookies captured)`);
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

    log.info("Validating session via BFF auth API...");

    const cookieString = this.session.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    try {
      const response = await fetch(AUTH_CHECK_URL, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Cookie: cookieString,
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        log.warn(`Auth check failed: HTTP ${response.status}`);
        return false;
      }

      const data = (await response.json()) as { is_login: boolean };
      const valid = data.is_login === true;

      log.info(`Session ${valid ? "valid" : "invalid"} (is_login=${data.is_login})`);
      return valid;
    } catch (error: any) {
      log.error(`Session validation error: ${error.message}`);
      return false;
    }
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
