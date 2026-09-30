import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { moonshotAdapter, parseApiError, parseBalancePayload } from "../src/adapters/moonshot";

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

beforeEach(() => {
	mockedRequestUrl.mockReset();
});

describe("parseBalancePayload", () => {
	it("available_balance 进 coreBalance（两位小数）；现金/代金券拆分进 extras", () => {
		const snapshot = parseBalancePayload(
			{ code: 0, status: true, scode: "0x0", data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 } },
			"¥",
			NOW,
		);
		expect(snapshot!.coreBalance).toBe("¥49.59");
		expect(snapshot!.windows).toEqual([]);
		expect(snapshot!.extras).toEqual([
			{ label: "现金余额", value: "¥3.00" },
			{ label: "代金券余额", value: "¥46.59" },
		]);
	});

	it("cash_balance 可为负（欠费）：负号置于符号最前，面板按前缀负号识别红字", () => {
		const snapshot = parseBalancePayload(
			{ code: 0, status: true, data: { available_balance: 44.08894, voucher_balance: 46.58893, cash_balance: -2.5 } },
			"¥",
			NOW,
		);
		expect(snapshot!.extras[0]).toEqual({ label: "现金余额", value: "-¥2.50" });
	});

	it("金额兼容字符串；缺 available_balance / data → undefined", () => {
		expect(parseBalancePayload({ code: 0, data: { available_balance: "12.3" } }, "¥")!.coreBalance).toBe("¥12.30");
		expect(parseBalancePayload({ code: 0, data: {} }, "¥")).toBeUndefined();
		expect(parseBalancePayload({ code: 0 }, "¥")).toBeUndefined();
		expect(parseBalancePayload(null, "¥")).toBeUndefined();
	});
});

describe("parseApiError", () => {
	it("code != 0 或 status=false 即失败；成功信封与 OpenAI 风格 error 体（无 code）返回 null", () => {
		expect(parseApiError({ code: 1003, message: "quota exceeded" })).toEqual({ code: 1003, message: "quota exceeded" });
		expect(parseApiError({ code: 0, status: false })).toEqual({ code: 0, message: null });
		expect(parseApiError({ code: 0, status: true, data: {} })).toBeNull();
		expect(parseApiError({ error: { message: "Invalid Authentication" } })).toBeNull();
		expect(parseApiError("boom")).toBeNull();
	});
});

describe("moonshotAdapter.fetchQuota", () => {
	const okBody = {
		code: 0,
		status: true,
		scode: "0x0",
		data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
	};

	it("国内站成功即返回，Authorization 为 Bearer，币种符号 ¥", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(okBody));
		const snapshots = await moonshotAdapter.fetchQuota("sk-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		const call = mockedRequestUrl.mock.calls[0]![0];
		expect(call.url).toBe("https://api.moonshot.cn/v1/users/me/balance");
		expect(call.headers).toMatchObject({ authorization: "Bearer sk-test" });
		expect(snapshots[0]!.coreBalance).toBe("¥49.59");
	});

	it("逐个回退：国内站失败 → 国际站成功，币种符号随 host 切 $", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ code: 1003, message: "invalid" }, 401))
			.mockResolvedValueOnce(respond(okBody));
		const snapshots = await moonshotAdapter.fetchQuota("sk-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe("https://api.moonshot.ai/v1/users/me/balance");
		expect(snapshots[0]!.coreBalance).toBe("$49.59");
	});

	it("OpenAI 风格 401（无 code 信封）走 HTTP 状态路径，报状态码与片段", async () => {
		mockedRequestUrl.mockResolvedValue(
			respond({ error: { message: "Invalid Authentication", type: "invalid_authentication_error" } }, 401),
		);
		await expect(moonshotAdapter.fetchQuota("bad")).rejects.toThrow(
			/Moonshot 余额查询失败：国内站、国际站同因：HTTP 401.*Invalid Authentication/s,
		);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
	});
});
