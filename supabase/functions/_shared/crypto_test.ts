/**
 * 第三世界 · 函数层单元测试（无需网络、无需 Supabase）
 * 运行：cd supabase/functions && npx deno test --allow-env _shared/crypto_test.ts
 *
 * 只测两件「错了会静默出事」的东西：
 *   1. 令牌加解密往返（AES-256-GCM）
 *   2. OAuth state 的签名校验（篡改 / 过期必须失败）
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { open, seal, sha256Hex, signState, verifyState } from "./crypto.ts";

const KEY_B64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32 字节
const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const STATE_SECRET = "state-secret-for-tests-must-be-32-chars";

function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const backup: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    backup[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

Deno.test("AES-GCM：往返一致，且密文每次不同（IV 随机）", async () => {
  await withEnv({ ARC_CREDENTIAL_KEY: KEY_B64 }, async () => {
    const plain = JSON.stringify({ access_token: "at_9f2c", refresh: "rt_77" });
    const a = await seal(plain, 1);
    const b = await seal(plain, 1);

    assertStringIncludes(a.cipher, "\\x"); // PostgREST 写 bytea 的前缀
    assert(a.cipher !== b.cipher, "两次加密应产生不同密文");
    assertEquals(a.keyVersion, 1);
    assertEquals(await open(a.cipher), plain);
    assertEquals(await open(b.cipher), plain);
  });
});

Deno.test("AES-GCM：裸 hex 也能解（bytea 读回可能不带 \\x）", async () => {
  await withEnv({ ARC_CREDENTIAL_KEY: KEY_HEX }, async () => {
    const sealed = await seal("hello-第三世界");
    const bare = sealed.cipher.replace(/^\\x/, "");
    assertEquals(await open(bare), "hello-第三世界");
  });
});

Deno.test("AES-GCM：密钥长度不对要报错，而不是静默用弱密钥", async () => {
  await withEnv({ ARC_CREDENTIAL_KEY: "dG9vLXNob3J0" }, async () => {
    await assertRejects(() => seal("x"), Error, "32 字节");
  });
});

Deno.test("AES-GCM：篡改密文必须解密失败", async () => {
  await withEnv({ ARC_CREDENTIAL_KEY: KEY_B64 }, async () => {
    const s = await seal("tamper-me");
    const hex = s.cipher.replace(/^\\x/, "");
    const flipped = hex.slice(0, -2) + (hex.slice(-2) === "00" ? "01" : "00");
    await assertRejects(() => open("\\x" + flipped));
  });
});

Deno.test("state：签名可验，篡改 payload 必须失败", async () => {
  await withEnv({ ARC_STATE_SECRET: STATE_SECRET }, async () => {
    const payload = {
      device_id: "44444444-4444-4444-4444-444444444444",
      provider: "enode",
      user_id: "11111111-1111-1111-1111-111111111111",
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: "n1",
    };
    const token = await signState(payload);
    const got = await verifyState(token);
    assert(got, "合法 state 应校验通过");
    assertEquals(got!.device_id, payload.device_id);

    // 改一位 payload
    const [body, sig] = token.split(".");
    const bad = body.slice(0, -1) + (body.at(-1) === "A" ? "B" : "A") + "." + sig;
    assertEquals(await verifyState(bad), null);

    // 换签名
    assertEquals(await verifyState(body + "." + sig.slice(0, -2) + "zz"), null);
  });
});

Deno.test("state：过期必须失败", async () => {
  await withEnv({ ARC_STATE_SECRET: STATE_SECRET }, async () => {
    const token = await signState({
      device_id: "44444444-4444-4444-4444-444444444444",
      provider: "garmin",
      user_id: "11111111-1111-1111-1111-111111111111",
      exp: Math.floor(Date.now() / 1000) - 1,
      nonce: "n2",
    });
    assertEquals(await verifyState(token), null);
  });
});

Deno.test("state：密钥太短直接拒绝（避免用到弱密钥）", async () => {
  await withEnv({ ARC_STATE_SECRET: "short" }, async () => {
    await assertRejects(() =>
      signState({
        device_id: "d",
        provider: "enode",
        user_id: "u",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "n",
      }), Error, "至少 32 字符");
  });
});

Deno.test("sha256Hex：稳定且为 64 位小写 hex", async () => {
  const a = await sha256Hex("第三世界");
  const b = await sha256Hex("第三世界");
  assertEquals(a, b);
  assert(/^[0-9a-f]{64}$/.test(a));
});
