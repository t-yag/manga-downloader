import type { Plugin, ParsedUrl } from "./base.js";

class PluginRegistry {
  private plugins = new Map<string, Plugin>();

  /**
   * Find the plugin that can handle a given URL and parse it.
   */
  parseUrl(url: string): ParsedUrl {
    for (const plugin of this.plugins.values()) {
      if (plugin.urlParser.canHandle(url)) {
        return plugin.urlParser.parse(url);
      }
    }
    throw new Error(`No plugin can handle URL: ${url}`);
  }

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`Plugin "${plugin.manifest.id}" is already registered`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  getAll(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  async disposeAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.dispose?.();
    }
    this.plugins.clear();
  }
}

export const registry = new PluginRegistry();
