import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import {
	normalizeCookie,
	parseFinancialInfo,
	parseSubjectId,
	parseWalletName,
	parseWallets,
	siliconFlowCookieAdapter,
	totalAvailableText,
} from "../src/adapters/siliconflow-cookie";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const mockedRequestUrl = vi.mocked(requestUrl);

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

describe("normalizeCookie", () => {
	it("容忍裸值 / 整对 name=value / Cookie: 前缀 / 引号", () => {
		expect(normalizeCookie("tok123")).toBe("__SF_auth.session-token=tok123");
		expect(normalizeCookie("__SF_auth.session-token=tok123")).toBe("__SF_auth.session-token=tok123");
		expect(normalizeCookie("Cookie: __SF_auth.session-token=tok123")).toBe("__SF_auth.session-token=tok123");
		expect(normalizeCookie(' "tok123" ')).toBe("__SF_auth.session-token=tok123");
	});
	it("整串 Cookie（含目标对）自动提取该对——Network 请求头整串粘贴可用", () => {
		expect(normalizeCookie("other=x; __SF_auth.session-token=tok123; foo=y")).toBe(
			"__SF_auth.session-token=tok123",
		);
		expect(normalizeCookie('"__SF_auth.session-token=tok123"')).toBe("__SF_auth.session-token=tok123");
		expect(normalizeCookie("a=1; b=2")).toBe("__SF_auth.session-token=a=1; b=2");
	});
});

describe("parseSubjectId", () => {
	it("data 数组取首个 subjectId；对象形态兜底；trim", () => {
		expect(parseSubjectId({ code: 20000, data: [{ subjectId: " subj123 " }] })).toBe("subj123");
		expect(parseSubjectId({ data: { subjectId: "abc" } })).toBe("abc");
		expect(parseSubjectId({ data: [{ subject_id: 42 }] })).toBe("42");
		expect(parseSubjectId({ data: [] })).toBeUndefined();
		expect(parseSubjectId(null)).toBeUndefined();
	});
});

describe("parseFinancialInfo", () => {
	it("1 元 = 1e12：available 进 coreBalance 口径，balance/recharged/used 作拆分", () => {
		const texts = parseFinancialInfo({
			code: 20000,
			data: {
				financialInfo: {
					balance: "48000000000000",
					available: "48000000000000",
					recharged: "100000000000000",
					used: "52000000000000",
				},
			},
		});
		expect(texts!.available).toBe("48.00");
		expect(texts!.balance).toBe("48.00");
		expect(texts!.recharged).toBe("100.00");
		expect(texts!.used).toBe("52.00");
	});

	it("available 缺失退 balance；结构不符 undefined", () => {
		expect(parseFinancialInfo({ code: 20000, data: { financialInfo: { balance: "12000000000000" } } })!.available).toBe(
			"12.00",
		);
		expect(parseFinancialInfo({ code: 20000, data: {} })).toBeUndefined();
		expect(parseFinancialInfo(null)).toBeUndefined();
	});
});

describe("parseWallets", () => {
	it("多语言名取 zh-cn；跳过授信 cap=-1 / 用尽 status=1 / 零余额；到期附日期；给合计与张数", () => {
		const breakdown = parseWallets({
			code: 20000,
			data: {
				wallets: [
					{
						name: '{"zh-cn":"认证奖励金","en":"Auth bonus"}',
						cap: "16000000000000",
						balance: "16000000000000",
						status: 0,
						stage: 3,
						expiresAt: 1790000000000,
					},
					{ name: "授信账户", cap: "-1", balance: "99900000000000", status: 0 },
					{ name: "用尽券", cap: "10000000000000", balance: "0", status: 1 },
				],
			},
		});
		expect(breakdown.extras).toEqual([
			{ label: "认证奖励金", value: "¥16.00", detail: "2026-09-21 到期" },
		]);
		expect(breakdown.total).toBe("16.00");
		expect(breakdown.count).toBe(1);
	});

	it("非 JSON 名退原文；结构不符返回空明细", () => {
		expect(parseWalletName("新用户礼包")).toBe("新用户礼包");
		expect(parseWalletName('{"en":"Gift"}')).toBe("Gift");
		expect(parseWalletName("")).toBe("代金券");
		expect(parseWallets({ code: 20000, data: {} })).toEqual({ extras: [], count: 0 });
		expect(parseWallets(null)).toEqual({ extras: [], count: 0 });
	});
});

