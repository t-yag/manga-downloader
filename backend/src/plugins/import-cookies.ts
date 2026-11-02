import type { CookieData } from "./base.js";

export function normalizeImportedCookies(input: unknown, domain: string, header?: string): CookieData[] {
  let entries: any[] = Array.isArray(input) ? input : [];
  if (header?.trim()) {
    entries = header.trim().replace(/^cookie:\s*/i, "").split(";").filter(x => x.trim()).map(part => {
      const eq = part.indexOf("=");
      if (eq < 1) throw new Error("Cookieヘッダーは name=value; name=value の形式で入力してください");
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    });
  }
  return entries.map(c => {
    if (!c || typeof c.name !== "string" || typeof c.value !== "string" ||
        !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(c.name) || /[;\r\n\x00]/.test(c.value) || !c.value)
      throw new Error("Cookieの名前または値が不正です");
    let expires = -1;
    if (c.expires !== undefined && c.expires !== "" && c.expires !== "Session") {
      expires = typeof c.expires === "number" ? c.expires : Date.parse(c.expires) / 1000;
      if (!Number.isFinite(expires)) throw new Error("Cookieの有効期限が不正です");
    }
    return { name: c.name, value: c.value, domain, path: "/", expires };
  });
}
