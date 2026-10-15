// PayCale 配信(public)版 Cloudflare Worker
// - 複数ユーザー対応: クライアントが発行するランダムな uid ごとに KV のキーを分離する
// - 役割: Web Push 送信 / 5分おきの cron 通知判定 / シフトの iCalendar(.ics) 配信
// - 秘密情報: VAPID_PRIVATE は wrangler secret で渡す(ソースに書かない)
//
// KV(SUBS) のキー設計 (すべて uid 単位):
//   sub:<uid>    Push購読情報 (cronはこのキーを list して利用者を列挙する)
//   cfg:<uid>    { reminder:{enabled,time}, shiftAlert:{enabled,minutesBefore} }
//   shifts:<uid> 直近3日分のシフト(開始前通知用)
//   budget:<uid> { month, items:[{category,limit,used}] }
//   fixed:<uid>  固定費一覧 [{id,memo,amount,payDay}]
//   cal:<uid>    { token, shifts:[...] }  カレンダー購読用(書き込みはuid+token、読み出しはtokenのみ)
//   calidx:<token> -> uid   購読URLに uid を載せずに済ませるための逆引き
//   st:<uid>     cronだけが書く「送信済み」記録(重複送信防止)
//   rl:<uid>     /test のレート制限(TTL 60秒)

import webpush from "web-push";

const UID_RE = /^[A-Za-z0-9]{16,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_BODY_BYTES = 1_000_000;
const MAX_CAL_SHIFTS = 5000;

// Web Push の送信先として許可するホスト。購読情報の endpoint はクライアントから届く値なので、
// 任意のURLへWorkerからPOSTさせられない(SSRF)ように主要ブラウザの配信サービスだけ許す。
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

const CHEER_MESSAGES = [
  "頑張って！応援してるよ📣",
  "今日もお疲れ様、無理せずいこう😊",
  "あなたなら大丈夫、いってらっしゃい！",
  "ファイト！終わったら好きなもの食べよう🍜",
  "今日も一日頑張ろう、応援してる！",
  "肩の力を抜いて、いつも通りでOK👍",
  "シフト頑張って！稼いだ分、自分にご褒美もね🎁",
  "今日のあなたも最高にえらい！",
  "焦らずマイペースで、いってらっしゃい✨",
  "今日を乗り越えたら、また一歩前進！",
  "水分補給と休憩、忘れずにね💧",
  "あなたの頑張り、ちゃんと見てるよ！",
];

// ---------- 共通ヘルパー ----------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function jsonResponse(env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(env), "Content-Type": "application/json" },
  });
}

function textResponse(env, text, status = 200) {
  return new Response(text, { status, headers: corsHeaders(env) });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: "payload too large", status: 413 };
  try {
    return { data: JSON.parse(text) };
  } catch (e) {
    return { error: "invalid json", status: 400 };
  }
}

// タイミング攻撃を避けるための固定時間比較(トークン照合用)
function safeEqual(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function kvGetJson(env, key, fallback) {
  const raw = await env.SUBS.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function isAllowedPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    return PUSH_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith("." + s));
  } catch (e) {
    return false;
  }
}

function sanitizeShift(s, withId) {
  if (!s || !DATE_RE.test(s.date || "") || !TIME_RE.test(s.startTime || "") || !TIME_RE.test(s.endTime || "")) return null;
  const out = {
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    jobName: String(s.jobName ?? "").slice(0, 100),
    pay: Number(s.pay) || 0,
  };
  if (withId) out.id = String(s.id ?? "").slice(0, 64);
  return out;
}

function getJstNow() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const hh = Number(get("hour")) % 24; // 一部環境で0時が"24"になるため
  const mm = Number(get("minute"));
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    monthStr: `${get("year")}-${get("month")}`,
    day: Number(get("day")),
    year: Number(get("year")),
    month: Number(get("month")),
    minutesOfDay: hh * 60 + mm,
  };
}

