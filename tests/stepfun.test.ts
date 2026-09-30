import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { parseAccountPayload, stepFunAdapter } from "../src/adapters/stepfun";

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

describe("parseAccountPayload", () => {
	it("balance 进 coreBalance；充值/赠送总额与计费类型进 extras（prepaid → 预付费）", () => {
		const snapshot = parseAccountPayload(
			{ object: "account", type: "prepaid", balance: 12.345, total_cash_balance: 100, total_voucher_balance: 5 },
			NOW,
		);
		expect(snapshot!.coreBalance).toBe("¥12.35");
		expect(snapshot!.windows).toEqual([]);
		expect(snapshot!.extras).toEqual([
			{ label: "充值总额", value: "¥100.00" },
			{ label: "赠送总额", value: "¥5.00" },
			{ label: "计费类型", value: "预付费" },
		]);
	});

	it("postpaid → 后付费；负余额负号在最前（面板红字识别口径）", () => {
		const snapshot = parseAccountPayload({ object: "account", type: "postpaid", balance: -3.2 }, NOW);
		expect(snapshot!.coreBalance).toBe("-¥3.20");
		expect(snapshot!.extras).toEqual([{ label: "计费类型", value: "后付费" }]);
	});

	it("balance 兼容字符串；缺 balance / 非对象 → undefined；未知 type 不进 extras", () => {
		expect(parseAccountPayload({ balance: "9.5" }, NOW)!.coreBalance).toBe("¥9.50");
		expect(parseAccountPayload({ object: "account", type: "enterprise" }, NOW)).toBeUndefined();
		expect(parseAccountPayload(null, NOW)).toBeUndefined();
	});
});

describe("stepFunAdapter.fetchQuota", () => {
	it("单端点 Bearer 直查，返回余额快照", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond({ object: "account", type: "prepaid", balance: 12.3 }));
		const snapshots = await stepFunAdapter.fetchQuota("sk-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		const call = mockedRequestUrl.mock.calls[0]![0];
		expect(call.url).toBe("https://api.stepfun.com/v1/accounts");
		expect(call.headers).toMatchObject({ authorization: "Bearer sk-test" });
		expect(snapshots[0]!.coreBalance).toBe("¥12.30");
	});

	it("401 报状态码与响应片段（错误可解释）", async () => {
		mockedRequestUrl.mockResolvedValueOnce(
			respond({ error: { message: "Incorrect API key provided", type: "invalid_api_key" } }, 401),
		);
		await expect(stepFunAdapter.fetchQuota("bad")).rejects.toThrow(/HTTP 401.*Incorrect API key provided/s);
	});
});
