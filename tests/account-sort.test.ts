import { describe, expect, it } from "vitest";
import { sortAccountRows } from "../src/account-sort";
import type { AccountRecord } from "../src/types";

function account(id: string, provider: AccountRecord["provider"], alias: string): AccountRecord {
	return { id, provider, alias, secretId: `account-${id}`, enabled: true };
}

const NORMAL_A = account("a", "commandcode", "Command Code A");
const NORMAL_B = account("b", "opencode-go", "OpenCode Go B");
const ERROR = account("e", "volcengine", "火山方舟");
const BLOCKED = account("k", "deepseek", "DeepSeek 满额");
const ACCOUNTS = [ERROR, NORMAL_B, BLOCKED, NORMAL_A];
const SINKING = new Set([ERROR.id, BLOCKED.id]);
const LABELS = new Map([
	[ERROR.id, "火山方舟"],
	[BLOCKED.id, "DeepSeek"],
	[NORMAL_A.id, "Command Code"],
	[NORMAL_B.id, "OpenCode Go"],
]);
const METRICS = new Map([
	[NORMAL_A.id, 30],
	[NORMAL_B.id, 10],
	[ERROR.id, null],
	[BLOCKED.id, 100],
]);

const base = {
	sinking: (item: AccountRecord) => SINKING.has(item.id),
	labelOf: (item: AccountRecord) => LABELS.get(item.id) ?? item.id,
	metricOf: (item: AccountRecord) => METRICS.get(item.id) ?? null,
};

describe("sortAccountRows", () => {
	it("套餐名升序：正常账号在前，失败/满额账号沉底，组内仍按套餐名", () => {
		expect(
			sortAccountRows(ACCOUNTS, { ...base, key: "provider", dir: "asc" }).map((item) => item.id),
		).toEqual(["a", "b", "e", "k"]);
	});

	it("用量升序：异常账号沉底，不受其用量数值影响", () => {
		expect(
			sortAccountRows(ACCOUNTS, { ...base, key: "usage", dir: "asc" }).map((item) => item.id),
		).toEqual(["b", "a", "k", "e"]);
	});

	it("用量降序：正常账号倒序，异常账号仍在底部", () => {
		expect(
			sortAccountRows(ACCOUNTS, { ...base, key: "usage", dir: "desc" }).map((item) => item.id),
		).toEqual(["a", "b", "k", "e"]);
	});

	it("正常账号无数据仍排在异常账号之前（无数据不清空沉底组）", () => {
		const noData = account("n", "glm", "GLM");
		const metrics = new Map(METRICS).set(noData.id, null);
		const labels = new Map(LABELS).set(noData.id, "GLM");
		expect(
			sortAccountRows([noData, ...ACCOUNTS], {
				...base,
				labelOf: (item) => labels.get(item.id) ?? item.id,
				metricOf: (item) => metrics.get(item.id) ?? null,
				key: "usage",
				dir: "asc",
			}).map((item) => item.id),
		).toEqual(["b", "a", "n", "k", "e"]);
	});

	it("返回新数组，不改输入顺序", () => {
		const input = [...ACCOUNTS];
		sortAccountRows(input, { ...base, key: "provider", dir: "asc" });
		expect(input.map((item) => item.id)).toEqual(["e", "b", "k", "a"]);
	});
});
