import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { kimiAdapter, parseApiError, parseUsagesPayload } from "../src/adapters/kimi";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const mockedRequestUrl = vi.mocked(requestUrl);
const NOW = 1_700_000_000_000;

function respond(body: unknown, status = 200) {
	return {
		status,
		text: typeof body === "string" ? body : JSON.stringify(body),
		json: body,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
	} as unknown as Awaited<ReturnType<typeof requestUrl>>;
}

/** 官方 issue 实测的 legacy 响应形状（数值为字符串；usages 同时在场但 used_ratio 失真为 0）。 */
const LEGACY_WITH_STALE_QUOTA = {
	user: { membership: { level: "LEVEL_ADVANCED" } },
	usage: { limit: "100", used: "100", resetTime: "2026-09-24T02:09:07.465054Z" },
	limits: [
		{
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: { limit: "100", used: "1", remaining: "99", resetTime: "2026-09-14T10:17:42Z" },
		},
	],
	usages: {
		limit_5h: { used_ratio: 0, reset_time: "2026-09-21T01:09:06Z" },
		limit_7d: { used_ratio: 0, reset_time: "2026-09-24T02:09:06Z" },
	},
};

beforeEach(() => {
	mockedRequestUrl.mockReset();
});

describe("parseUsagesPayload", () => {
	it("legacy 优先：周额度已用尽时不被失真的 used_ratio=0 覆盖（同窗口取已用更大的一侧）", () => {
		const snapshot = parseUsagesPayload(LEGACY_WITH_STALE_QUOTA, NOW);
		expect(snapshot).toBeDefined();
		expect(snapshot!.windows.map((w) => w.key)).toEqual(["fiveHour", "weekly"]);
		expect(snapshot!.windows.map((w) => w.label)).toEqual(["近5小时", "近一周"]);
		expect(snapshot!.windows[0]!.usedPercent).toBe(1);
		expect(snapshot!.windows[1]!.usedPercent).toBe(100);
		expect(snapshot!.windows[1]!.rateLimited).toBe(true);
		// 微秒小数被截到毫秒且按 UTC 解析
		expect(snapshot!.windows[1]!.resetsAt).toBe(Date.parse("2026-09-24T02:09:07.465Z"));
		expect(snapshot!.windows[0]!.resetsAt).toBe(Date.parse("2026-09-14T10:17:42Z"));
	});

	it("只有 quota 模型时按 used_ratio 出窗口", () => {
		const snapshot = parseUsagesPayload({
			usages: {
				limit_5h: { used_ratio: 0.42, reset_time: "2026-09-21T01:09:06Z" },
				limit_7d: { used_ratio: 0.1, reset_time: "2026-09-24T02:09:06Z" },
			},
		});
		expect(snapshot!.windows.map((w) => `${w.key}:${w.usedPercent}`)).toEqual(["fiveHour:42", "weekly:10"]);
	});

	it("窗口长度按 duration×timeUnit 归一：DAY×7 与 WEEK（无 duration）都归到周窗", () => {
		const snapshot = parseUsagesPayload({
			limits: [
				{ window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "100", used: "7" } },
				{ window: { duration: 1, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", used: "3" } },
				{ window: { timeUnit: "TIME_UNIT_WEEK" }, detail: { limit: "100", used: "9" } },
			],
		});
		expect(snapshot!.windows.map((w) => `${w.label}:${w.usedPercent}`)).toEqual(["近1小时:3", "近一周:9"]);
		// 同 key 合并：周窗两条（DAY×7 与 WEEK）取更大值，只出一行
		expect(snapshot!.windows.filter((w) => w.key === "weekly")).toHaveLength(1);
	});

	it("remaining 口径与缺 limit 的条目被正确处理/跳过", () => {
		const snapshot = parseUsagesPayload({
			usage: { limit: "100", remaining: "80" },
			limits: [
				{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { remaining: "100" } },
				{ window: { duration: 1440, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "0", used: "1" } },
			],
		});
		expect(snapshot!.windows.map((w) => `${w.key}:${w.usedPercent}`)).toEqual(["weekly:20"]);
	});

	it("结构不符一律返回 undefined", () => {
		expect(parseUsagesPayload(null)).toBeUndefined();
		expect(parseUsagesPayload({})).toBeUndefined();
		expect(parseUsagesPayload({ usage: {}, limits: [], usages: {} })).toBeUndefined();
	});

	it("parseApiError 识别官方 401 形状", () => {
		expect(parseApiError({ error: { message: "Invalid Authentication", type: "invalid_authentication_error" } })).toEqual({
			message: "Invalid Authentication",
			type: "invalid_authentication_error",
		});
		expect(parseApiError({})).toBeNull();
		expect(parseApiError({ error: {} })).toBeNull();
	});
});

describe("kimiAdapter.fetchQuota", () => {
	it("中国站成功即返回（单请求），Authorization 为 Bearer", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(LEGACY_WITH_STALE_QUOTA));
		const snapshots = await kimiAdapter.fetchQuota("sk-kimi-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		const call = mockedRequestUrl.mock.calls[0]![0];
		expect(call.url).toBe("https://api.kimi.com/coding/v1/usages");
		expect(call.headers).toMatchObject({ authorization: "Bearer sk-kimi-test" });
		expect(snapshots[0]!.windows).toHaveLength(2);
	});

	it("中国站 401 时回退国际站（api.kimi.ai）", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ error: { message: "Invalid Authentication", type: "invalid_authentication_error" } }, 401))
			.mockResolvedValueOnce(respond({ usages: { limit_5h: { used_ratio: 0.5 } } }));
		const snapshots = await kimiAdapter.fetchQuota("sk-kimi-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe("https://api.kimi.ai/coding/v1/usages");
		expect(snapshots[0]!.windows[0]!.usedPercent).toBe(50);
	});

	it("两站同因：错误里各站名只出现一次，附官方 error 类型", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ error: { message: "Invalid Authentication", type: "invalid_authentication_error" } }, 401))
			.mockResolvedValueOnce(respond({ error: { message: "Invalid Authentication", type: "invalid_authentication_error" } }, 401));
		await expect(kimiAdapter.fetchQuota("bad")).rejects.toThrow(
			/Kimi 额度查询失败：中国站、国际站同因：Invalid Authentication（invalid_authentication_error）/,
		);
	});

	it("无可用窗口与 HTTP 5xx 都有可解释文案（同因时并站点名只出现一次）", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond("boom", 502)).mockResolvedValueOnce(respond("boom", 502));
		await expect(kimiAdapter.fetchQuota("k")).rejects.toThrow(
			/Kimi 额度查询失败：中国站、国际站同因：HTTP 502：boom/,
		);

		mockedRequestUrl.mockReset();
		mockedRequestUrl.mockResolvedValueOnce(respond({ user: {} })).mockResolvedValueOnce(respond({ user: {} }));
		await expect(kimiAdapter.fetchQuota("k")).rejects.toThrow(/响应无可用的额度窗口/);
	});
});
