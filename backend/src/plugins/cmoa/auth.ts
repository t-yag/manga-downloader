import { Browser, Page } from "puppeteer";
import axios from "axios";
import fs from "fs/promises";
import { logger } from "../../logger.js";
import { launchBrowser } from "../browser.js";
import type {
  AuthProvider,
  CredentialField,
  SessionData,
  CookieData,
} from "../base.js";

const log = logger.child({ module: "CmoaAuth" });

/**
 * Cmoa authentication provider
 * Handles Puppeteer-based login, cookie persistence, and session validation
 */
export class CmoaAuth implements AuthProvider {
  private browser: Browser | null = null;
  private session: SessionData | null = null;

  getCredentialFields(): CredentialField[] {
    return [
      {
        key: "email",
        label: "Email",
        type: "email",
        required: true,
      },
      {
        key: "password",
        label: "Password",
        type: "password",
        required: true,
      },
    ];
  }

  async login(credentials: Record<string, string>): Promise<boolean> {
    const { email, password } = credentials;

    if (!email || !password) {
      throw new Error("Email and password are required");
    }

    log.info("Logging in with browser...");

    this.browser = await launchBrowser();
    const page = await this.browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    try {
      // Navigate to login page
      await page.goto("https://www.cmoa.jp/auth/login/", {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      // Wait for input fields
      await page.waitForSelector('input[name="email"]', { timeout: 30000 });

      // Enter credentials
      await page.type('input[name="email"]', email, { delay: 100 });
      await page.type('input[name="password"]', password, { delay: 100 });

      // Submit form directly (the #submitButton triggers an async API call
      // that doesn't navigate; form.submit() goes through the OpenID POST flow)
      const [response] = await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
        page.evaluate(() => {
          const form = document.querySelector("form") as HTMLFormElement;
          if (!form) throw new Error("Login form not found");
          form.submit();
        }),
      ]);

      // Get cookies
      const cookies = await page.cookies();
      const finalUrl = page.url();

      // Verify login success
      if (!finalUrl.includes("www.cmoa.jp") || finalUrl.includes("/auth/login")) {
        throw new Error("Login failed: not redirected to correct page");
      }

      // Convert Puppeteer cookies to SessionData format
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
      if (page) {
        try {
          await page.close();
        } catch (e) {
          // Ignore page close errors
        }
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    }
  }

  async validateSession(): Promise<boolean> {
    if (!this.session || !this.session.cookies || this.session.cookies.length === 0) {
      log.info("No session to validate");
      return false;
    }

    log.info("Validating session...");

    // Check cookie expiry only (no API call to avoid rate limiting)
    const now = Date.now() / 1000;
    const authCookie = this.session.cookies.find(
      (c) => c.name === "_ssid_" || c.name === "_cmoa_login_session_token_"
    );

    if (!authCookie) {
      log.warn("Session invalid: auth cookie not found");
      return false;
    }

    if (authCookie.expires && authCookie.expires > 0 && authCookie.expires < now) {
      log.warn("Session invalid: auth cookie expired");
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
