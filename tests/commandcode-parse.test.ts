import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import {
	commandCodeAdapter,
	composeQuotaSnapshot,
	parseCreditsInfo,
	parseSubscriptionInfo,
	parseSummaryInfo,
	parseWhoamiAccount,
} from "../src/adapters/commandcode";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock；
// 纯解析用例不会调用 requestUrl，fetchQuota 用例按 URL 路由响应。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const mockedRequestUrl = vi.mocked(requestUrl);

function respond(body: unknown, status = 200) {
	return {
		status,
		text: typeof body === "string" ? body : JSON.stringify(body),
		json: body,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
	} as unknown as Awaited<ReturnType<typeof requestUrl>>;
}

beforeEach(() => {
	mockedRequestUrl.mockReset();
});

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
		expect(info!.monthly).toBe(10);
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

describe("composeQuotaSnapshot", () => {
	it("CC 推导近一月条：totalCost ÷ (totalCost+monthlyCredits)，重置点=周期结束", () => {
		// 真号语义：monthlyCredits 是剩余额度。花 69.9 剩 0.1 → 总额度 70 → 99.86%。
		const periodEnd = Date.parse("2026-09-30T00:00:00Z");
		const snap = composeQuotaSnapshot(
			{ monthly: 0.1, remaining: 0.1, windows: [] },
			{ planId: "individual-goat", periodStartMs: null, periodEndMs: periodEnd },
			{ totalCost: 69.9, totalCount: 13147 },
			1_758_000_000_000,
		);
		expect(snap!.windows.map((w) => w.key)).toEqual(["monthly"]);
		expect(snap!.windows[0]!.label).toBe("近一月");
		expect(snap!.windows[0]!.usedPercent).toBeCloseTo(99.86, 1);
		expect(snap!.windows[0]!.rateLimited).toBe(false);
		expect(snap!.windows[0]!.resetsAt).toBe(periodEnd);
		expect(snap!.planName).toBe("individual-goat");
		expect(snap!.planPeriodEnd).toBe(periodEnd);
		expect(snap!.extras.map((e) => e.label)).toEqual(["余额", "本期费用", "本期请求", "剩余天数"]);
	});

	it("已有原生窗口时近一月条追加在两条窗口之后", () => {
		const snap = composeQuotaSnapshot(
			{
				monthly: 90,
				remaining: 90,
				windows: [
					{ key: "fiveHour", label: "近5小时", usedPercent: 10, resetsAt: null, rateLimited: false },
					{ key: "weekly", label: "近一周", usedPercent: 20, resetsAt: null, rateLimited: false },
				],
			},
			{ planId: null, periodStartMs: null, periodEndMs: 1 },
			{ totalCost: 10, totalCount: 1 },
		);
		expect(snap!.windows.map((w) => w.key)).toEqual(["fiveHour", "weekly", "monthly"]);
		expect(snap!.windows[2]!.usedPercent).toBeCloseTo(10);
	});

	it("月度额度耗尽（剩余 0）时近一月条仍显示并钳在 100%；分母为 0 时不出条", () => {
		const exhausted = composeQuotaSnapshot(
			{ monthly: 0, remaining: 0, windows: [] },
			{ planId: null, periodStartMs: null, periodEndMs: 1 },
			{ totalCost: 35.44, totalCount: 1 },
		);
		expect(exhausted!.windows).toHaveLength(1);
		expect(exhausted!.windows[0]).toMatchObject({ key: "monthly", usedPercent: 100, rateLimited: true });

		const zeroDenom = composeQuotaSnapshot(
			{ monthly: 0, remaining: 0, windows: [] },
			{ planId: null, periodStartMs: null, periodEndMs: 1 },
			{ totalCost: 0, totalCount: 0 },
		);
		expect(zeroDenom!.windows).toHaveLength(0);
	});

	it("三段全空 → null", () => {
		expect(composeQuotaSnapshot(null, null, null)).toBeNull();
	});

	it("订阅接口确认无订阅：展开体标注状态，快照带不可用原因", () => {
		const snap = composeQuotaSnapshot(null, null, { totalCost: 67.503, totalCount: 22038 }, 1_790_000_000_000, true);
		expect(snap!.windows).toEqual([]);
		expect(snap!.extras).toEqual([
			{ label: "订阅状态", value: "暂未订阅" },
			{ label: "本期费用", value: "$67.50" },
			{ label: "本期请求", value: "22038" },
		]);
		expect(snap!.unavailableReason).toBe("暂未订阅");
		expect(snap!.planPeriodEnd).toBeUndefined();
	});

	it("订阅结果未知（请求失败或结构不明）时不下无订阅结论", () => {
		const snap = composeQuotaSnapshot(null, null, { totalCost: 1, totalCount: 1 }, 1_790_000_000_000, false);
		expect(snap!.extras.map((e) => e.label)).toEqual(["本期费用", "本期请求"]);
		expect(snap!.unavailableReason).toBeUndefined();
	});

	it("订阅在场但接口没给周期结束时刻时，planPeriodEnd 缺省不硬造", () => {
		const snap = composeQuotaSnapshot(
			{ monthly: 1, remaining: 1, windows: [] },
			{ planId: "individual-go", periodStartMs: null, periodEndMs: null },
			{ totalCost: 1, totalCount: 1 },
		);
		expect(snap!.planPeriodEnd).toBeUndefined();
	});
});

describe("commandCodeAdapter.fetchQuota 无订阅判定", () => {
	function arrange(subscriptionBody: unknown, subscriptionStatus = 200) {
		mockedRequestUrl.mockImplementation(async (request) => {
			const url = request.url;
			if (url.endsWith("/alpha/whoami")) return respond({ user: { userName: "u" } });
			if (url.includes("/alpha/billing/credits")) {
				return respond({
					credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
					windowLimits: {},
				});
			}
			if (url.includes("/alpha/billing/subscriptions")) {
				return respond(subscriptionBody, subscriptionStatus);
			}
			if (url.includes("/alpha/usage/summary")) {
				return respond({ totalCost: 67.5, totalCount: 22038 });
			}
			throw new Error(`unexpected request: ${url}`);
		});
	}

	it("订阅接口成功返回 data:null：快照进入暂未订阅态", async () => {
		arrange({ success: true, data: null });
		const [snap] = await commandCodeAdapter.fetchQuota("key");
		expect(snap!.unavailableReason).toBe("暂未订阅");
		expect(snap!.extras).toEqual([
			{ label: "订阅状态", value: "暂未订阅" },
			{ label: "本期费用", value: "$67.50" },
			{ label: "本期请求", value: "22038" },
		]);
	});

	it("订阅接口失败：只展示拿到的用量，不误报暂未订阅", async () => {
		arrange({ success: false }, 500);
		const [snap] = await commandCodeAdapter.fetchQuota("key");
		expect(snap!.unavailableReason).toBeUndefined();
		expect(snap!.extras.map((e) => e.label)).toEqual(["本期费用", "本期请求"]);
	});
});
