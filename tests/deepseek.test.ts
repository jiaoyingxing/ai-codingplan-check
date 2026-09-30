import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { deepSeekAdapter, parseBalancePayload } from "../src/adapters/deepseek";

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

beforeEach(() => {
	mockedRequestUrl.mockReset();
});

describe("parseBalancePayload", () => {
	it("主币种 CNY 优先（与响应顺序无关）；coreBalance 与赠送/充值拆分进 extras，其余币种不丢", () => {
		const snapshot = parseBalancePayload(
			{
				is_available: true,
				balance_infos: [
					{ currency: "USD", total_balance: "2.50", granted_balance: "0.50", topped_up_balance: "2.00" },
					{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
				],
			},
			NOW,
		);
		expect(snapshot!.coreBalance).toBe("¥110.00");
		expect(snapshot!.windows).toEqual([]);
		expect(snapshot!.extras).toEqual([
			{ label: "赠送余额", value: "¥10.00" },
			{ label: "充值余额", value: "¥100.00" },
			{ label: "美元余额", value: "$2.50" },
		]);
		expect(snapshot!.capturedAt).toBe(NOW);
	});

	it("无 CNY 时取响应首个币种；未收录币种用「金额 + 代码」后缀形态", () => {
		const snapshot = parseBalancePayload({ balance_infos: [{ currency: "GBP", total_balance: "5.00" }] }, NOW);
		expect(snapshot!.coreBalance).toBe("5.00 GBP");
		expect(snapshot!.extras).toEqual([]);
	});

	it("金额字符串规整两位小数", () => {
		const snapshot = parseBalancePayload({ balance_infos: [{ currency: "CNY", total_balance: "9.5" }] }, NOW);
		expect(snapshot!.coreBalance).toBe("¥9.50");
	});

	it("缺 total_balance / 空列表 / 非对象 → undefined（由调用方报可解释错误）", () => {
		expect(parseBalancePayload({ balance_infos: [{ currency: "CNY" }] })).toBeUndefined();
		expect(parseBalancePayload({ balance_infos: [] })).toBeUndefined();
		expect(parseBalancePayload(null)).toBeUndefined();
		expect(parseBalancePayload({})).toBeUndefined();
	});
});

describe("deepSeekAdapter.fetchQuota", () => {
	const okBody = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00" }] };

	it("单端点 Bearer 直查，返回余额快照", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(okBody));
		const snapshots = await deepSeekAdapter.fetchQuota("sk-test");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		const call = mockedRequestUrl.mock.calls[0]![0];
		expect(call.url).toBe("https://api.deepseek.com/user/balance");
		expect(call.headers).toMatchObject({ authorization: "Bearer sk-test", accept: "application/json" });
		expect(snapshots[0]!.coreBalance).toBe("¥110.00");
	});

	it("401 报状态码与响应片段（错误可解释）", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond({ error: { message: "Authentication Fails" } }, 401));
		await expect(deepSeekAdapter.fetchQuota("bad")).rejects.toThrow(/HTTP 401.*Authentication Fails/s);
	});

	it("is_available=false 照常解析（§v1.2 裁决④默认不展示状态行）", async () => {
		mockedRequestUrl.mockResolvedValueOnce(
			respond({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] }),
		);
		const snapshots = await deepSeekAdapter.fetchQuota("k");
		expect(snapshots[0]!.coreBalance).toBe("¥0.00");
	});
});
