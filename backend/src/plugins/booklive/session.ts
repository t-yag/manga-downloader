import * as cheerio from "cheerio";
import type { CookieData } from "../base.js";

export async function validateBookLiveCookies(
  cookies: CookieData[], request: typeof fetch = fetch,
): Promise<boolean> {
  const now = Date.now() / 1000;
  const usable = cookies.filter(c =>
    (c.domain === "booklive.jp" || c.domain === ".booklive.jp") &&
    (!c.path || "/my/top".startsWith(c.path)) &&
    (!c.expires || c.expires < 0 || c.expires > now));
  if (!usable.length) return false;
  const response = await request("https://booklive.jp/my/top", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Cookie: usable.map(c => c.name + "=" + c.value).join("; "),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location && new URL(location, "https://booklive.jp").pathname.startsWith("/login")) return false;
    throw new Error("BookLiveの認証確認で予期しないリダイレクトが返りました");
  }
  if (!response.ok) throw new Error("BookLiveの認証確認に失敗しました (HTTP " + response.status + ")");
  const $ = cheerio.load(await response.text());
  const welcome = $("#top_button_4");
  return welcome.text().includes("ようこそ") &&
    !(welcome.attr("href") ?? "").includes("/login") &&
    $("a[href*='/my/book-shelf']").length > 0;
}
