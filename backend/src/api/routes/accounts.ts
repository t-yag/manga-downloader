import type { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { registry } from "../../plugins/registry.js";
import fs from "fs/promises";
import path from "path";

/** Check if a cookie file exists and read basic session info */
async function getSessionStatus(
  cookiePath: string | null,
  pluginId: string,
): Promise<{
  hasCookies: boolean;
  cookieCount: number;
  expiresAt: string | null;
}> {
  if (!cookiePath) return { hasCookies: false, cookieCount: 0, expiresAt: null };

  try {
    const data = await fs.readFile(cookiePath, "utf-8");
    const cookies = JSON.parse(data) as Array<{ name: string; expires?: number }>;
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return { hasCookies: false, cookieCount: 0, expiresAt: null };
    }

    // Find the earliest expiry among auth-relevant cookies for this plugin
    const authNames = registry.get(pluginId)?.manifest.authCookieNames ?? [];
    const authCookies = authNames.length > 0
      ? cookies.filter((c) => authNames.includes(c.name))
      : cookies;
    const validExpiries = authCookies
      .filter((c) => c.expires && c.expires > 0)
      .map((c) => c.expires!);
    const earliest = validExpiries.length > 0 ? Math.min(...validExpiries) : null;

    return {
      hasCookies: true,
      cookieCount: cookies.length,
      expiresAt: earliest ? new Date(earliest * 1000).toISOString() : null,
    };
  } catch {
    return { hasCookies: false, cookieCount: 0, expiresAt: null };
  }
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // List accounts (credentials are masked, includes session status)
  app.get("/api/accounts", async () => {
    const accts = db.select().from(schema.accounts).all();
    const results = await Promise.all(
      accts.map(async (a) => ({
        ...a,
        credentials: "***", // Never expose credentials
        session: await getSessionStatus(a.cookiePath, a.pluginId),
      }))
    );
    return results;
  });

  // Create account
  app.post("/api/accounts", async (request, reply) => {
    const { pluginId, label, credentials = {} } = request.body as {
      pluginId: string;
      label?: string;
      credentials?: Record<string, string>;
    };

    const plugin = registry.get(pluginId);
    if (!plugin) {
      return reply.status(400).send({ error: `Plugin "${pluginId}" not found` });
    }

    const cookiePath = `data/cookies/${pluginId}_${Date.now()}.json`;

    const result = db
      .insert(schema.accounts)
      .values({
        pluginId,
        label: label ?? pluginId,
        credentials: JSON.stringify(credentials), // TODO: encrypt
        cookiePath,
      })
      .returning()
      .get();

    return {
      ...result,
      credentials: "***",
    };
  });

  // Update account
  app.put("/api/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { label, credentials } = request.body as {
      label?: string;
      credentials?: Record<string, string>;
    };

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (label !== undefined) updates.label = label;
    if (credentials !== undefined) updates.credentials = JSON.stringify(credentials);

    const result = db
      .update(schema.accounts)
      .set(updates)
      .where(eq(schema.accounts.id, Number(id)))
      .run();

    if (result.changes === 0) {
      return reply.status(404).send({ error: "Account not found" });
    }

    return { message: "Account updated" };
  });

  // Delete account
  app.delete("/api/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const accountId = Number(id);

    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();

    if (!account) return reply.status(404).send({ error: "Account not found" });

    // Clear FK references in jobs before deleting
    db.update(schema.jobs)
      .set({ accountId: null })
      .where(eq(schema.jobs.accountId, accountId))
      .run();

    // Delete cookie file if it exists
    if (account.cookiePath) {
      await fs.unlink(account.cookiePath).catch(() => {});
    }

    db.delete(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .run();

    return { message: "Account deleted" };
  });

  // Login account (execute browser login and save cookies)
  app.post("/api/accounts/:id/login", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { method } = (request.body as { method?: string } | null) ?? {};

    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, Number(id)))
      .get();

    if (!account) return reply.status(404).send({ error: "Account not found" });

    const plugin = registry.get(account.pluginId);
    if (!plugin?.auth) {
      return reply.status(400).send({ error: "Plugin does not support auth" });
    }

    try {
      // When method is "browser", pass empty credentials to trigger non-headless browser
      const credentials = method === "browser" ? {} : JSON.parse(account.credentials);
      const success = await plugin.auth.login(credentials);

      if (!success) {
        return reply.status(401).send({ error: "Login failed" });
      }

      if (!account.cookiePath) {
        return reply.status(500).send({ error: "Account has no cookie path configured" });
      }

      // Ensure cookies directory exists
      const cookieDir = path.dirname(account.cookiePath);
      await fs.mkdir(cookieDir, { recursive: true });

      // Save session cookies to file
      await plugin.auth.saveSession(account.cookiePath);

      // Update lastLoginAt
      db.update(schema.accounts)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(schema.accounts.id, Number(id)))
        .run();

      return { success: true, message: "Login successful" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: `Login failed: ${msg}` });
    }
  });

  // Import cookies from structured auth cookie data
  app.post("/api/accounts/:id/import-cookies", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { cookies: inputCookies } = request.body as {
      cookies: Array<{ name: string; value: string; expires?: string }>;
    };

    if (!Array.isArray(inputCookies) || inputCookies.length === 0) {
      return reply.status(400).send({ error: "cookies array is required" });
    }

    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, Number(id)))
      .get();

    if (!account) return reply.status(404).send({ error: "Account not found" });

    if (!account.cookiePath) {
      return reply.status(500).send({ error: "Account has no cookie path configured" });
    }

    const plugin = registry.get(account.pluginId);
    if (!plugin?.auth) {
      return reply.status(400).send({ error: "Plugin does not support auth" });
    }

    try {
      // Infer cookie domain from manifest (authDomain override, or derived from authUrl)
      const domain = plugin.manifest.authDomain
        ?? (plugin.manifest.authUrl ? "." + new URL(plugin.manifest.authUrl).hostname.replace(/^www\./, "") : "");

      const cookies = inputCookies
        .filter((c) => c.name && c.value)
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain,
          path: "/",
          expires: c.expires ? Math.floor(new Date(c.expires).getTime() / 1000) : -1,
        }));

      if (cookies.length === 0) {
        return reply.status(400).send({ error: "No valid cookies provided" });
      }

      // Save cookie file
      const cookieDir = path.dirname(account.cookiePath);
      await fs.mkdir(cookieDir, { recursive: true });
      await fs.writeFile(
        account.cookiePath,
        JSON.stringify(cookies, null, 2),
        "utf-8",
      );

      // Validate the imported session
      await plugin.auth.loadSession(account.cookiePath);
      const valid = await plugin.auth.validateSession();

      if (!valid) {
        // Remove invalid cookie file so the account doesn't appear as "logged in"
        await fs.unlink(account.cookiePath).catch(() => {});
      }

      db.update(schema.accounts)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(schema.accounts.id, Number(id)))
        .run();

      return {
        success: true,
        valid,
        cookieCount: cookies.length,
        message: valid
          ? `${cookies.length}個のCookieをインポートしました（セッション有効）`
          : `Cookieが無効です。正しい値か確認してください`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: `Cookie import failed: ${msg}` });
    }
  });

  // Clear account session (delete cookie file)
  app.post("/api/accounts/:id/clear-session", async (request, reply) => {
    const { id } = request.params as { id: string };

    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, Number(id)))
      .get();

    if (!account) return reply.status(404).send({ error: "Account not found" });

    if (account.cookiePath) {
      try {
        await fs.unlink(account.cookiePath);
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }

    return { message: "Session cleared" };
  });

  // Validate account session
  app.post("/api/accounts/:id/validate", async (request, reply) => {
    const { id } = request.params as { id: string };

    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, Number(id)))
      .get();

    if (!account) return reply.status(404).send({ error: "Account not found" });

    const plugin = registry.get(account.pluginId);
    if (!plugin?.auth) {
      return reply.status(400).send({ error: "Plugin does not support auth" });
    }

    try {
      if (account.cookiePath) {
        await plugin.auth.loadSession(account.cookiePath);
      }
      const valid = await plugin.auth.validateSession();
      return { valid };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { valid: false, error: msg };
    }
  });
}
