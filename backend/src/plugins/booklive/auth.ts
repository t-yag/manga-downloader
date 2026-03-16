/**
 * BookLive authentication provider.
 * Uses Puppeteer-based login with visible browser (reCAPTCHA requires non-headless).
 */

import puppeteer, { Browser } from "puppeteer";
import fs from "fs/promises";
import { logger } from "../../logger.js";
import type {
  AuthProvider,
  CredentialField,
  SessionData,
  CookieData,
} from "../base.js";

const log = logger.child({ module: "BookLiveAuth" });

export class BookLiveAuth implements AuthProvider {
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

    const launchOptions: any = {
      headless: false, // reCAPTCHA requires visible browser
      defaultViewport: { width: 1280, height: 800 },
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };

    if (process.env.CHROME_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.CHROME_EXECUTABLE_PATH;
    }

    this.browser = await puppeteer.launch(launchOptions);
    const page = await this.browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    try {
      // Navigate to login page
      await page.goto("https://booklive.jp/login", {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

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

      // Wait for redirect to complete (max 15 seconds)
      const maxWaitTime = 15000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        const currentUrl = page.url();

        // Success: redirected away from login page
        if (
          currentUrl.includes("booklive.jp") &&
          !currentUrl.includes("/login")
        ) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Get cookies
      const cookies = await page.cookies();
      const finalUrl = page.url();

      // Verify login success by checking for BL_MEM cookie (member flag)
      const memberCookie = cookies.find((c) => c.name === "BL_MEM");
      if (!memberCookie || finalUrl.includes("/login")) {
        throw new Error("Login failed: BL_MEM cookie not found or still on login page");
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
        } catch {
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

    // Check for essential auth cookies
    const requiredCookies = ["PHPSESSID", "BL_MEM"];
    for (const name of requiredCookies) {
      const cookie = this.session.cookies.find((c) => c.name === name);
      if (!cookie) {
        log.warn(`Session invalid: ${name} cookie not found`);
        return false;
      }
    }

    // Check cookie expiry
    const now = Date.now() / 1000;
    const sessionCookie = this.session.cookies.find((c) => c.name === "PHPSESSID");
    if (sessionCookie?.expires && sessionCookie.expires > 0 && sessionCookie.expires < now) {
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
