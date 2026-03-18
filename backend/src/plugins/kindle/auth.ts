import fs from "fs/promises";
import { logger } from "../../logger.js";
import { launchBrowser } from "../browser.js";
import type {
  AuthProvider,
  CredentialField,
  SessionData,
} from "../base.js";

const log = logger.child({ module: "KindleAuth" });

const AMAZON_LOGIN_URL =
  "https://www.amazon.co.jp/ap/signin?openid.pape.max_auth_age=1209600&openid.return_to=https%3A%2F%2Fread.amazon.co.jp%2Fkindle-library&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=amzn_kindle_mykindle_jp&openid.mode=checkid_setup&language=ja_JP&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&pageId=amzn_kindle_mykindle_jp&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0";

const KINDLE_LIBRARY_URL = "https://read.amazon.co.jp/kindle-library";

/** Timeout for manual login (5 minutes) */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class KindleAuth implements AuthProvider {
  private session: SessionData | null = null;
  private readonly authCookieNames: string[];

  constructor(authCookieNames: string[]) {
    this.authCookieNames = authCookieNames;
  }

  getCredentialFields(): CredentialField[] {
    // Amazon login is fully manual (CAPTCHA/2FA) — no credentials stored
    return [];
  }

  async login(_credentials: Record<string, string>): Promise<boolean> {
    log.info("Opening browser for Amazon manual login...");

    const browser = await launchBrowser({ headless: false });
    const page = await browser.newPage();
    page.setDefaultTimeout(LOGIN_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(LOGIN_TIMEOUT_MS);

    try {
      await page.goto(AMAZON_LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      log.info("Waiting for user to complete Amazon login...");

      // Poll until we have actual auth cookies (not just a URL redirect)
      // Amazon login flow: /ap/signin → (CAPTCHA/MFA/etc) → redirect → read.amazon.co.jp
      // But even without login, the URL can end up on read.amazon.co.jp (with a login prompt there)
      log.info("Waiting for user to complete Amazon login (checking for auth cookies)...");

      const hasAuthCookies = async (): Promise<boolean> => {
        const client = await page.createCDPSession();
        const { cookies } = await client.send("Network.getAllCookies");
        await client.detach();
        return cookies.some(
          (c: any) =>
            (c.name === "session-token" || c.name === "x-main" || c.name === "at-main") &&
            c.domain.includes("amazon.co.jp"),
        );
      };

      // Wait up to LOGIN_TIMEOUT_MS, checking cookies every 2 seconds
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await hasAuthCookies()) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!(await hasAuthCookies())) {
        throw new Error("Login timed out: auth cookies not detected");
      }

      log.info(`Login detected via auth cookies, current URL: ${page.url()}`);

      // Navigate to Kindle Library to ensure all cookies are captured
      if (!page.url().includes("read.amazon.co.jp")) {
        await page.goto(KINDLE_LIBRARY_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      }

      // Wait for page to settle
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {
        log.warn("Network idle timeout, proceeding with cookie capture...");
      });
      await new Promise((r) => setTimeout(r, 2000));

      // Use CDP to get ALL cookies across all domains (page.cookies only returns current URL's)
      const client = await page.createCDPSession();
      const { cookies } = await client.send("Network.getAllCookies");
      await client.detach();

      // Keep only amazon-related cookies
      const amazonCookies = cookies.filter(
        (c: any) => c.domain.includes("amazon.co.jp"),
      );

      if (amazonCookies.length === 0) {
        throw new Error("No Amazon cookies captured after login");
      }

      this.session = {
        cookies: amazonCookies.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
        })),
      };

      const cookieNames = amazonCookies.map((c: any) => `${c.name} (${c.domain})`);
      log.info(`Login successful (${amazonCookies.length} cookies): ${cookieNames.join(", ")}`);
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

    // Check required auth cookies exist
    const authNames = this.authCookieNames;
    const authCookies = this.session.cookies.filter(
      (c) => authNames.includes(c.name),
    );
    const missing = authNames.filter(
      (name) => !authCookies.some((c) => c.name === name),
    );
    if (missing.length > 0) {
      log.warn(`Session invalid: missing cookies: ${missing.join(", ")}`);
      return false;
    }

    // Check expiry — skip session cookies (expires <= 0 means no expiry / session-only)
    const now = Date.now() / 1000;
    const expired = authCookies.filter(
      (c) => c.expires && c.expires > 0 && c.expires < now,
    );
    if (expired.length > 0) {
      log.warn(`Session invalid: expired cookies: ${expired.map((c) => c.name).join(", ")}`);
      return false;
    }

    // Verify with actual fetch — check customerId on Amazon homepage
    // Authenticated: customerId is a real ID (e.g. "A3J1WU5EV12C1M")
    // Unauthenticated/fake: customerId is "1" or missing
    try {
      const cookieString = this.session.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const response = await fetch("https://www.amazon.co.jp/gp/css/homepage.html", {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Cookie: cookieString,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        log.warn(`Session validation fetch failed: HTTP ${response.status}`);
        return false;
      }
      const html = await response.text();
      const match = html.match(/customerId["':\s]+["']([A-Z0-9]{10,})/);
      if (!match) {
        log.warn("Session invalid: no valid customerId found in Amazon homepage");
        return false;
      }
      log.info(`Session valid: customerId=${match[1]}`);
    } catch (e: any) {
      log.warn(`Session validation fetch error: ${e.message}`);
      return false;
    }

    log.info(`Session valid (${authCookies.map((c) => c.name).join(", ")} verified)`);
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