function setupVapid(env) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) {
    throw new Error("VAPID_PUBLIC / VAPID_PRIVATE が未設定です(wrangler.toml の vars と wrangler secret を確認)");
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT || "mailto:admin@example.com", env.VAPID_PUBLIC, env.VAPID_PRIVATE);
}

// Push送信。購読が失効(404/410)していたらKVから消して "gone" を返す
async function sendPush(env, uid, sub, payload) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: "normal" });
    return "ok";
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      await env.SUBS.delete(`sub:${uid}`);
      return "gone";
    }
    console.error("push failed", uid.slice(0, 6), e && e.statusCode, e && e.body);
    return "error";
  }
}

// ---------- iCalendar ----------

function icsEscape(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function buildIcsCalendar(shifts) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//PayCale//Shift Calendar//JA", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", "X-WR-CALNAME:PayCale シフト", "X-WR-TIMEZONE:Asia/Tokyo",
    "BEGIN:VTIMEZONE", "TZID:Asia/Tokyo", "BEGIN:STANDARD", "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:JST", "END:STANDARD", "END:VTIMEZONE",
  ];
  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  (shifts || []).forEach((s) => {
    if (!s.date || !s.startTime || !s.endTime) return;
    const [y, mo, d] = s.date.split("-").map(Number);
    const [sh, sm] = s.startTime.split(":");
    const [eh, em] = s.endTime.split(":");
    const overnight = s.endTime <= s.startTime; // 日をまたぐ夜勤

    // 終了日は純粋なカレンダー計算で求める(タイムゾーンによる前日ズレを避けるためDate.UTCを電卓として使う)
    let endY = y, endMo = mo, endD = d;
    if (overnight) {
      const c = new Date(Date.UTC(y, mo - 1, d));
      c.setUTCDate(c.getUTCDate() + 1);
      endY = c.getUTCFullYear(); endMo = c.getUTCMonth() + 1; endD = c.getUTCDate();
    }
    const pad = (n) => String(n).padStart(2, "0");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${s.id || `${s.date}-${s.startTime}`}@paycale`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;TZID=Asia/Tokyo:${y}${pad(mo)}${pad(d)}T${sh}${sm}00`);
    lines.push(`DTEND;TZID=Asia/Tokyo:${endY}${pad(endMo)}${pad(endD)}T${eh}${em}00`);
    lines.push(`SUMMARY:${icsEscape(`${s.jobName || "シフト"} (${s.startTime}〜${s.endTime})`)}`);
    lines.push(`DESCRIPTION:${icsEscape(`見込み給料: ¥${Number(s.pay || 0).toLocaleString("ja-JP")}`)}`);
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// ---------- HTTP ハンドラ ----------

// uid を body から取り出して検証する。以降のPOSTはすべてこの uid のキーにしか触れない
function requireUid(data) {
  const uid = data && data.uid;
  return typeof uid === "string" && UID_RE.test(uid) ? uid : null;
}

async function handlePost(request, env, pathname) {
  const parsed = await readJson(request);
  if (parsed.error) return textResponse(env, parsed.error, parsed.status);
  const data = parsed.data;
  const uid = requireUid(data);
  if (!uid) return textResponse(env, "invalid uid", 400);

  switch (pathname) {
    case "/subscribe": {
      const sub = data.subscription;
      if (!sub || typeof sub.endpoint !== "string" || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return textResponse(env, "invalid subscription", 400);
      }
      if (!isAllowedPushEndpoint(sub.endpoint)) return textResponse(env, "endpoint not allowed", 400);
      await env.SUBS.put(`sub:${uid}`, JSON.stringify({
        endpoint: sub.endpoint,
        expirationTime: sub.expirationTime ?? null,
        keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
      }));
      return textResponse(env, "ok");
    }

    case "/reminder": {
      const time = TIME_RE.test(data.time || "") ? data.time : "21:00";
      const cfg = await kvGetJson(env, `cfg:${uid}`, {});
      cfg.reminder = { enabled: !!data.enabled, time };
      await env.SUBS.put(`cfg:${uid}`, JSON.stringify(cfg));
      return textResponse(env, "ok");
    }

    case "/shift-alert-settings": {
      const n = Number(data.minutesBefore);
      const minutesBefore = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 24 * 60) : 60;
      const cfg = await kvGetJson(env, `cfg:${uid}`, {});
      cfg.shiftAlert = { enabled: !!data.enabled, minutesBefore };
      await env.SUBS.put(`cfg:${uid}`, JSON.stringify(cfg));
      return textResponse(env, "ok");
    }

    case "/shifts": {
      const list = (Array.isArray(data.shifts) ? data.shifts : []).slice(0, 200)
        .map((s) => sanitizeShift(s, false)).filter(Boolean);
      await env.SUBS.put(`shifts:${uid}`, JSON.stringify(list));
      return textResponse(env, "ok");
    }

    case "/calendar-shifts": {
      const token = data.token;
      if (typeof token !== "string" || !UID_RE.test(token)) return textResponse(env, "invalid token", 400);
      const existing = await kvGetJson(env, `cal:${uid}`, null);
      // 一度決めたトークンは変えられない(uidを知っていても他人のカレンダーは書き換えられない)
      if (existing && !safeEqual(existing.token, token)) return textResponse(env, "forbidden", 403);
      // 他人のtokenを乗っ取って自分のカレンダーに紐付けることも拒否する
      const owner = await env.SUBS.get(`calidx:${token}`);
      if (owner && owner !== uid) return textResponse(env, "forbidden", 403);
      const list = (Array.isArray(data.shifts) ? data.shifts : []).slice(0, MAX_CAL_SHIFTS)
        .map((s) => sanitizeShift(s, true)).filter(Boolean);
      await env.SUBS.put(`cal:${uid}`, JSON.stringify({ token, shifts: list }));
      if (!owner) await env.SUBS.put(`calidx:${token}`, uid);
      return textResponse(env, "ok");
    }

    case "/fixed-expenses": {
      const items = (Array.isArray(data.items) ? data.items : []).slice(0, 100).map((f) => ({
        id: String(f && f.id != null ? f.id : "").slice(0, 64),
        memo: String((f && f.memo) ?? "").slice(0, 100),
        amount: Number(f && f.amount) || 0,
        payDay: f && (f.payDay === "末日" ? "末日" : Number(f.payDay) || null),
      })).filter((f) => f.id && f.payDay);
      await env.SUBS.put(`fixed:${uid}`, JSON.stringify(items));
      return textResponse(env, "ok");
    }

    case "/budget-status": {
      const items = (Array.isArray(data.items) ? data.items : []).slice(0, 50).map((i) => ({
        category: String((i && i.category) ?? "").slice(0, 50),
        limit: Number(i && i.limit) || 0,
        used: Number(i && i.used) || 0,
      })).filter((i) => i.category && i.limit > 0);
      await env.SUBS.put(`budget:${uid}`, JSON.stringify({ month: String(data.month || "").slice(0, 7), items }));
      return textResponse(env, "ok");
    }

    case "/test": {
      // 連打によるPush乱用を防ぐ(同一uidは60秒に1回)
      if (await env.SUBS.get(`rl:${uid}`)) return textResponse(env, "too many requests", 429);
      const sub = await kvGetJson(env, `sub:${uid}`, null);
      if (!sub) return textResponse(env, "まだ通知の登録がされてません", 400);
      await env.SUBS.put(`rl:${uid}`, "1", { expirationTtl: 60 });
      setupVapid(env);
      const result = await sendPush(env, uid, sub, { title: "PayCale", body: "テスト通知だよ！", tag: "paycale-test" });
      if (result === "gone") return textResponse(env, "通知の登録が失効しています。もう一度「通知を有効にする」を押してください", 410);
      if (result !== "ok") return textResponse(env, "send failed", 502);
      return textResponse(env, "sent");
    }

    case "/delete": {
      // 利用者のデータをすべて削除する(プライバシー対応)
      const cal = await kvGetJson(env, `cal:${uid}`, null);
      if (cal && cal.token) await env.SUBS.delete(`calidx:${cal.token}`);
      await Promise.all(["sub", "cfg", "shifts", "budget", "fixed", "cal", "st", "rl"].map((p) => env.SUBS.delete(`${p}:${uid}`)));
      return textResponse(env, "deleted");
    }

    default:
      return textResponse(env, "not found", 404);
  }
}

