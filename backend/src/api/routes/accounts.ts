import type { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { registry } from "../../plugins/registry.js";
import fs from "fs/promises";
import path from "path";

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // List accounts (credentials are masked)
  app.get("/api/accounts", async () => {
    const accts = db.select().from(schema.accounts).all();
    return accts.map((a) => ({
      ...a,
      credentials: "***", // Never expose credentials
    }));
  });

  // Create account
  app.post("/api/accounts", async (request, reply) => {
    const { pluginId, label, credentials } = request.body as {
      pluginId: string;
      label?: string;
      credentials: Record<string, string>;
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

    const result = db
      .delete(schema.accounts)
      .where(eq(schema.accounts.id, Number(id)))
      .run();

    if (result.changes === 0) {
      return reply.status(404).send({ error: "Account not found" });
    }

    return { message: "Account deleted" };
  });

  // Login account (execute browser login and save cookies)
  app.post("/api/accounts/:id/login", async (request, reply) => {
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
      const credentials = JSON.parse(account.credentials);
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
