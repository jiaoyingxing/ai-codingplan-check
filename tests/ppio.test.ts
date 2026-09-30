import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { parseApiError, parseBalancePayload, ppioAdapter } from "../src/adapters/ppio";

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
	it("金额单位 1/10000 元：availableBalance 1234500 → ¥123.45；现金/信用额度拆分进 extras", () => {
		const snapshot = parseBalancePayload(
			{ availableBalance: 1234500, cashBalance: 50000, creditLimit: 1000000, pendingCharges: 0, outstandingInvoices: 0 },
			NOW,
		);
		expect(snapshot!.coreBalance).toBe("¥123.45");
		expect(snapshot!.windows).toEqual([]);
		expect(snapshot!.extras).toEqual([
			{ label: "现金余额", value: "¥5.00" },
			{ label: "信用额度", value: "¥100.00" },
		]);
	});

	it("缺 availableBalance / 非对象 → undefined", () => {
		expect(parseBalancePayload({ cashBalance: 1 }, NOW)).toBeUndefined();
		expect(parseBalancePayload(null, NOW)).toBeUndefined();
	});
});

describe("parseApiError", () => {
	it("code != 0 即失败，message 优先、reason 兜底；非信封返回 null", () => {
		expect(parseApiError({ code: 401, reason: "UNAUTHORIZED", message: "key not found", metadata: {} })).toEqual({
			code: 401,
			message: "key not found",
		});
		expect(parseApiError({ code: 401, reason: "UNAUTHORIZED" })).toEqual({ code: 401, message: "UNAUTHORIZED" });
		expect(parseApiError({ code: 0 })).toBeNull();
		expect(parseApiError({ data: {} })).toBeNull();
	});
});

describe("ppioAdapter.fetchQuota", () => {
	const okBody = { availableBalance: 1234500, cashBalance: 50000, creditLimit: 1000000 };

	it("主站成功即返回，Authorization 为 Bearer", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(okBody));
		const snapshots = await ppioAdapter.fetchQuota("sk_test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		const call = mockedRequestUrl.mock.calls[0]![0];
		expect(call.url).toBe("https://api.ppio.com/openapi/v1/billing/balance/detail");
		expect(call.headers).toMatchObject({ authorization: "Bearer sk_test" });
		expect(snapshots[0]!.coreBalance).toBe("¥123.45");
	});

	it("逐个回退：主站失败 → 旧主机成功（ppinfra.com 同形）", async () => {
		mockedRequestUrl
			.mockResolvedValueOnce(respond({ code: 401, reason: "UNAUTHORIZED", message: "key not found" }, 401))
			.mockResolvedValueOnce(respond(okBody));
		const snapshots = await ppioAdapter.fetchQuota("sk_test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe("https://api.ppinfra.com/openapi/v1/billing/balance/detail");
		expect(snapshots[0]!.coreBalance).toBe("¥123.45");
	});

	it("全部失败：信封错误同因只贴一句", async () => {
		mockedRequestUrl.mockResolvedValue(respond({ code: 401, reason: "UNAUTHORIZED", message: "key not found" }, 401));
		await expect(ppioAdapter.fetchQuota("bad")).rejects.toThrow(
			/PPIO 余额查询失败：主站、旧主机同因：key not found（code 401）/,
		);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
	});
});
