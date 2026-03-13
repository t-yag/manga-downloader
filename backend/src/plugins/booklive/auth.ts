/**
 * BookLive authentication provider.
 * Mock implementation - actual authentication needs to be implemented.
 */

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
  private session: SessionData | null = null;
  private cookieFile: string;

  constructor(cookieFile: string = "booklive_cookies.json") {
    this.cookieFile = cookieFile;
  }

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

    log.info("Login (mock mode)");

    // Mock implementation: generate dummy cookies
    const mockCookies: CookieData[] = [
      {
        name: "BL_SESSION",
        value: `mock_session_${Date.now()}`,
        domain: ".booklive.jp",
        path: "/",
      },
      {
        name: "BL_AUTH",
        value: "mock_auth_token",
        domain: ".booklive.jp",
        path: "/",
      },
    ];

    this.session = {
      cookies: mockCookies,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    };

    log.info("Mock authentication successful");
    return true;
  }

  async validateSession(): Promise<boolean> {
    if (!this.session || !this.session.cookies || this.session.cookies.length === 0) {
      log.info("No session to validate");
      return false;
    }

    // Check if session has expired
    if (this.session.expiresAt) {
      const expiresAt = new Date(this.session.expiresAt);
      if (expiresAt < new Date()) {
        log.info("Session has expired");
        return false;
      }
    }

    // Mock implementation: always valid for now
    log.info("Session valid (mock mode)");
    return true;
  }

  getSession(): SessionData | null {
    return this.session;
  }

  async loadSession(cookiePath: string): Promise<boolean> {
    try {
      const data = await fs.readFile(cookiePath, "utf-8");
      this.session = JSON.parse(data);
      log.info(`Session loaded from ${cookiePath}`);
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
    if (!this.session) {
      throw new Error("No session to save");
    }

    try {
      await fs.writeFile(cookiePath, JSON.stringify(this.session, null, 2), "utf-8");
      log.info(`Session saved: ${cookiePath}`);
    } catch (error: any) {
      throw new Error(`Failed to save session: ${error.message}`);
    }
  }
}
