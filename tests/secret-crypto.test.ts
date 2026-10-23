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

	it("解密按 blob 的 iterations 派生：iterations=1000 固定向量可解", async () => {
		// 由 Node WebCrypto 生成的固定向量（PBKDF2-SHA256 × 1000，固定 salt/iv）：
		// 若解密写死 310k 迭代，这里必然失败——证明派生参数来自 blob。
		const blob =
			'{"v":1,"kdf":"PBKDF2-SHA256","iterations":1000,"salt":"AAECAwQFBgcICQoLDA0ODw==","iv":"EBESExQVFhcYGRob","ct":"qBGoVO9Ntqpmkazw1Xtxh0q921ftbmEGtoKUBtXFba8J8+s2"}';
		await expect(decryptSecret(blob, "vector-passphrase")).resolves.toBe("vector-secret-向量");
	});

	it("iterations 被篡改时拒绝", async () => {
		const parsed = JSON.parse(await encryptSecret("super-secret-key", PASSPHRASE)) as { iterations: unknown };
		// 改成合法但不同的小值：格式通过，密钥不对 → 解密失败（若忽略 blob 参数则会错误地成功）。
		parsed.iterations = 1;
		await expect(decryptSecret(JSON.stringify(parsed), PASSPHRASE)).rejects.toThrow("decrypt failed");
		// 非法值（非正整数 / 超上限 / 非数字）：按格式不支持拒绝。
		for (const bad of [0, -1, 1.5, 10_000_001, "310000", null]) {
			parsed.iterations = bad;
			await expect(decryptSecret(JSON.stringify(parsed), PASSPHRASE)).rejects.toThrow("unsupported blob format");
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
