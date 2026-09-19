import { describe, expect, it, vi } from "vitest";
import { parseResetAt, parseUsagePayload } from "../src/adapters/opencode-go";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock；
// 本文件只测纯解析逻辑，requestUrl 不会被调用。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const NOW = 1_700_000_000_000;

describe("parseUsagePayload", () => {
	it("解析三窗口响应（percent=已用份额，ISO resetsAt）", () => {
		const snapshot = parseUsagePayload(
			{
				usage: {
					rolling: { status: "ok", percent: 63, resetsAt: "2026-09-20T12:00:00Z" },
					weekly: { status: "ok", percent: 41, resetsAt: 1_700_100_000 },
					monthly: { status: "ok", percent: 12.4, resetsAt: 1_700_100_000_000 },
				},
			},
			NOW,
		);
		expect(snapshot).toBeDefined();
		expect(snapshot!.windows.map((w) => w.key)).toEqual(["rolling", "weekly", "monthly"]);
		expect(snapshot!.windows[0]!.usedPercent).toBe(63);
		expect(snapshot!.windows[1]!.resetsAt).toBe(1_700_100_000_000);
		expect(snapshot!.windows[2]!.resetsAt).toBe(1_700_100_000_000);
		expect(snapshot!.windows.every((w) => !w.rateLimited)).toBe(true);
	});

	it("rate-limited 窗口强制已用 100%", () => {
		const snapshot = parseUsagePayload({
			usage: { rolling: { status: "rate-limited", percent: 87, resetsAt: null } },
		});
		expect(snapshot!.windows[0]!.usedPercent).toBe(100);
		expect(snapshot!.windows[0]!.rateLimited).toBe(true);
	});

	it("percent 缺失或负数被钳制；无可用窗口返回 undefined", () => {
		const bad = parseUsagePayload({ usage: { rolling: { status: "ok", percent: -5, resetsAt: null } } });
		expect(bad!.windows[0]!.usedPercent).toBe(0);
		expect(parseUsagePayload({ usage: {} })).toBeUndefined();
		expect(parseUsagePayload({})).toBeUndefined();
		expect(parseUsagePayload(null)).toBeUndefined();
	});

	it("parseResetAt 兼容三种输入", () => {
		expect(parseResetAt("2026-09-20T00:00:00Z")).toBe(Date.parse("2026-09-20T00:00:00Z"));
		expect(parseResetAt(1_700_100_000)).toBe(1_700_100_000_000);
		expect(parseResetAt("not-a-date")).toBeNull();
		expect(parseResetAt(null)).toBeNull();
	});
});