describe("totalAvailableText（§v1.2 裁决⑥：行槽位 = 可用额度合计）", () => {
	it("现金 + 代金券求和两位小数；无券归一化；负现金可加；非法退现金原样", () => {
		expect(totalAvailableText("48.00", "16.00")).toBe("64.00");
		expect(totalAvailableText("48.00", undefined)).toBe("48.00");
		expect(totalAvailableText("-2.50", "10.00")).toBe("7.50");
		expect(totalAvailableText("不是数字", "1.00")).toBe("不是数字");
	});
});

describe("siliconFlowCookieAdapter.fetchQuota", () => {
	const subjectsBody = { code: 20000, data: [{ subjectId: "subj123" }] };
	const peekBody = {
		code: 20000,
		data: {
			financialInfo: {
				balance: "48000000000000",
				available: "48000000000000",
				recharged: "100000000000000",
				used: "52000000000000",
			},
		},
	};
	const walletsBody = {
		code: 20000,
		data: {
			wallets: [
				{
					name: '{"zh-cn":"认证奖励金"}',
					cap: "16000000000000",
					balance: "16000000000000",
					status: 0,
					expiresAt: 1790000000000,
				},
			],
		},
	};

	it("三步链：Cookie 头贯穿、X-Subject-Id 自取；行槽位=现金+代金券合计（裁决⑥），extras 依次为充值余额/累计/代金券合计/明细", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(subjectsBody)).mockResolvedValueOnce(respond(peekBody));
		mockedRequestUrl.mockResolvedValueOnce(respond(walletsBody));
		const snapshots = await siliconFlowCookieAdapter.fetchQuota("tok123");
		expect(mockedRequestUrl).toHaveBeenCalledTimes(3);
		expect(mockedRequestUrl.mock.calls[0]![0].url).toBe("https://account.siliconflow.cn/api/subjects");
		const peekCall = mockedRequestUrl.mock.calls[1]![0];
		expect(peekCall.url).toBe("https://cloud.siliconflow.cn/walletd-server/api/v1/subject/profile/peek");
		expect(peekCall.headers).toMatchObject({
			cookie: "__SF_auth.session-token=tok123",
			"x-subject-id": "subj123",
		});
		expect(mockedRequestUrl.mock.calls[2]![0].url).toContain("/walletd-server/api/v1/subject/wallets");
		expect(snapshots[0]!.coreBalance).toBe("¥64.00");
		expect(snapshots[0]!.windows).toEqual([]);
		expect(snapshots[0]!.extras).toEqual([
			{ label: "充值余额", value: "¥48.00" },
			{ label: "累计充值", value: "¥100.00" },
			{ label: "累计消费", value: "¥52.00" },
			{ label: "代金券合计", value: "¥16.00", detail: "1 张" },
			{ label: "认证奖励金", value: "¥16.00", detail: "2026-09-21 到期" },
		]);
	});

	it("subjects 返回登录页 HTML：报会话失效并终止（不继续后续请求）", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond("<!DOCTYPE html><html>login</html>", 302));
		await expect(siliconFlowCookieAdapter.fetchQuota("stale")).rejects.toThrow(
			/会话 Cookie 已失效.*重新从浏览器复制/s,
		);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("peek 业务码 40100 = 会话失效；其他码报控制台错误", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(subjectsBody)).mockResolvedValueOnce(
			respond({ code: 40100, message: "session expired" }),
		);
		await expect(siliconFlowCookieAdapter.fetchQuota("stale")).rejects.toThrow(/会话 Cookie 已失效.*code 40100/s);

		mockedRequestUrl.mockReset();
		mockedRequestUrl.mockResolvedValueOnce(respond(subjectsBody)).mockResolvedValueOnce(
			respond({ code: 50000, message: "boom" }),
		);
		await expect(siliconFlowCookieAdapter.fetchQuota("tok")).rejects.toThrow(/控制台返回错误（code 50000；boom）/);
	});

	it("wallets 失败不拖垮余额主链：行槽位退纯现金可用（裁决⑥降级），只剩充值余额与累计拆分", async () => {
		mockedRequestUrl.mockResolvedValueOnce(respond(subjectsBody)).mockResolvedValueOnce(respond(peekBody));
		mockedRequestUrl.mockResolvedValueOnce(respond("Not Found", 404));
		const snapshots = await siliconFlowCookieAdapter.fetchQuota("tok123");
		expect(snapshots[0]!.coreBalance).toBe("¥48.00");
		expect(snapshots[0]!.extras).toEqual([
			{ label: "充值余额", value: "¥48.00" },
			{ label: "累计充值", value: "¥100.00" },
			{ label: "累计消费", value: "¥52.00" },
		]);
	});
});
