import { describe, expect, it } from "vitest";
import { normalizeAccounts } from "../src/types";

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
