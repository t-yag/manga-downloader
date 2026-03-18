import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { registry } from "./registry.js";
import type { SessionData } from "./base.js";

/**
 * Resolve session for a plugin by loading the first account's saved cookies.
 * Returns null if no account or no saved session exists.
 */
export async function resolvePluginSession(
  pluginId: string,
): Promise<SessionData | null> {
  const plugin = registry.get(pluginId);
  if (!plugin?.auth) return null;

  const account = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.pluginId, pluginId))
    .get();

  if (!account?.cookiePath) return null;

  const loaded = await plugin.auth.loadSession(account.cookiePath);
  if (!loaded) return null;

  return plugin.auth.getSession();
}
