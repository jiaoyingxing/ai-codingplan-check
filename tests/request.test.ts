import { describe, expect, it, vi } from "vitest";
import { firstSuccessful } from "../src/adapters/request";

// request.ts 不依赖 obsidian（纯函数），无需 mock 宿主。

describe("firstSuccessful", () => {
	it("第一个成功即返回，后续端点不再请求", async () => {
		const later = vi.fn();
		const value = await firstSuccessful("X 失败", [
			{ name: "甲站", run: async () => ({ failure: "boom" }) },
			{ name: "乙站", run: async () => ({ value: 42 }) },
			{ name: "丙站", run: later },
		]);
		expect(value).toBe(42);
		expect(later).not.toHaveBeenCalled();
	});

	it("全失败且同因：端点名并列，同一句话只出现一次", async () => {
		const same = async () => ({ failure: "凭证被拒" });
		await expect(
			firstSuccessful("X 失败", [
				{ name: "甲站", run: same },
				{ name: "乙站", run: same },
				{ name: "丙站", run: same },
			]),
		).rejects.toThrow("X 失败：甲站、乙站、丙站同因：凭证被拒");
	});

	it("全失败且异因：逐条列出端点与原因", async () => {
		await expect(
			firstSuccessful("X 失败", [
				{ name: "甲站", run: async () => ({ failure: "HTTP 502：boom" }) },
				{ name: "乙站", run: async () => ({ failure: "凭证被拒" }) },
			]),
		).rejects.toThrow("X 失败：甲站 HTTP 502：boom；乙站 凭证被拒");
	});
});
