import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { miniMaxAdapter, parseApiError, parseRemainsPayload } from "../src/adapters/minimax";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const mockedRequestUrl = vi.mocked(requestUrl);
const NOW = 1_700_000_000_000;
const END_MS = 1_774_605_600_000;
const WEEK_END_MS = 1_774_828_800_000;

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

describe("parseRemainsPayload", () => {
	it("新形状：remaining_percent 生效；weekly_status=3 表示无周窗（不画 0%）", () => {
		const snapshot = parseRemainsPayload({
			base_resp: { status_code: 0 },
			current_subscribe_title: "Token Plan Pro",
			model_remains: [
				{
					model_name: "general",
					current_interval_total_count: 0,
					current_interval_usage_count: 0,
					current_interval_remaining_percent: 62,
					current_interval_status: 1,
					end_time: END_MS,
					current_weekly_total_count: 0,
					current_weekly_usage_count: 0,
					current_weekly_remaining_percent: 100,
					current_weekly_status: 3,
					weekly_end_time: WEEK_END_MS,
				},
			],
		});
		expect(snapshot).toBeDefined();
		expect(snapshot!.planName).toBe("Token Plan Pro");
		expect(snapshot!.windows).toHaveLength(1);
		expect(snapshot!.windows[0]).toMatchObject({
			key: "fiveHour",
			label: "近5小时",
			usedPercent: 38,
			resetsAt: END_MS,
			rateLimited: false,
		});
	});

	it("count 形状：usage_count 是剩余（已用 = total − usage），两窗都出", () => {
		const snapshot = parseRemainsPayload({
			base_resp: { status_code: 0 },
			model_remains: [
				{
					current_interval_total_count: 100,
					current_interval_usage_count: 25,
					current_interval_status: 1,
					end_time: END_MS,
					current_weekly_total_count: 1000,
					current_weekly_usage_count: 1000,
					current_weekly_status: 1,
					weekly_end_time: WEEK_END_MS,
				},
			],
		});
		expect(snapshot!.windows.map((w) => `${w.key}:${w.usedPercent}`)).toEqual(["fiveHour:75", "weekly:0"]);
		expect(snapshot!.windows[1]!.resetsAt).toBe(WEEK_END_MS);
	});

	it("剩余为负数时钳制为用尽并标限速；end_time 兼容秒级", () => {
		const snapshot = parseRemainsPayload({
			model_remains: [
				{
					current_interval_remaining_percent: -5,
					current_interval_status: 1,
					end_time: Math.floor(END_MS / 1000),
					current_weekly_status: 3,
				},
			],
		});
		expect(snapshot!.windows[0]).toMatchObject({ usedPercent: 100, rateLimited: true, resetsAt: END_MS });
	});

	it("多模型分组取第一条能出窗口的记录；结构不符返回 undefined", () => {
		const snapshot = parseRemainsPayload({
			current_subscribe_title: "   ",
			model_remains: [
				{ model_name: "empty", current_interval_status: 3, current_weekly_status: 3 },
				{ model_name: "general", current_interval_remaining_percent: 10, current_weekly_status: 3, end_time: END_MS },
			],
		});
		expect(snapshot!.windows[0]!.usedPercent).toBe(90);
		expect(snapshot!.planName).toBeUndefined();

		expect(parseRemainsPayload(null)).toBeUndefined();
		expect(parseRemainsPayload({})).toBeUndefined();
		expect(parseRemainsPayload({ model_remains: [] })).toBeUndefined();
		expect(parseRemainsPayload({ model_remains: [{ current_interval_status: 3, current_weekly_status: 3 }] })).toBeUndefined();
	});

	it("parseApiError：status_code != 0 才算错误（1004 也仅是 auth 类失败）", () => {
		expect(parseApiError({ base_resp: { status_code: 1004, status_msg: "cookie is missing, log in again" } })).toEqual({
			code: 1004,
			message: "cookie is missing, log in again",
		});
		expect(parseApiError({ base_resp: { status_code: 0 } })).toBeNull();
		expect(parseApiError({ model_remains: [] })).toBeNull();
		expect(parseApiError("boom")).toBeNull();
	});
});

describe("miniMaxAdapter.fetchQuota", () => {
	const okBody = {
		base_resp: { status_code: 0 },
		model_remains: [{ current_interval_remaining_percent: 40, current_interval_status: 1, current_weekly_status: 3 }],
	};

	it("中国站（现行路径）成功即返回，Authorization 为 Bearer", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(okBody));
		const snapshots = await miniMaxAdapter.fetchQuota("sk-cp-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		const call = mockedRequestUrl.mock.calls[0]![0];
		expect(call.url).toBe("https://www.minimax.cn/v1/token_plan/remains");
		expect(call.headers).toMatchObject({ authorization: "Bearer sk-cp-test" });
		expect(snapshots[0]!.windows[0]!.usedPercent).toBe(60);
	});

	it("逐个回退：中国站新路径失败 → 中国站旧路径（第 2 个候选）成功", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ base_resp: { status_code: 1004, status_msg: "cookie is missing, log in again" } }))
			.mockResolvedValueOnce(respond(okBody));
		const snapshots = await miniMaxAdapter.fetchQuota("sk-cp-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe(
			"https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
		);
		expect(snapshots).toHaveLength(1);
	});

	it("全部失败：四个端点同因时只贴一句，并提示区域不匹配的可能", async () => {
		mockedRequestUrl.mockResolvedValue(
			respond({ base_resp: { status_code: 1004, status_msg: "cookie is missing, log in again" } }),
		);
		await expect(miniMaxAdapter.fetchQuota("bad")).rejects.toThrow(
			/MiniMax 额度查询失败：中国站、中国站·旧路径、国际站、国际站·旧路径同因：cookie is missing, log in again（code 1004；凭证或区域不匹配均可能）/,
		);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(4);
	});

	it("结构不符（status_code=0 但无窗口）报可解释文案", async () => {
		mockedRequestUrl.mockResolvedValue(respond({ base_resp: { status_code: 0 }, model_remains: [] }));
		await expect(miniMaxAdapter.fetchQuota("k")).rejects.toThrow(/响应无可用的额度窗口/);
	});
});
