// worker/index.js の統合テスト(Node標準のみ・KVはモック・Push送信はスタブ)
// 実行: cd worker && npm install && npm test
// フロント(public/index.html)が実際に叩くエンドポイントとuid/tokenの受け渡しがWorkerと一致するかも確認する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import webpush from "web-push";
import worker from "./index.js";

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

const kv = new FakeKV();
// テスト用に生成した使い捨てVAPID鍵(本番鍵ではない)
const keys = webpush.generateVAPIDKeys();
const env = { SUBS: kv, VAPID_PUBLIC: keys.publicKey, VAPID_PRIVATE: keys.privateKey, VAPID_SUBJECT: "mailto:test@example.com" };

const sent = [];
let failWith = null;
webpush.sendNotification = async (sub, payload) => {
  if (failWith) throw failWith;
  sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
};

const BASE = "https://worker.test";
const post = (path, body) => worker.fetch(new Request(BASE + path, { method: "POST", body: JSON.stringify(body) }), env);
const get = (path) => worker.fetch(new Request(BASE + path), env);
const rid = () => crypto.randomUUID().replace(/-/g, ""); // フロントのgenerateRandomId()と同形式
const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh: "p", auth: "a" } };

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("  ✓ " + name); };

const uidA = rid(), uidB = rid(), tokenA = rid();

await t("/health が返り vapid 先頭が公開鍵と一致", async () => {
  const j = await (await get("/health")).json();
  assert.equal(j.ok, true);
  assert.equal(j.vapid, keys.publicKey.slice(0, 12));
});

await t("フロントが使う全POSTエンドポイントがWorkerに存在する(404でない)", async () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const paths = [...new Set([...html.matchAll(/postToPushServer\("(\/[a-z-]+)"/g)].map((m) => m[1]))];
  assert.ok(paths.length >= 7, "フロントのエンドポイント抽出に失敗: " + paths);
  for (const p of paths) {
    const res = await post(p, { uid: uidA, token: tokenA });
    assert.notEqual(res.status, 404, p + " がWorkerに無い");
  }
  console.log("    対象: " + paths.join(", "));
});

await t("uid無し/不正は400", async () => {
  assert.equal((await post("/subscribe", { subscription: sub })).status, 400);
  assert.equal((await post("/subscribe", { uid: "anonymous", subscription: sub })).status, 400);
});

await t("/subscribe: 正常=ok、許可外ホスト=400", async () => {
  assert.equal((await post("/subscribe", { uid: uidA, subscription: sub })).status, 200);
  const bad = { ...sub, endpoint: "https://evil.example.com/x" };
  assert.equal((await post("/subscribe", { uid: uidB, subscription: bad })).status, 400);
  assert.equal(await kv.get(`sub:${uidB}`), null);
});

const shifts = [
  { id: 1, date: "2026-10-20", startTime: "17:00", endTime: "22:00", jobName: "A店", pay: 6000 },
  { id: 2, date: "2026-10-21", startTime: "22:00", endTime: "05:00", jobName: "B店, 夜勤", pay: 9000 },
];

