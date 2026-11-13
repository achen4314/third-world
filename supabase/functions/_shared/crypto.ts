/**
 * 第三世界 · Edge Function 共享：凭据加密与 OAuth state 签名
 *
 * 两件事：
 *   1. 厂商 OAuth 令牌落库前用 AES-256-GCM 加密（密钥只存在服务端环境变量
 *      ARC_CREDENTIAL_KEY，绝不进前端、不进 git、不进 Supabase 表）。
 *   2. OAuth state 用 HMAC 自签（无状态，不用建表），防 CSRF 与设备错配。
 *
 * 关于 bytea：device_credentials.access_token_cipher 是 bytea，PostgREST 只接受
 * \x<hex> 形式的字符串，所以这里直接产出该格式，避免前端/函数各自转码出错。
 */

const CRED_KEY_ENV = "ARC_CREDENTIAL_KEY";
const STATE_KEY_ENV = "ARC_STATE_SECRET";

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function aesKey(): Promise<CryptoKey> {
  const raw = Deno.env.get(CRED_KEY_ENV);
  if (!raw) throw new Error(`${CRED_KEY_ENV} 未配置`);
  // 接受 base64（推荐，44 字符）或 64 位 hex
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw) ? hexToBytes(raw) : b64ToBytes(raw);
  if (bytes.length !== 32) {
    throw new Error(`${CRED_KEY_ENV} 必须是 32 字节（base64 或 64 位 hex），当前 ${bytes.length} 字节`);
  }
  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export type Sealed = { cipher: string; keyVersion: number };

/** 加密：IV(12B) || 密文+tag，整体 hex，前缀 \x 供 PostgREST 写 bytea */
export async function seal(plaintext: string, keyVersion = 1): Promise<Sealed> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + enc.length);
  packed.set(iv, 0);
  packed.set(enc, iv.length);
  return { cipher: "\\x" + bytesToHex(packed), keyVersion };
}

/** 解密：入参可为 \x<hex> 或裸 hex（从 bytea 读回时 PostgREST 给的是 \x<hex>） */
export async function open(cipher: string): Promise<string> {
  const key = await aesKey();
  const hex = cipher.replace(/^\\x/, "").replace(/^0x/, "");
  const packed = hexToBytes(hex);
  const iv = packed.slice(0, 12);
  const body = packed.slice(12);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body);
  return new TextDecoder().decode(dec);
}

/* ── OAuth state：HMAC-SHA256 自签，格式 payload.signature（都走 base64url）──── */

export type StatePayload = {
  device_id: string;
  provider: string;
  user_id: string;
  exp: number; // unix 秒
  nonce: string;
};

async function stateKey(): Promise<CryptoKey> {
  const secret = Deno.env.get(STATE_KEY_ENV);
  if (!secret || secret.length < 32) {
    throw new Error(`${STATE_KEY_ENV} 未配置或过短（至少 32 字符）`);
  }
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signState(p: StatePayload): Promise<string> {
  const body = bytesToB64(new TextEncoder().encode(JSON.stringify(p)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await stateKey(), new TextEncoder().encode(body)),
  );
  const s = bytesToB64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${s}`;
}

export async function verifyState(token: string, now = Math.floor(Date.now() / 1000)): Promise<StatePayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await stateKey(),
    b64ToBytes(sig.replace(/-/g, "+").replace(/_/g, "/")),
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  const p = JSON.parse(new TextDecoder().decode(b64ToBytes(body.replace(/-/g, "+").replace(/_/g, "/")))) as StatePayload;
  if (!p.exp || p.exp < now) return null;
  return p;
}

/** 导出给对账脚本用：sha256 十六进制 */
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(d));
}
