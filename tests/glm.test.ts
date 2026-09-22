import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { glmAdapter, parseApiError, parseQuotaLimit } from "../src/adapters/glm";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const mockedRequestUrl = vi.mocked(requestUrl);
const NOW = 1_700_000_000_000;
const RESET_MS = 1_700_100_000_000;

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

describe("parseQuotaLimit", () => {
	it("新套餐：unit+number 判定 5 小时与周窗口，末位为周（行总用量取末位）", () => {
		const snapshot = parseQuotaLimit(
			{
				success: true,
				code: 200,
				data: {
					level: "pro",
					limits: [
						{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 12.5, nextResetTime: RESET_MS },
						{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 40.25, nextResetTime: RESET_MS },
					],
				},
			},
			NOW,
		);
		expect(snapshot).toBeDefined();
		expect(snapshot!.planName).toBe("GLM Coding Plan Pro");
		expect(snapshot!.windows.map((w) => w.key)).toEqual(["fiveHour", "weekly"]);
		expect(snapshot!.windows.map((w) => w.label)).toEqual(["近5小时", "近一周"]);
		expect(snapshot!.windows[0]!.usedPercent).toBe(12.5);
		expect(snapshot!.windows[1]!.usedPercent).toBe(40.25);
		expect(snapshot!.windows.every((w) => w.resetsAt === RESET_MS)).toBe(true);
		expect(snapshot!.windows.every((w) => !w.rateLimited)).toBe(true);
		expect(snapshot!.windows.at(-1)!.key).toBe("weekly");
		expect(snapshot!.capturedAt).toBe(NOW);
	});

	it("老套餐：无 unit 的 TOKENS_LIMIT 兜底为 5 小时窗", () => {
		const snapshot = parseQuotaLimit({
			data: { level: "lite", limits: [{ type: "TOKENS_LIMIT", percentage: 7, nextResetTime: RESET_MS }] },
		});
		expect(snapshot!.windows).toHaveLength(1);
		expect(snapshot!.windows[0]).toMatchObject({ key: "fiveHour", label: "近5小时", usedPercent: 7 });
		expect(snapshot!.planName).toBe("GLM Coding Plan Lite");
	});

	it("MCP（TIME_LIMIT）只进 extras，不占窗口", () => {
		const snapshot = parseQuotaLimit({
			data: {
				level: "max",
				limits: [
					{ type: "TOKENS_LIMIT", percentage: 10, nextResetTime: RESET_MS },
					{ type: "TIME_LIMIT", percentage: 42.5, usage: 85, currentValue: 36 },
				],
			},
		});
		expect(snapshot!.windows.map((w) => w.key)).toEqual(["fiveHour"]);
		expect(snapshot!.extras).toEqual([{ label: "MCP 月用量", value: "42.5%" }]);
	});

	it("只有 MCP 时视为无可用窗口（不让 MCP 顶替行总用量）", () => {
		expect(parseQuotaLimit({ data: { limits: [{ type: "TIME_LIMIT", percentage: 42 }] } })).toBeUndefined();
	});

	it("unit/number 其他组合生成对应标签；percent 钳制并标限速", () => {
		const snapshot = parseQuotaLimit({
			data: {
				limits: [
					{ type: "CREDIT_LIMIT", unit: 4, number: 1, percentage: 120, nextResetTime: RESET_MS },
					{ type: "CREDIT_LIMIT", unit: 3, number: 2, percentage: -5, nextResetTime: 1_700_100_000 },
					{ type: "CREDIT_LIMIT", unit: 6, number: 2, percentage: 60, nextResetTime: null },
				],
			},
		});
		expect(snapshot!.windows.map((w) => w.label)).toEqual(["近一天", "近2小时", "近2周"]);
		expect(snapshot!.windows[0]).toMatchObject({ usedPercent: 100, rateLimited: true });
		expect(snapshot!.windows[1]!.usedPercent).toBe(0);
		expect(snapshot!.windows[1]!.resetsAt).toBe(1_700_100_000_000);
		expect(snapshot!.windows[2]!.resetsAt).toBeNull();
	});

	it("同 key 重复条目保留先出现的一条；无 level 不产出套餐名", () => {
		const snapshot = parseQuotaLimit({
			data: {
				limits: [
					{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 11, nextResetTime: RESET_MS },
					{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 99, nextResetTime: RESET_MS },
				],
			},
		});
		expect(snapshot!.windows).toHaveLength(1);
		expect(snapshot!.windows[0]!.usedPercent).toBe(11);
		expect(snapshot!.planName).toBeUndefined();
	});

	it("结构不符/无 percentage 一律返回 undefined", () => {
		expect(parseQuotaLimit(null)).toBeUndefined();
		expect(parseQuotaLimit({})).toBeUndefined();
		expect(parseQuotaLimit({ data: {} })).toBeUndefined();
		expect(parseQuotaLimit({ data: { limits: [] } })).toBeUndefined();
		expect(parseQuotaLimit({ data: { limits: [{ type: "TOKENS_LIMIT" }] } })).toBeUndefined();
		expect(parseQuotaLimit({ data: { limits: [{ type: "UNKNOWN", percentage: 5 }] } })).toBeUndefined();
	});
});

