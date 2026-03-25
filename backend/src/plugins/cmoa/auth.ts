import fs from "fs/promises";
import { logger } from "../../logger.js";
import { launchBrowser } from "../browser.js";
import type {
  AuthProvider,
  CredentialField,
  SessionData,
} from "../base.js";

const log = logger.child({ module: "CmoaAuth" });

const CMOA_LOGIN_URL = "https://www.cmoa.jp/auth/login/";

/** Timeout for manual login (5 minutes) */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Cmoa authentication provider
 * Supports three login methods:
 *   1. credentials — auto-fill email/password via headless Puppeteer
 *   2. browser    — open cmoa.jp in non-headless browser for manual login
 *   3. cookie_import — import cookies via API
 */
export class CmoaAuth implements AuthProvider {
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
      await page.goto(CMOA_LOGIN_URL, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      if (hasCredentials) {
        // Wait for input fields
        await page.waitForSelector('input[name="email"]', { timeout: 30000 });

        // Enter credentials
        await page.type('input[name="email"]', email, { delay: 100 });
        await page.type('input[name="password"]', password, { delay: 100 });

        // Submit form directly (the #submitButton triggers an async API call
        // that doesn't navigate; form.submit() goes through the OpenID POST flow)
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
          page.evaluate(() => {
            const form = document.querySelector("form") as HTMLFormElement;
            if (!form) throw new Error("Login form not found");
            form.submit();
          }),
        ]);
      }

      // Wait for auth cookies (manual login or after auto-fill)
      log.info("Waiting for login to complete...");

      const cdpClient = await page.createCDPSession();
      const hasAuthCookies = async (): Promise<boolean> => {
        const { cookies } = await cdpClient.send("Network.getAllCookies");
        return cookies.some(
          (c: any) =>
            (c.name === "_ssid_" || c.name === "_cmoa_login_session_token_") &&
            c.domain.includes("cmoa.jp"),
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

      // Keep only .cmoa.jp cookies
      const cmoaCookies = cookies.filter(
        (c: any) => c.domain.includes("cmoa.jp"),
      );

      if (cmoaCookies.length === 0) {
        throw new Error("No cmoa cookies captured after login");
      }

      this.session = {
        cookies: cmoaCookies.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
        })),
      };

      log.info(`Login successful (${cmoaCookies.length} cookies captured)`);
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
