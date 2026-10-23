import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { volcengineConsoleAdapter, extractCsrfToken } from "../src/adapters/volcengine-console";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const mockedRequestUrl = vi.mocked(requestUrl);
const NOW_S = 1_700_100_000;

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

const cookie = `x-web-id=1; session=abc; csrfToken=deadbeef; other=2`;

const codingBody = {
	Result: {
		PlanType: "Pro",
		QuotaUsage: [
			{ Level: "session", Percent: 30, ResetTimestamp: NOW_S },
			{ Level: "weekly", Percent: 60, ResetTimestamp: NOW_S },
			{ Level: "monthly", Percent: 100, ResetTimestamp: NOW_S },
		],
	},
};

const afpBody = {
	Result: {
		PlanType: "Pro",
		AFPFiveHour: { Quota: 100, Used: 10, ResetTime: NOW_S },
		AFPWeekly: { Quota: 200, Used: 0, ResetTime: NOW_S },
	},
};

describe("extractCsrfToken", () => {
	it("从整串 Cookie 取 csrfToken 值（x-csrf-token 头来源）", () => {
		expect(extractCsrfToken(cookie)).toBe("deadbeef");
		expect(extractCsrfToken("session=abc")).toBeUndefined();
	});
});

describe("volcengineConsoleAdapter.fetchQuota", () => {
	it("双计划：Coding 主链 + Agent best-effort，各一卡；两枪各自的 URL / referer / body", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(codingBody)).mockResolvedValueOnce(respond(afpBody));
		const snapshots = await volcengineConsoleAdapter.fetchQuota(cookie);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		expect(mockedRequestUrl.mock.calls[0]![0].url).toBe(
			"https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage",
		);
		expect(mockedRequestUrl.mock.calls[0]![0].body).toBe(JSON.stringify({ ProjectName: "default" }));
		expect(mockedRequestUrl.mock.calls[0]![0].headers).toMatchObject({
			cookie,
			"x-csrf-token": "deadbeef",
			referer: "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan",
		});
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe(
			"https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetAgentPlanAFPUsage",
		);
		expect(mockedRequestUrl.mock.calls[1]![0].body).toBe("{}");
		expect(mockedRequestUrl.mock.calls[1]![0].headers).toMatchObject({
			referer: "https://console.volcengine.com/ark/region:cn-beijing/subscription/agent-plan",
		});

		expect(snapshots).toHaveLength(2);
		expect(snapshots[0]!.planName).toBe("Coding Plan Pro");
		expect(snapshots[0]!.windows.map((w) => `${w.label}:${w.usedPercent}`)).toEqual([
			"近5小时:30",
			"近一周:60",
			"近一月:100",
		]);
		expect(snapshots[1]!.planName).toBe("Agent Plan Pro");
		expect(snapshots[1]!.windows[0]).toMatchObject({ label: "近5小时", usedPercent: 10 });
	});

	it("只订 Coding：Agent Quota<=0 跳过，仅出 Coding 卡", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond(codingBody))
			.mockResolvedValueOnce(respond({ Result: { AFPFiveHour: { Quota: 0, Used: 0 } } }));
		const snapshots = await volcengineConsoleAdapter.fetchQuota(cookie);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]!.planName).toBe("Coding Plan Pro");
	});

	it("只订 Agent：Coding 空窗不拖垮，仅出 Agent 卡", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond({ Result: {} })).mockResolvedValueOnce(respond(afpBody));
		const snapshots = await volcengineConsoleAdapter.fetchQuota(cookie);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]!.planName).toBe("Agent Plan Pro");
	});

	it("Coding 响应乱序：卡内窗口仍按 近5小时 → 近一周 → 近一月 排列", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(
				respond({
					Result: {
						PlanType: "Pro",
						QuotaUsage: [
							{ Level: "monthly", Percent: 100, ResetTimestamp: NOW_S },
							{ Level: "session", Percent: 30, ResetTimestamp: NOW_S },
							{ Level: "weekly", Percent: 60, ResetTimestamp: NOW_S },
						],
					},
				}),
			)
			.mockResolvedValueOnce(respond({ Result: {} }));
		const snapshots = await volcengineConsoleAdapter.fetchQuota(cookie);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]!.windows.map((w) => w.label)).toEqual(["近5小时", "近一周", "近一月"]);
		expect(snapshots[0]!.windows.map((w) => w.usedPercent)).toEqual([30, 60, 100]);
	});

	it("Percent 缺失走 used/total 兜底（Coding 窗）", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(
				respond({ Result: { QuotaUsage: [{ Level: "monthly", Used: 25, Total: 100, ResetTimestamp: NOW_S }] } }),
			)
			.mockResolvedValueOnce(respond({ Result: {} }));
		const snapshots = await volcengineConsoleAdapter.fetchQuota(cookie);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]!.windows[0]).toMatchObject({ usedPercent: 25 });
	});

	it("缺 csrfToken= 的 Cookie 在请求前即报可解释错误", async () => {
		await expect(volcengineConsoleAdapter.fetchQuota("session=abc")).rejects.toThrow(/缺少 csrfToken=/);
		expect(mockedRequestUrl).not.toHaveBeenCalled();
	});

	it("HTTP 401 = 会话失效，报重贴文案", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond("unauthorized", 401));
		await expect(volcengineConsoleAdapter.fetchQuota(cookie)).rejects.toThrow(/登录 Cookie 已失效/);
	});

	it("200 + Error 信封：鉴权类报重贴；业务类转 soft，两枪全空才抛", async () => {
		mockedRequestUrl.mockResolvedValueOnce(
			respond({ ResponseMetadata: { Error: { Code: "InvalidAuthorization", Message: "login required" } } }),
		);
		await expect(volcengineConsoleAdapter.fetchQuota(cookie)).rejects.toThrow(/登录 Cookie 已失效/);

		mockedRequestUrl.mockReset();
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ ResponseMetadata: { Error: { Code: "InternalError", Message: "boom" } } }))
			.mockResolvedValueOnce(respond({ Result: {} }));
		await expect(volcengineConsoleAdapter.fetchQuota(cookie)).rejects.toThrow(
			/火山方舟控制台返回错误：GetCodingPlanUsage：InternalError：boom/,
		);
	});

	it("双枪都空窗（无 soft 错误）报可能未订阅", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond({ Result: {} })).mockResolvedValueOnce(respond({ Result: {} }));
		await expect(volcengineConsoleAdapter.fetchQuota(cookie)).rejects.toThrow(/未解析到任何用量窗口/);
	});
});
