import assert from "node:assert/strict";
import { test } from "node:test";
import { KindleUrlParser } from "../src/plugins/kindle/url-parser.js";
import { KindleMetadata, KindleAvailabilityChecker, fetchSeriesInfo } from "../src/plugins/kindle/metadata.js";

const session = { cookies: [{ name: "session-token", value: "test", domain: ".amazon.co.jp", path: "/" }] };
const seriesAsin = "B07BTJ3M78";
const bookAsin = "B0DGFG66QW";
function item(asin = bookAsin, index = 1, owned = false) {
  return `<div class="series-childAsin-item ${owned ? "hasOwnership" : ""}" id="series-childAsin-item_${index}"><a class="itemBookTitle" href="/dp/${asin}"><h3>テスト (${index})</h3></a></div>`;
}
const series = `<meta property="og:title" content="テスト"><div id="seriesAsinListPagination" data-number_of_items="1" data-page_size="10"></div>${item()}`;
const legacyLibrary = (items: unknown[]) => `<script type="application/json" id="itemViewResponse">${JSON.stringify({ itemsList: items })}</script>`;

for (const url of [
  `https://www.amazon.co.jp/のんのんびより/dp/${seriesAsin}`,
  `https://amazon.co.jp/dp/${seriesAsin}?binding=kindle_edition`,
  `https://www.amazon.co.jp/gp/product/${seriesAsin}/ref=test`,
  `https://read.amazon.co.jp/manga/${seriesAsin}`,
  `https://read.amazon.co.jp/kindle-library/manga-wr/${seriesAsin}?x=1`,
]) {
  test(`URL detection and parsing agree: ${url}`, () => {
    const parser = new KindleUrlParser();
    assert.equal(parser.canHandle(url), true);
    assert.equal(parser.parse(url).titleId, seriesAsin);
  });
}
for (const url of [
  "not a URL", `https://fakeamazon.co.jp/dp/${seriesAsin}`,
  `https://amazon.co.jp.example.com/dp/${seriesAsin}`,
  `https://example.com/?url=https://amazon.co.jp/dp/${seriesAsin}`,
  `https://www.amazon.co.jp/dp/${seriesAsin}EXTRA`,
  "https://www.amazon.co.jp/your-books", "https://www.amazon.co.jp/dp/SHORT",
]) {
  test(`Reject unrelated or invalid URL: ${url}`, () => {
    const parser = new KindleUrlParser();
    assert.equal(parser.canHandle(url), false);
    assert.throws(() => parser.parse(url));
  });
}

test("Registration succeeds when the old library redirects to sign-in or Your Books", async (t) => {
  for (const library of ['<form name="signIn"><input id="ap_email_login"></form>', '<title>本棚</title>']) {
    const requests: string[] = [];
    const mock = t.mock.method(globalThis, "fetch", async (url: string) => {
      requests.push(String(url));
      return new Response(String(url).includes("kindle-library") ? library : series);
    });
    const info = await new KindleMetadata().getTitleInfo(seriesAsin, session);
    assert.equal(info.title, "テスト");
    assert.equal(info.volumes.length, 1);
    assert.equal(info.volumes[0].contentKey, bookAsin);
    assert.match(requests[0], /\/dp\//);
    mock.mock.restore();
  }
});

test("Individual product resolves to canonical series", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => new Response(
    String(url).includes("kindle-library") ? "<title>本棚</title>" :
    String(url).includes(`/dp/${bookAsin}`) ? `<a href="/dp/${seriesAsin}?binding=kindle_edition">全1巻中第1巻</a>` : series,
  ));
  assert.equal((await new KindleMetadata().getTitleInfo(bookAsin, session)).titleId, seriesAsin);
});

test("Legacy library still excludes known text-only books", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => new Response(
    String(url).includes("kindle-library") ? legacyLibrary([{ asin: bookAsin, mangaOrComicAsin: false }]) : series,
  ));
  await assert.rejects(new KindleMetadata().getTitleInfo(seriesAsin, session), /マンガ形式の巻がない/);
});

test("Legacy fallback also accepts a series ASIN", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => new Response(
    String(url).includes("kindle-library") ? legacyLibrary([{ asin: bookAsin, seriesAsin, title: "テスト (1)", mangaOrComicAsin: true }]) : "<title>Unknown</title>",
  ));
  const info = await new KindleMetadata().getTitleInfo(seriesAsin, session);
  assert.equal(info.titleId, seriesAsin);
  assert.equal(info.volumes.length, 1);
});

for (const [html, error] of [
  ['<form action="/errors/validateCaptcha"><input id="captchacharacters"></form>', /CAPTCHA/],
  ['<form name="signIn"><input id="ap_email_login"></form>', /再ログイン/],
  ['<title>Amazon.co.jp</title>', /商品情報を取得できません/],
] as const) {
  test(`Reject non-product response: ${error}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(html));
    await assert.rejects(new KindleMetadata().getTitleInfo(seriesAsin, session), error);
  });
}

test("A failed later page does not register a partial series", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => String(url).includes("ajax")
    ? new Response("Unavailable", { status: 503 })
    : new Response(series.replace('data-number_of_items="1" data-page_size="10"', 'data-number_of_items="2" data-page_size="1"')));
  await assert.rejects(fetchSeriesInfo(seriesAsin, ""), /2ページ目/);
});

test("An empty later page does not register a partial series", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => new Response(String(url).includes("ajax") ? "" :
    series.replace('data-number_of_items="1" data-page_size="10"', 'data-number_of_items="2" data-page_size="1"')));
  await assert.rejects(fetchSeriesInfo(seriesAsin, ""), /巻情報が不完全/);
});

test("Series link cycles stop with an error", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => new Response(`<a href="/dp/${String(url).includes(seriesAsin) ? bookAsin : seriesAsin}?binding=kindle_edition">全1巻中第1巻</a>`));
  await assert.rejects(fetchSeriesInfo(seriesAsin, ""), /循環/);
});

test("Availability does not infer ownership from registration", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(`<meta property="og:title" content="テスト">${item(bookAsin, 1, true)}${item("B000000002", 2)}`));
  const result = await new KindleAvailabilityChecker().checkAvailability(seriesAsin, [{ volume: 1 }, { volume: 2 }], session);
  assert.deepEqual(result.map(r => [r.available, r.reason]), [[true, "purchased"], [false, "not_purchased"]]);
});