await t("/calendar-shifts → /calendar.ics (tokenだけで配信、夜勤は翌日終了)", async () => {
  assert.equal((await post("/calendar-shifts", { uid: uidA, shifts, token: tokenA })).status, 200);
  const res = await get(`/calendar.ics?token=${tokenA}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /DTSTART;TZID=Asia\/Tokyo:20261020T170000/);
  assert.match(ics, /DTEND;TZID=Asia\/Tokyo:20261022T050000/); // 夜勤: 21日22:00 → 22日05:00
  assert.match(ics, /B店\\, 夜勤/); // カンマがエスケープされている
});

await t("カレンダーの認可: token違い/token無し/差し替え/乗っ取りは403", async () => {
  assert.equal((await get(`/calendar.ics?token=${rid()}`)).status, 403);      // 知らないtoken
  assert.equal((await get(`/calendar.ics?uid=${uidA}`)).status, 403);         // tokenなし(uidだけでは読めない)
  assert.equal((await post("/calendar-shifts", { uid: uidA, shifts: [], token: rid() })).status, 403); // token差し替え
  assert.equal((await post("/calendar-shifts", { uid: uidB, shifts: [], token: tokenA })).status, 403); // 他人のtoken乗っ取り
});

await t("利用者間のデータ分離: Aの設定はBのキーに入らない", async () => {
  await post("/reminder", { uid: uidA, enabled: true, time: "21:00" });
  assert.ok(await kv.get(`cfg:${uidA}`));
  assert.equal(await kv.get(`cfg:${uidB}`), null);
});

await t("/test: 送信→60秒以内の2回目は429", async () => {
  sent.length = 0;
  assert.equal((await post("/test", { uid: uidA })).status, 200);
  assert.equal(sent.length, 1);
  assert.equal((await post("/test", { uid: uidA })).status, 429);
});

await t("/test: 未登録uidは400", async () => {
  assert.equal((await post("/test", { uid: rid() })).status, 400);
});

// --- cron ---
const nowJst = () => {
  const p = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (x) => p.find((q) => q.type === x).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hh: Number(g("hour")) % 24, mm: Number(g("minute")) };
};
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

await t("cron: リマインダー/シフト前/予算超過が各1回だけ届き、2回目のcronでは重複しない", async () => {
  const uid = rid();
  await post("/subscribe", { uid, subscription: { ...sub, endpoint: "https://fcm.googleapis.com/fcm/send/cron" } });
  const n = nowJst();
  const target = n.hh * 60 + n.mm - 3; // リマインダー時刻 = 今の3分前(通知幅15分の中)
  if (target < 0) console.log("    (0時台のためリマインダー検証をスキップ)");
  else await post("/reminder", { uid, enabled: true, time: hhmm(target) });
  // 60分後開始のシフト + 60分前通知 → 今がちょうど通知時刻
  const start = new Date(Date.now() + 60 * 60000);
  const sd = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(start);
  const st = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(start);
  await post("/shift-alert-settings", { uid, enabled: true, minutesBefore: 60 });
  await post("/shifts", { uid, shifts: [{ date: sd, startTime: st, endTime: "23:59", jobName: "A店", pay: 5000 }] });
  await post("/budget-status", { uid, month: n.date.slice(0, 7), items: [{ category: "食費", limit: 1000, used: 1500 }] });

  sent.length = 0;
  await worker.scheduled({}, env);
  const mine = () => sent.filter((s) => s.endpoint.endsWith("/cron"));
  const titles = mine().map((s) => s.payload.title);
  assert.ok(titles.includes("⏰ まもなくシフト開始！"), "シフト前通知: " + titles);
  assert.ok(titles.includes("⚠️ 予算オーバーのお知らせ"), "予算超過: " + titles);
  if (target >= 0) assert.ok(titles.includes("PayCale"), "リマインダー: " + titles);
  const first = mine().length;

  await worker.scheduled({}, env); // 次のtick
  assert.equal(mine().length, first, "2回目で重複送信された");
});

await t("cron: 固定費の支払日(当日9時以降)に1回通知", async () => {
  const uid = rid();
  await post("/subscribe", { uid, subscription: { ...sub, endpoint: "https://fcm.googleapis.com/fcm/send/fixed" } });
  const n = nowJst();
  if (n.hh < 9) { console.log("    (JST 9時前のためスキップ)"); return; }
  const day = Number(n.date.slice(8));
  await post("/fixed-expenses", { uid, items: [
    { id: 7, memo: "家賃", amount: 50000, payDay: String(day) },
    { id: 8, memo: "他の日", amount: 1, payDay: day === 15 ? "16" : "15" },
  ] });
  sent.length = 0;
  await worker.scheduled({}, env);
  await worker.scheduled({}, env);
  const mine = sent.filter((s) => s.endpoint.endsWith("/fixed"));
  assert.equal(mine.length, 1);
  assert.match(mine[0].payload.body, /家賃/);
});

await t("購読が失効(410)したらKVから購読が削除される", async () => {
  const uid = rid();
  await post("/subscribe", { uid, subscription: { ...sub, endpoint: "https://fcm.googleapis.com/fcm/send/gone" } });
  failWith = Object.assign(new Error("gone"), { statusCode: 410 });
  const res = await post("/test", { uid });
  failWith = null;
  assert.equal(res.status, 410);
  assert.equal(await kv.get(`sub:${uid}`), null);
});

await t("/delete: 利用者データが全削除される", async () => {
  assert.equal((await post("/delete", { uid: uidA })).status, 200);
  for (const p of ["sub", "cfg", "cal", "shifts", "budget", "fixed", "st"]) assert.equal(await kv.get(`${p}:${uidA}`), null, p);
  assert.equal((await get(`/calendar.ics?token=${tokenA}`)).status, 403);
  assert.equal(await kv.get(`calidx:${tokenA}`), null);
});

console.log(`\n${passed} tests passed`);
