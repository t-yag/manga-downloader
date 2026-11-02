import test from "node:test";
import assert from "node:assert/strict";
import { validateBookLiveCookies } from "../src/plugins/booklive/session.js";
import { normalizeImportedCookies } from "../src/plugins/import-cookies.js";
const cookies = [{name:"PHPSESSID",value:"test",domain:".booklive.jp",expires:-1}];
function response(body: string, status = 200, headers: Record<string,string> = {}) {
  return (async () => new Response(body, {status,headers})) as typeof fetch;
}
test("Cookie existence does not authenticate a guest", async () => {
  assert.equal(await validateBookLiveCookies(cookies, response('<a id="top_button_4" href="/login">ログイン</a>')), false);
  assert.equal(await validateBookLiveCookies(cookies, response('',302,{location:'https://booklive.jp/login'})),false);
});
test("An authenticated member page validates", async () => {
  const member = '<a id="top_button_4" href="/my/top">ようこそ！testさん</a><a href="/my/book-shelf">My本棚</a>';
  assert.equal(await validateBookLiveCookies(cookies,response(member)),true);
});
test("Expired or foreign cookies are not sent", async () => {
  const request = (async () => { throw new Error('must not fetch'); }) as typeof fetch;
  assert.equal(await validateBookLiveCookies([{...cookies[0],expires:1}],request),false);
  assert.equal(await validateBookLiveCookies([{...cookies[0],domain:'evilbooklive.jp'}],request),false);
});
test("Server failure is distinct from unauthenticated", async () => {
  await assert.rejects(validateBookLiveCookies(cookies,response('',503)),/HTTP 503/);
});
test("Cookie header preserves embedded equals and all cookie names", () => {
  const cs=normalizeImportedCookies([],'.booklive.jp','Cookie: PHPSESSID=abc; BL_MEM=xyz==; OTHER=123');
  assert.deepEqual(cs.map(c=>[c.name,c.value]),[['PHPSESSID','abc'],['BL_MEM','xyz=='],['OTHER','123']]);
  assert.ok(cs.every(c=>c.domain==='.booklive.jp'&&c.path==='/'&&c.expires===-1));
});
test("Cookie expiry accepts seconds and ISO timestamps", () => {
  assert.equal(normalizeImportedCookies([{name:'a',value:'v',expires:1800000000}],'.booklive.jp')[0].expires,1800000000);
  assert.equal(normalizeImportedCookies([{name:'a',value:'v',expires:'2027-01-15T08:00:00Z'}],'.booklive.jp')[0].expires,1800000000);
});
test("Malformed cookies and header injection are rejected", () => {
  assert.throws(()=>normalizeImportedCookies([],'.booklive.jp','a=v\r\nHost: evil'));
  assert.throws(()=>normalizeImportedCookies([],'.booklive.jp','a=v; broken'));
  assert.throws(()=>normalizeImportedCookies([{name:'a',value:'v',expires:'bad'}],'.booklive.jp'));
});

test("Availability refuses guests instead of marking purchased titles unowned", async (t) => {
  const { createBookLivePlugin } = await import("../src/plugins/booklive/index.js");
  t.mock.method(globalThis, "fetch", response("",302,{location:"https://booklive.jp/login"}));
  await assert.rejects(createBookLivePlugin().availabilityChecker!.checkAvailability("184473",[{volume:1}],{cookies}),/認証/);
});
test("Availability reads the actual purchased button format", async (t) => {
  const { createBookLivePlugin } = await import("../src/plugins/booklive/index.js");
  t.mock.method(globalThis, "fetch", (async (url: string) => new Response(String(url).includes("/my/top")
    ? '<a id="top_button_4" href="/my/top#">ようこそ！testさん</a><a href="/my/book-shelf">My本棚</a>'
    : '<div class="item"><div class="button_area"><a class="bl-bviewer read_action btn_module small sl-bread_b" data-vol="001">読む</a></div></div><div class="item"><div class="button_area"><a class="cart_action" data-vol="002">カートに入れる</a></div></div>')) as typeof fetch);
  const result=await createBookLivePlugin().availabilityChecker!.checkAvailability("184473",[{volume:1},{volume:2}],{cookies});
  assert.equal(result[0].available,true);assert.equal(result[0].reason,"purchased");
  assert.equal(result[1].available,false);assert.equal(result[1].reason,"not_purchased");
});
