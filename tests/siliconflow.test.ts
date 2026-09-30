import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { parseApiError, parseUserPayload, siliconFlowAdapter } from "../src/adapters/siliconflow";

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

describe("parseUserPayload", () => {
	it("totalBalance 进 coreBalance；balance/chargeBalance 作赠送/充值拆分", () => {
		const snapshot = parseUserPayload(
			{
				code: 20000,
				message: "OK",
				status: true,
				data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88", status: "normal" },
			},
			"¥",
			NOW,
		);
		expect(snapshot!.coreBalance).toBe("¥88.88");
		expect(snapshot!.windows).toEqual([]);
		expect(snapshot!.extras).toEqual([
			{ label: "赠送余额", value: "¥0.88" },
			{ label: "充值余额", value: "¥88.00" },
		]);
	});

	it("缺 totalBalance / data 缺失 → undefined", () => {
		expect(parseUserPayload({ code: 20000, data: { balance: "1.00" } }, "¥")).toBeUndefined();
		expect(parseUserPayload({ code: 20000 }, "¥")).toBeUndefined();
		expect(parseUserPayload(null, "¥")).toBeUndefined();
	});
});

describe("parseApiError", () => {
	it("code != 20000 即失败；20000 与非信封返回 null", () => {
		expect(parseApiError({ code: 30014, message: "Token is invalid." })).toEqual({
			code: 30014,
			message: "Token is invalid.",
		});
		expect(parseApiError({ code: 20000, message: "OK" })).toBeNull();
		expect(parseApiError({ data: {} })).toBeNull();
		expect(parseApiError("boom")).toBeNull();
	});
});

describe("siliconFlowAdapter.fetchQuota", () => {
	const okBody = {
		code: 20000,
		message: "OK",
		status: true,
		data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88" },
	};

	it("国内站成功即返回，Authorization 为 Bearer，币种符号 ¥", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(okBody));
		const snapshots = await siliconFlowAdapter.fetchQuota("sk-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		const call = mockedRequestUrl.mock.calls[0]![0];
		expect(call.url).toBe("https://api.siliconflow.cn/v1/user/info");
		expect(call.headers).toMatchObject({ authorization: "Bearer sk-test" });
		expect(snapshots[0]!.coreBalance).toBe("¥88.88");
	});

	it("逐个回退：国内站凭证被拒 → 国际站成功，币种符号随 host 切 $", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ code: 30014, data: null, message: "Token is invalid." }, 401))
			.mockResolvedValueOnce(respond(okBody));
		const snapshots = await siliconFlowAdapter.fetchQuota("sk-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe("https://api.siliconflow.com/v1/user/info");
		expect(snapshots[0]!.coreBalance).toBe("$88.88");
	});

	it("国内站 20092 = 官方停用终态：直接报可解释文案，不再回退国际站（2026-09-30 真号实证）", async () => {
		mockedRequestUrl.mockResolvedValueOnce(
			respond({ code: 20092, data: null, message: "This endpoint is deprecated and is no longer available." }, 401),
		);
		await expect(siliconFlowAdapter.fetchQuota("sk-cn-valid")).rejects.toThrow(
			/已被官方停用.*code 20092.*不代表 Key 无效/s,
		);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("全部失败：信封错误同因只贴一句，并提示区域不匹配可能", async () => {
		mockedRequestUrl.mockResolvedValue(respond({ code: 30014, data: null, message: "Token is invalid." }, 401));
		await expect(siliconFlowAdapter.fetchQuota("bad")).rejects.toThrow(
			/硅基流动余额查询失败：国内站、国际站同因：Token is invalid\.（code 30014；凭证或区域不匹配均可能）/,
		);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("结构不符（code 20000 但无 totalBalance）报可解释文案", async () => {
		mockedRequestUrl.mockResolvedValue(respond({ code: 20000, message: "OK", data: {} }));
		await expect(siliconFlowAdapter.fetchQuota("k")).rejects.toThrow(/响应无法解析为已知余额结构/);
	});
});
