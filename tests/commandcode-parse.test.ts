import { describe, expect, it, vi } from "vitest";
import {
	parseCreditsInfo,
	parseSubscriptionInfo,
	parseSummaryInfo,
	parseWhoamiAccount,
} from "../src/adapters/commandcode";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock；
// 本文件只测纯解析逻辑，requestUrl 不会被调用。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

describe("commandcode parseWhoamiAccount", () => {
	it("org 优先取 login/id；无 org 时回落 user", () => {
		expect(parseWhoamiAccount({ org: { login: "acme", id: "org_1" } })).toEqual({
			login: "acme",
			orgId: "org_1",
		});
		expect(parseWhoamiAccount({ user: { userName: "bob" } })).toEqual({ login: "bob", orgId: null });
		expect(parseWhoamiAccount({})).toBeNull();
		expect(parseWhoamiAccount(null)).toBeNull();
	});
});

describe("parseCreditsInfo", () => {
	it("解析余额与 5h/周窗口（used/cap → 百分比，epoch 秒转 ms）", () => {
		const info = parseCreditsInfo({
			credits: { monthlyCredits: 10, purchasedCredits: 2.5, freeCredits: 0 },
			windowLimits: {
				fiveHour: { used: 3, cap: 12, resetAt: 1_700_100_000 },
				weekly: { used: 9, cap: 30, resetAt: "2026-09-22T00:00:00Z" },
			},
		});
		expect(info!.remaining).toBeCloseTo(12.5);
		expect(info!.windows[0]).toMatchObject({ key: "fiveHour", usedPercent: 25, resetsAt: 1_700_100_000_000 });
		expect(info!.windows[1]!.resetsAt).toBe(Date.parse("2026-09-22T00:00:00Z"));
	});

	it("cap 为 0 的窗口跳过；用量超 100% 钳制并标记限速", () => {
		const info = parseCreditsInfo({
			credits: { monthlyCredits: 5 },
			windowLimits: {
				fiveHour: { used: 0, cap: 0, resetAt: null },
				weekly: { used: 31, cap: 30, resetAt: null },
			},
		});
		expect(info!.windows).toHaveLength(1);
		expect(info!.windows[0]).toMatchObject({ key: "weekly", usedPercent: 100, rateLimited: true });
	});

	it("credits 缺失且无窗口 → null", () => {
		expect(parseCreditsInfo({})).toBeNull();
		expect(parseCreditsInfo({ windowLimits: { fiveHour: { used: 0, cap: 0 } } })).toBeNull();
	});
});

describe("parseSubscriptionInfo / parseSummaryInfo", () => {
	it("解析套餐与周期（ISO 与 epoch 均可）", () => {
		const sub = parseSubscriptionInfo({
			data: { planId: "pro", status: "active", currentPeriodStart: 1_700_000_000, currentPeriodEnd: "2026-10-12T00:00:00Z" },
		});
		expect(sub!.planId).toBe("pro");
		expect(sub!.periodStartMs).toBe(1_700_000_000_000);
		expect(sub!.periodEndMs).toBe(Date.parse("2026-10-12T00:00:00Z"));
		expect(parseSubscriptionInfo({ data: {} })).toBeNull();
	});

	it("解析用量汇总；totalTokens 可缺", () => {
		expect(parseSummaryInfo({ totalCost: 1.25, totalCount: 42, totalTokens: 1000 })).toEqual({
			totalCost: 1.25,
			totalCount: 42,
		});
		expect(parseSummaryInfo({})).toBeNull();
	});
});
