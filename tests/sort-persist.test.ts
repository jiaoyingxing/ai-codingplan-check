import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_SORT, normalizeSort } from "../src/types";

describe("normalizeSort", () => {
	it("缺失或非对象一律回默认（旧 data.json 无 sort 字段）", () => {
		expect(normalizeSort(undefined)).toEqual(DEFAULT_SORT);
		expect(normalizeSort(null)).toEqual(DEFAULT_SORT);
		expect(normalizeSort("usage")).toEqual(DEFAULT_SORT);
		expect(normalizeSort({})).toEqual(DEFAULT_SORT);
	});

	it("合法选择原样保留（面板选择持久化后重启沿用）", () => {
		expect(normalizeSort({ key: "usage", dir: "desc" })).toEqual({ key: "usage", dir: "desc" });
		expect(normalizeSort({ key: "reset", dir: "asc" })).toEqual({ key: "reset", dir: "asc" });
		expect(normalizeSort({ key: "provider", dir: "desc" })).toEqual({ key: "provider", dir: "desc" });
	});

	it("未知排序键回默认；方向只认 desc，其余按 asc", () => {
		expect(normalizeSort({ key: "size", dir: "desc" })).toEqual(DEFAULT_SORT);
		expect(normalizeSort({ key: "provider", dir: "sideways" })).toEqual({ key: "provider", dir: "asc" });
		expect(normalizeSort({ key: "usage" })).toEqual({ key: "usage", dir: "asc" });
	});

	it("返回值与默认常量不共享引用（避免后续写入污染默认值）", () => {
		const first = normalizeSort(undefined);
		first.key = "reset";
		expect(normalizeSort(undefined)).toEqual(DEFAULT_SORT);
		expect(DEFAULT_SETTINGS.sort).toEqual(DEFAULT_SORT);
	});
});
