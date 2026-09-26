import type { ParsedUrl, UrlParser } from "../base.js";

export class KindleUrlParser implements UrlParser {
  canHandle(url: string): boolean {
    return this.match(url) !== null;
  }

  parse(url: string): ParsedUrl {
    const parsed = this.match(url);
    if (!parsed) throw new Error("Unrecognized Kindle URL format");
    return parsed;
  }

  private match(input: string): ParsedUrl | null {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    if (url.hostname === "read.amazon.co.jp") {
      const reader = url.pathname.match(/^\/(?:manga|kindle-library\/manga-wr)\/([A-Z0-9]{10})(?:\/|$)/);
      if (reader) return { pluginId: "kindle", titleId: reader[1], type: "reader" };
    }
    if (url.hostname === "www.amazon.co.jp" || url.hostname === "amazon.co.jp") {
      const product = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/);
      if (product) return { pluginId: "kindle", titleId: product[1], type: "title" };
    }
    return null;
  }
}
