import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/secret-crypto";

const PASSPHRASE = "correct horse battery staple";

describe("secret-crypto", () => {
	it("加解密往返：ASCII / 中文 / AK-SK JSON 长串", async () => {
		const samples = [
			"sk-abc123",
			"密钥测试-中文内容",
			'{"ak":"LTAI5tEXAMPLE","sk":"Y7hZEXAMPLEKEY9x2PqR"}',
			"x".repeat(2048),
		];
		for (const plain of samples) {
			const blob = await encryptSecret(plain, PASSPHRASE);
			expect(await decryptSecret(blob, PASSPHRASE)).toBe(plain);
		}
	});

	it("同一明文两次加密密文不同（随机 salt/iv）", async () => {
		const a = await encryptSecret("same-plain", PASSPHRASE);
		const b = await encryptSecret("same-plain", PASSPHRASE);
		expect(a).not.toBe(b);
		expect(await decryptSecret(a, PASSPHRASE)).toBe("same-plain");
		expect(await decryptSecret(b, PASSPHRASE)).toBe("same-plain");
	});

	it("错误口令抛错且不含敏感内容", async () => {
		const blob = await encryptSecret("super-secret-key", PASSPHRASE);
		await expect(decryptSecret(blob, "wrong-passphrase")).rejects.toThrow("decrypt failed");
		await expect(decryptSecret(blob, "wrong-passphrase")).rejects.not.toThrow(/super-secret/);
	});

	it("密文被篡改时抛错", async () => {
		const blob = await encryptSecret("super-secret-key", PASSPHRASE);
		const parsed = JSON.parse(blob) as { ct: string };
		parsed.ct = `${parsed.ct.slice(0, -2)}AA`;
		await expect(decryptSecret(JSON.stringify(parsed), PASSPHRASE)).rejects.toThrow();
	});

	it("非法/异版本文档抛格式错", async () => {
		await expect(decryptSecret("not-json", PASSPHRASE)).rejects.toThrow("not valid JSON");
		await expect(decryptSecret('{"v":99}', PASSPHRASE)).rejects.toThrow("unsupported blob format");
	});
});