describe("parseApiError", () => {
	it("认证失败走 200 + code（实测口径）", () => {
		expect(parseApiError({ code: 401, msg: "token expired or incorrect" })).toEqual({
			code: 401,
			message: "token expired or incorrect",
		});
	});

	it("success=false 亦视为错误；成功响应不算错误", () => {
		expect(parseApiError({ success: false, code: 1001, msg: "no plan" })).toEqual({ code: 1001, message: "no plan" });
		expect(parseApiError({ success: true, code: 200, data: {} })).toBeNull();
		expect(parseApiError({ code: "0" })).toBeNull();
		expect(parseApiError({ data: {} })).toBeNull();
		expect(parseApiError("boom")).toBeNull();
	});
});

describe("glmAdapter.fetchQuota", () => {
	it("国内站成功即返回，且 Authorization 为裸 Token（不加 Bearer）", async () => {
		mockedRequestUrl.mockResolvedValueOnce(
			respond({ code: 200, data: { level: "pro", limits: [{ type: "TOKENS_LIMIT", percentage: 3 }] } }),
		);
		const snapshots = await glmAdapter.fetchQuota("sk-test-key");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		const call = mockedRequestUrl.mock.calls[0]![0];
		expect(call.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
		expect(call.headers).toMatchObject({ authorization: "sk-test-key" });
		expect(snapshots[0]!.windows[0]!.usedPercent).toBe(3);
	});

	it("国内站 body 报错时回退国际站（z.ai）", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ code: 401, msg: "token expired or incorrect" }))
			.mockResolvedValueOnce(
				respond({
					code: 200,
					data: {
						level: "max",
						limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 55, nextResetTime: RESET_MS }],
					},
				}),
			);
		const snapshots = await glmAdapter.fetchQuota("zai-key");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
		expect(snapshots[0]!.planName).toBe("GLM Coding Plan Max");
		expect(snapshots[0]!.windows[0]!.resetsAt).toBe(RESET_MS);
	});

	it("国内站网络异常同样回退国际站", async () => {
		mockedRequestUrl
			.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_TIMED_OUT"))
			.mockResolvedValueOnce(respond({ code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 8 }] } }));
		const snapshots = await glmAdapter.fetchQuota("any-key");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		expect(snapshots).toHaveLength(1);
	});

	it("两站同因（凭证无效）：同一句话不重复贴两遍", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ code: 401, msg: "token expired or incorrect", success: false }))
			.mockResolvedValueOnce(respond({ code: 401, msg: "token expired or incorrect", success: false }));
		await expect(glmAdapter.fetchQuota("bad-key")).rejects.toThrow(
			/智谱额度查询失败：国内站、国际站同因：token expired or incorrect（code 401）/,
		);
	});

	it("两站异因：分别列出各自原因", async () => {
		mockedRequestUrl
			.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_TIMED_OUT"))
			.mockResolvedValueOnce(respond({ code: 1001, msg: "Authentication parameter not received", success: false }));
		await expect(glmAdapter.fetchQuota("k")).rejects.toThrow(
			/智谱额度查询失败：国内站 请求失败：net::ERR_CONNECTION_TIMED_OUT；国际站 Authentication parameter not received（code 1001）/,
		);
	});

	it("HTTP 5xx 报状态码与片段；无窗口结构给出可解释说明", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond("upstream boom", 502)).mockResolvedValueOnce(respond("boom", 502));
		await expect(glmAdapter.fetchQuota("k")).rejects.toThrow(/国内站 HTTP 502：upstream boom；国际站 HTTP 502：boom/);

		mockedRequestUrl.mockReset();
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ code: 200, data: { level: "pro" } }))
			.mockResolvedValueOnce(respond({ code: 200, data: { level: "pro" } }));
		await expect(glmAdapter.fetchQuota("k")).rejects.toThrow(/响应无可用的额度窗口/);
	});
});