// 購読URL: /calendar.ics?token=<token>  (uid は URL に載せない。旧形式の &uid= が付いていても無視する)
async function handleCalendar(url, env) {
  const token = url.searchParams.get("token") || "";
  // 不正・不一致・未登録のいずれでも同じ403(存在有無を探られないようにする)
  if (!UID_RE.test(token)) return textResponse(env, "forbidden", 403);
  const uid = await env.SUBS.get(`calidx:${token}`);
  const cal = uid ? await kvGetJson(env, `cal:${uid}`, null) : null;
  if (!cal || !safeEqual(cal.token, token)) return textResponse(env, "forbidden", 403);
  return new Response(buildIcsCalendar(cal.shifts), {
    headers: { ...corsHeaders(env), "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------- cron (5分おき) ----------

async function processUser(env, uid, now) {
  const sub = await kvGetJson(env, `sub:${uid}`, null);
  if (!sub) return;
  const cfg = await kvGetJson(env, `cfg:${uid}`, {});
  let st = null;
  let stDirty = false;
  const loadSt = async () => {
    if (!st) st = await kvGetJson(env, `st:${uid}`, {});
    return st;
  };
  const send = (payload) => sendPush(env, uid, sub, payload);

  // ① 入力忘れリマインダー: 設定時刻から15分以内、かつ今日まだ送っていなければ送る
  //    (cronが1回飛んでも取りこぼさないよう、ぴったり一致ではなく幅を持たせている)
  if (cfg.reminder && cfg.reminder.enabled) {
    const [h, m] = (cfg.reminder.time || "21:00").split(":").map(Number);
    const target = h * 60 + m;
    if (now.minutesOfDay >= target && now.minutesOfDay < target + 15) {
      const s = await loadSt();
      if (s.reminderLast !== now.dateStr) {
        const r = await send({ title: "PayCale", body: "📝 今日の支出・収入を入力し忘れていませんか？", tag: "paycale-reminder" });
        if (r === "gone") return;
        if (r === "ok") { s.reminderLast = now.dateStr; stDirty = true; }
      }
    }
  }

  // ② シフト開始前通知
  if (cfg.shiftAlert && cfg.shiftAlert.enabled) {
    const shifts = await kvGetJson(env, `shifts:${uid}`, []);
    if (shifts.length) {
      const s = await loadSt();
      let alerted = Array.isArray(s.shiftAlerted) ? s.shiftAlerted : [];
      const nowMs = Date.now();
      const before = Number(cfg.shiftAlert.minutesBefore);
      const minutesBefore = Number.isFinite(before) ? before : 60;
      for (const shift of shifts) {
        const startMs = new Date(`${shift.date}T${shift.startTime}:00+09:00`).getTime();
        if (isNaN(startMs)) continue;
        const targetMs = startMs - minutesBefore * 60000;
        const key = `${shift.date}|${shift.startTime}|${shift.jobName}`;
        // 通知予定時刻から15分以内なら送る(cronの取りこぼし対策)
        if (nowMs >= targetMs && nowMs < targetMs + 15 * 60000 && !alerted.includes(key)) {
          const cheer = CHEER_MESSAGES[Math.floor(Math.random() * CHEER_MESSAGES.length)];
          const r = await send({
            title: "⏰ まもなくシフト開始！",
            body: `${shift.jobName} ${shift.startTime}〜${shift.endTime}\n見込み給料: ¥${Number(shift.pay || 0).toLocaleString("ja-JP")}\n${cheer}`,
            tag: `paycale-shift-${key}`,
          });
          if (r === "gone") return;
          if (r === "ok") { alerted.push(key); s.shiftAlerted = alerted.slice(-200); stDirty = true; }
        }
      }
    }
  }

  // ③ カテゴリ別予算の超過通知(月ごとに1カテゴリ1回)
  const budget = await kvGetJson(env, `budget:${uid}`, null);
  if (budget && Array.isArray(budget.items) && budget.items.some((i) => i.used >= i.limit)) {
    const s = await loadSt();
    let alertedBudget = (Array.isArray(s.budgetAlerted) ? s.budgetAlerted : []).filter((k) => k.startsWith(`${now.monthStr}|`));
    for (const item of budget.items) {
      if (item.used < item.limit) continue;
      const key = `${now.monthStr}|${item.category}`;
      if (alertedBudget.includes(key)) continue;
      const over = item.used - item.limit;
      const r = await send({
        title: "⚠️ 予算オーバーのお知らせ",
        body: `「${item.category}」が今月の上限¥${item.limit.toLocaleString("ja-JP")}を¥${over.toLocaleString("ja-JP")}超過しています（使用額¥${item.used.toLocaleString("ja-JP")}）`,
        tag: `paycale-budget-${key}`,
      });
      if (r === "gone") return;
      if (r === "ok") { alertedBudget.push(key); s.budgetAlerted = alertedBudget; stDirty = true; }
    }
  }

  // ④ 固定費の支払日リマインダー: 当日9:00以降の最初のcronで1回だけ(深夜に鳴らさない)
  if (now.minutesOfDay >= 9 * 60) {
    const s = await loadSt();
    if (s.fixedDoneDate !== now.dateStr) {
      const fixed = await kvGetJson(env, `fixed:${uid}`, []);
      const lastDay = new Date(now.year, now.month, 0).getDate();
      let alertedFixed = (Array.isArray(s.fixedAlerted) ? s.fixedAlerted : []).slice(-60);
      let allOk = true;
      for (const item of fixed) {
        // 31日指定の月に31日が無い場合などは月末扱いにする
        const payDay = item.payDay === "末日" ? lastDay : Math.min(Number(item.payDay), lastDay);
        if (payDay !== now.day) continue;
        const key = `${now.dateStr}|${item.id}`;
        if (alertedFixed.includes(key)) continue;
        const r = await send({
          title: "🏠 固定費の支払日です",
          body: `「${item.memo}」(¥${Number(item.amount || 0).toLocaleString("ja-JP")})の支払日です。支出として記録しましたか？`,
          tag: `paycale-fixed-${key}`,
        });
        if (r === "gone") return;
        if (r === "ok") alertedFixed.push(key); else allOk = false;
      }
      s.fixedAlerted = alertedFixed;
      if (allOk) s.fixedDoneDate = now.dateStr; // 今日分が済んだら以降のtickでは固定費のKV読み取りを省く
      stDirty = true;
    }
  }

  if (stDirty && st) await env.SUBS.put(`st:${uid}`, JSON.stringify(st));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });

    try {
      if (request.method === "GET" && pathname === "/health") {
        // vapid: 公開鍵の先頭(フロントのPUSH_VAPID_PUBLICと一致しているかの目視確認用)
        return jsonResponse(env, { ok: true, time: new Date().toISOString(), vapid: (env.VAPID_PUBLIC || "").slice(0, 12) });
      }
      if (request.method === "GET" && pathname === "/calendar.ics") return await handleCalendar(url, env);
      if (request.method === "POST") return await handlePost(request, env, pathname);
    } catch (e) {
      console.error("request failed", pathname, e);
      return textResponse(env, "internal error", 500);
    }
    return textResponse(env, "not found", 404);
  },

  async scheduled(event, env) {
    setupVapid(env);
    const now = getJstNow();
    let cursor;
    do {
      const page = await env.SUBS.list({ prefix: "sub:", cursor });
      const uids = page.keys.map((k) => k.name.slice(4));
      // 並列数を絞って処理(1人のエラーが他の人に影響しないよう個別にcatch)
      for (let i = 0; i < uids.length; i += 10) {
        await Promise.all(uids.slice(i, i + 10).map((uid) =>
          processUser(env, uid, now).catch((e) => console.error("processUser failed", uid.slice(0, 6), e))));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  },
};
