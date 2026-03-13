import type { FastifyInstance } from "fastify";
import { registry } from "../../plugins/registry.js";

export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  // List all plugins
  app.get("/api/plugins", async () => {
    return registry.getAll().map((p) => p.manifest);
  });

  // Get plugin detail
  app.get("/api/plugins/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const plugin = registry.get(id);

    if (!plugin) return reply.status(404).send({ error: "Plugin not found" });

    return {
      ...plugin.manifest,
      credentialFields: plugin.auth?.getCredentialFields() ?? [],
    };
  });

  // Fetch title info via plugin
  app.get("/api/plugins/:id/title/:titleId", async (request, reply) => {
    const { id, titleId } = request.params as { id: string; titleId: string };
    const plugin = registry.get(id);

    if (!plugin?.metadata) {
      return reply.status(400).send({ error: "Plugin not found or does not support metadata" });
    }

    try {
      const info = await plugin.metadata.getTitleInfo(titleId);
      return info;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: msg });
    }
  });
}
