import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { mimoAdapter, parseBalance, parsePlanDetail, parsePlanUsage } from "../src/adapters/mimo";
import { cookieHeaderValue, normalizeCookieHeader } from "../src/adapters/cookie";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const mockedRequestUrl = vi.mocked(requestUrl);
const PERIOD_END = "2026-10-31T23:59:59+08:00";

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

describe("整串 Cookie 小件（cookie.ts，经本适配器消费）", () => {
	it("normalizeCookieHeader：容忍 Cookie: 前缀 / 引号 / 空白，整串保留", () => {
		expect(normalizeCookieHeader(" a=1; api-platform_serviceToken=x; b=2 ")).toBe("a=1; api-platform_serviceToken=x; b=2");
		expect(normalizeCookieHeader("Cookie: api-platform_serviceToken=x")).toBe("api-platform_serviceToken=x");
		expect(normalizeCookieHeader('"api-platform_serviceToken=x"')).toBe("api-platform_serviceToken=x");
	});

	it("cookieHeaderValue：值可含 = 号；缺名返回 undefined", () => {
		const raw = "a=1; csrfToken=abc123; jwt=xx.yy==";
		expect(cookieHeaderValue(raw, "csrfToken")).toBe("abc123");
		expect(cookieHeaderValue(raw, "jwt")).toBe("xx.yy==");
		expect(cookieHeaderValue(raw, "missing")).toBeUndefined();
	});
});

describe("parsePlanDetail / parsePlanUsage", () => {
	it("detail：planCode 在场出名称与周期（ISO 解析）；无 planCode = 未开通套餐", () => {
		expect(parsePlanDetail({ data: { planCode: "pro", planName: "MiMo Pro", currentPeriodEnd: PERIOD_END } })).toEqual({
			planName: "MiMo Pro",
			periodEnd: Date.parse(PERIOD_END),
		});
		expect(parsePlanDetail({ data: {} })).toBeUndefined();
		expect(parsePlanDetail({ data: { planCode: "" } })).toBeUndefined();
	});

	it("usage：取 limit>0 首条，used/limit 算百分比；不读 percent 字段（0-1 比例的坑）", () => {
		expect(parsePlanUsage({ data: { usage: { items: [{ limit: 0, used: 5 }, { limit: 4_100_000_000, used: 1_025_000_000 }] } } })).toEqual({
			usedPercent: 25,
			remainingCredits: 3_075_000_000,
		});
		expect(parsePlanUsage({ data: { usage: { items: [{ limit: 100, used: 120 }] } } })).toEqual({
			usedPercent: 100,
			remainingCredits: 0,
		});
		expect(parsePlanUsage({ data: { usage: { items: [] } } })).toBeUndefined();
		expect(parsePlanUsage({})).toBeUndefined();
	});
});

describe("parseBalance", () => {
	it("CNY：core = balance，现金/赠送拆分；balance 缺失时现金+赠送求和兜底", () => {
		expect(parseBalance({ data: { balance: 110.5, cashBalance: 100, giftBalance: 10.5, currency: "CNY" } })).toEqual({
			core: "¥110.50",
			cash: "¥100.00",
			gift: "¥10.50",
		});
		expect(parseBalance({ data: { cashBalance: 30, giftBalance: 12 } })).toEqual({
			core: "¥42.00",
			cash: "¥30.00",
			gift: "¥12.00",
		});
	});

	it("非 CNY 币种退「金额 + 代码」后缀形态；全空返回 undefined", () => {
		expect(parseBalance({ data: { balance: 5, currency: "USD" } })).toEqual({ core: "5.00 USD" });
		expect(parseBalance({ data: {} })).toBeUndefined();
	});
});

describe("mimoAdapter.fetchQuota", () => {
	const cookie = `api-platform_serviceToken=tok; userId=42`;
	const detailOk = { data: { planCode: "pro", planName: "MiMo Pro", currentPeriodEnd: PERIOD_END } };
	const usageOk = { data: { usage: { items: [{ limit: 4_100_000_000, used: 1_025_000_000 }] } } };
	const balanceOk = { data: { balance: 110, cashBalance: 100, giftBalance: 10, currency: "CNY" } };

	it("套餐 + 余额一张凭证出两类卡；请求带整串 Cookie 头", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond(detailOk))
			.mockResolvedValueOnce(respond(usageOk))
			.mockResolvedValueOnce(respond(balanceOk));
		const snapshots = await mimoAdapter.fetchQuota(cookie);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(3);
		expect(mockedRequestUrl.mock.calls[0]![0].url).toBe("https://platform.xiaomimimo.com/api/v1/tokenPlan/detail");
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe("https://platform.xiaomimimo.com/api/v1/tokenPlan/usage");
		expect(mockedRequestUrl.mock.calls[2]![0].url).toBe("https://platform.xiaomimimo.com/api/v1/balance");
		expect(mockedRequestUrl.mock.calls[0]![0].headers).toMatchObject({ cookie });

		expect(snapshots).toHaveLength(2);
		expect(snapshots[0]).toMatchObject({
			planName: "MiMo Pro",
			windows: [{ key: "plan", label: "套餐周期", usedPercent: 25, resetsAt: Date.parse(PERIOD_END), rateLimited: false }],
			extras: [{ label: "剩余额度", value: "3075.00 M Credits" }],
		});
		expect(snapshots[1]).toMatchObject({
			coreBalance: "¥110.00",
			windows: [],
			extras: [
				{ label: "现金余额", value: "¥100.00" },
				{ label: "赠送余额", value: "¥10.00" },
			],
		});
	});

	it("缺 serviceToken 的 Cookie 在请求前即报可解释错误", async () => {
		await expect(mimoAdapter.fetchQuota("other=1")).rejects.toThrow(/缺少 api-platform_serviceToken/);
		expect(mockedRequestUrl).not.toHaveBeenCalled();
	});

	it("401 = 会话失效，报重贴文案", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond("unauthorized", 401));
		await expect(mimoAdapter.fetchQuota(cookie)).rejects.toThrow(/登录 Cookie 已失效/);
	});

	it("未开通套餐时只出余额卡；两者全无才报错", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ data: {} }))
			.mockResolvedValueOnce(respond({ data: { usage: { items: [] } } }))
			.mockResolvedValueOnce(respond(balanceOk));
		const snapshots = await mimoAdapter.fetchQuota(cookie);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ coreBalance: "¥110.00" });

		mockedRequestUrl.mockReset();
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ data: {} }))
			.mockResolvedValueOnce(respond({ data: { usage: { items: [] } } }))
			.mockResolvedValueOnce(respond({ data: {} }));
		await expect(mimoAdapter.fetchQuota(cookie)).rejects.toThrow(/未查到套餐用量或余额/);
	});

	it("套餐在但用量结构解析不出 = 平台改版，报错不静默少卡", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond(detailOk))
			.mockResolvedValueOnce(respond({ data: { usage: {} } }))
			.mockResolvedValueOnce(respond(balanceOk));
		await expect(mimoAdapter.fetchQuota(cookie)).rejects.toThrow(/套餐用量响应无法解析/);
	});
});
