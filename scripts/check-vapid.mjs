// VAPID秘密鍵が公開鍵と対応しているか確認する。
// 使い方: VAPID_PRIVATE=<秘密鍵> node scripts/check-vapid.mjs <公開鍵(省略時はwrangler.tomlの値)>
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const priv = process.env.VAPID_PRIVATE;
let pub = process.argv[2];
if (!pub) {
  const toml = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  pub = (toml.match(/VAPID_PUBLIC\s*=\s*"([^"]+)"/) || [])[1];
}
if (!priv || !pub) { console.error("VAPID_PRIVATE 環境変数と公開鍵が必要です"); process.exit(2); }

const ecdh = createECDH("prime256v1");
ecdh.setPrivateKey(Buffer.from(priv, "base64url"));
const derived = b64u(ecdh.getPublicKey(null, "uncompressed"));
if (derived === pub) { console.log("OK: 秘密鍵と公開鍵は対応しています"); }
else { console.error("NG: 秘密鍵から導出した公開鍵が一致しません\n  導出: " + derived + "\n  指定: " + pub); process.exit(1); }
