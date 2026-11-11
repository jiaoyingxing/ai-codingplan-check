import { describe, expect, it } from "vitest";
import { normalizeAccounts, normalizeDevices } from "../src/types";

describe("normalizeAccounts", () => {
	it("非数组或空数组返回空数组（旧/手改坏的 data.json 不崩）", () => {
		expect(normalizeAccounts(undefined)).toEqual([]);
		expect(normalizeAccounts(null)).toEqual([]);
		expect(normalizeAccounts("accounts")).toEqual([]);
		expect(normalizeAccounts({ id: "a" })).toEqual([]);
		expect(normalizeAccounts([])).toEqual([]);
	});

	it("合法记录原样保留", () => {
		const record = {
			id: "a",
			provider: "glm",
			alias: "主号",
			secretId: "account-a",
			enabled: true,
			encSecret: "cipher",
		};
		expect(normalizeAccounts([record])).toEqual([record]);
	});

	it("缺字段或字段类型不对的记录整条丢弃", () => {
		expect(
			normalizeAccounts([
				null,
				"x",
				42,
				{ provider: "glm", secretId: "s" },
				{ id: "", provider: "glm", secretId: "s" },
				{ id: "a", provider: "", secretId: "s" },
				{ id: "b", provider: "glm", secretId: "" },
				{ id: 1, provider: "glm", secretId: "s" },
			]),
		).toEqual([]);
	});

	it("alias 非字符串回空串；provider 只要求非空字符串（未知来源交给 UI 兜底）", () => {
		expect(normalizeAccounts([{ id: "a", provider: "future-provider", alias: 42, secretId: "account-a" }])).toEqual([
			{ id: "a", provider: "future-provider", alias: "", secretId: "account-a", enabled: true },
		]);
	});

	it("enabled 缺省按启用，仅显式 false 视为停用", () => {
		const base = { id: "a", provider: "glm", alias: "主号", secretId: "account-a" };
		expect(normalizeAccounts([base])[0]!.enabled).toBe(true);
		expect(normalizeAccounts([{ ...base, enabled: undefined }])[0]!.enabled).toBe(true);
		expect(normalizeAccounts([{ ...base, enabled: "false" }])[0]!.enabled).toBe(true);
		expect(normalizeAccounts([{ ...base, enabled: false }])[0]!.enabled).toBe(false);
	});

	it("encSecret 只保留非空字符串，其余整字段丢弃", () => {
		const base = { id: "a", provider: "glm", alias: "主号", secretId: "account-a" };
		expect(normalizeAccounts([{ ...base, encSecret: "cipher" }])[0]).toHaveProperty("encSecret", "cipher");
		expect(normalizeAccounts([{ ...base, encSecret: "" }])[0]).not.toHaveProperty("encSecret");
		expect(normalizeAccounts([{ ...base, encSecret: 123 }])[0]).not.toHaveProperty("encSecret");
	});

	it("lastPlan 只保留 periodEnd 为正数的存档（§v1.13）；坏形整份丢弃，name 非法不带走", () => {
		const base = { id: "a", provider: "commandcode", alias: "主号", secretId: "account-a" };
		const valid = { name: "Pro 档", periodEnd: 1_794_000_000_000, observedAt: 1_000 };
		expect(normalizeAccounts([{ ...base, lastPlan: valid }])[0]).toHaveProperty("lastPlan", valid);
		expect(normalizeAccounts([{ ...base, lastPlan: { periodEnd: 42 } }])[0]).toHaveProperty("lastPlan", {
			periodEnd: 42,
			observedAt: 0,
		});
		expect(normalizeAccounts([{ ...base, lastPlan: { periodEnd: 0 } }])[0]).not.toHaveProperty("lastPlan");
		expect(normalizeAccounts([{ ...base, lastPlan: { periodEnd: "x" } }])[0]).not.toHaveProperty("lastPlan");
		expect(normalizeAccounts([{ ...base, lastPlan: null }])[0]).not.toHaveProperty("lastPlan");
		expect(normalizeAccounts([{ ...base, lastPlan: { periodEnd: 42, name: 7 } }])[0]).toHaveProperty("lastPlan", {
			periodEnd: 42,
			observedAt: 0,
		});
	});

	it("同 id 去重保留首个", () => {
		const result = normalizeAccounts([
			{ id: "a", provider: "glm", alias: "首个", secretId: "account-a" },
			{ id: "a", provider: "kimi-for-coding", alias: "重复", secretId: "account-dup" },
			{ id: "b", provider: "deepseek", alias: "第二个", secretId: "account-b" },
		]);
		expect(result.map((account) => account.id)).toEqual(["a", "b"]);
		expect(result[0]!.alias).toBe("首个");
	});
});

describe("normalizeDevices", () => {
	it("非数组返回空数组；合法条目原样保留", () => {
		expect(normalizeDevices(undefined)).toEqual([]);
		expect(normalizeDevices({})).toEqual([]);
		const record = {
			id: "device-a",
			exportEnabled: true,
			copyGeneration: 3,
			imported: { "account-a": "0123456789abcdef" },
			updatedAt: 1700000000000,
		};
		expect(normalizeDevices([record])).toEqual([record]);
	});

	it("缺 id 或类型不对的条目整条丢弃；同 id 去重保留首个", () => {
		const result = normalizeDevices([
			null,
			"x",
			{ exportEnabled: true },
			{ id: "", exportEnabled: true },
			{ id: "a", exportEnabled: false, copyGeneration: 1 },
			{ id: "a", exportEnabled: true, copyGeneration: 9 },
		]);
		expect(result.map((device) => device.id)).toEqual(["a"]);
		expect(result[0]!.copyGeneration).toBe(1);
	});

	it("字段类型不对时给安全默认值", () => {
		expect(
			normalizeDevices([
				{
					id: "a",
					exportEnabled: "true",
					copyGeneration: -1,
					imported: "bad",
					updatedAt: "now",
				},
			]),
		).toEqual([{ id: "a", exportEnabled: false, copyGeneration: 0, imported: {}, updatedAt: 0 }]);
	});

	it("imported 只保留非空字符串指纹", () => {
		const result = normalizeDevices([
			{
				id: "a",
				exportEnabled: false,
				imported: { ok: "fingerprint", empty: "", wrong: 42 },
			},
		]);
		expect(result[0]!.imported).toEqual({ ok: "fingerprint" });
	});
});
