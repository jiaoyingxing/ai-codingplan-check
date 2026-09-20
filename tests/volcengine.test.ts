import { describe, expect, it, vi } from "vitest";
import {
	canonicalQuery,
	parseAfpTiers,
	parseCodingTiers,
	responseError,
	signRequest,
	volcengineAdapter,
} from "../src/adapters/volcengine";

// obsidian npm 包是纯类型包（main 为空），运行时必须 mock。
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

// 跨语言金标：同输入下与 Python 参考实现（hmac/sha256 标准库，照 CC Switch
// volcengine_sign 算法逐行复刻）算得的 Authorization 完全一致——算法串无 AWS4
// 前缀、固定顺序 SignedHeaders、scope 结尾 ark/request、kDate 不加前缀。
const GOLDEN_AUTH =
	"HMAC-SHA256 Credential=AKLTtest/20240621/cn-beijing/ark/request, SignedHeaders=host;x-date;x-content-sha256;content-type, Signature=4ceb5e7c3c834fe8604cccf04eeec5ab09045d2e5a36723921f8cea691b0a186";

describe("volcengine signing", () => {
	it("金标一致：AK/SK/region/query/空 body/固定时间 → Authorization 逐字节相同", async () => {
		const query = canonicalQuery("GetAFPUsage", "cn-beijing");
		const [auth, xDate, contentSha] = await signRequest(
			"AKLTtest",
			"secretkey",
			"cn-beijing",
			query,
			new TextEncoder().encode(""),
			new Date("2024-06-21T00:00:00Z"),
		);
		expect(query).toBe("Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01");
		expect(contentSha).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(xDate).toBe("20240621T000000Z");
		expect(auth).toBe(GOLDEN_AUTH);
	});

	it("确定性：同输入同签名", async () => {
		const query = canonicalQuery("GetAFPUsage", "cn-beijing");
		const args = ["AKLTtest", "secretkey", "cn-beijing", query, new TextEncoder().encode(""), new Date("2024-06-21T00:00:00Z")] as const;
		const a = await signRequest(...args);
		const b = await signRequest(...args);
		expect(a[0]).toBe(b[0]);
	});
});

describe("responseError / auth code", () => {
	it("抽取 ResponseMetadata.Error 与顶层 Error；无 Error 返回 null", () => {
		expect(
			responseError({ ResponseMetadata: { RequestId: "x", Error: { Code: "AccessDenied", Message: "no permission" } } }),
		).toEqual({ code: "AccessDenied", message: "no permission" });
		expect(responseError({ Error: { Code: "SignatureDoesNotMatch", Message: "bad sig" } })).toEqual({
			code: "SignatureDoesNotMatch",
			message: "bad sig",
		});
		expect(responseError({ ResponseMetadata: { RequestId: "x" }, Result: {} })).toBeNull();
		expect(responseError({ Error: { Code: "InvalidParameter.Action", Message: "x" } })).toBeTruthy();
	});
});

describe("parseAfpTiers（Agent Plan，Quota/Used 绝对值）", () => {
	it("三窗口解析、Quota<=0 跳过、百分比=Used/Quota、秒级 ResetTime 转 ms", () => {
		const windows = parseAfpTiers({
			AFPFiveHour: { Quota: 12, Used: 3, ResetTime: 1_700_100_000 },
			AFPWeekly: { Quota: 0, Used: 0, ResetTime: null },
			AFPMonthly: { Quota: 30, Used: 30.5, ResetTime: "2026-09-30T00:00:00Z" },
		});
		expect(windows).toHaveLength(2);
		expect(windows[0]).toMatchObject({ key: "AFPFiveHour", label: "近5小时", usedPercent: 25, resetsAt: 1_700_100_000_000 });
		expect(windows[1]).toMatchObject({ key: "AFPMonthly", label: "近一月", usedPercent: 100, rateLimited: true });
	});

	it("空 Result → 空数组（用于回落 Coding Plan 探测）", () => {
		expect(parseAfpTiers({})).toEqual([]);
		expect(parseAfpTiers(null)).toEqual([]);
	});
});

describe("parseCodingTiers（Coding Plan，只回已用百分比）", () => {
	it("Level=session|weekly|monthly 映射，daily 等未知档跳过", () => {
		const windows = parseCodingTiers({
			QuotaUsage: [
				{ Level: "session", Percent: 37, ResetTime: 1_700_100_000 },
				{ Level: "weekly", Percent: 62, ResetTime: 1_700_100_000 },
				{ Level: "monthly", Percent: 100, ResetTime: 1_700_100_000 },
				{ Level: "daily", Percent: 5 },
			],
		});
		expect(windows.map((w) => w.label)).toEqual(["近5小时", "近一周", "近一月"]);
		expect(windows[2]).toMatchObject({ usedPercent: 100, rateLimited: true });
	});

	it("防御式回退：Usages/Details 数组与 Type/Period 字段名", () => {
		expect(parseCodingTiers({ Usages: [{ Type: "weekly", Percent: 6 }] }).map((w) => w.label)).toEqual(["近一周"]);
		expect(parseCodingTiers({ Details: [{ Period: "monthly", Percent: 8 }] }).map((w) => w.label)).toEqual(["近一月"]);
	});
});

describe("双凭证拆合", () => {
	it("join → split 往返一致；坏数据回落整体当 AK", () => {
		const stored = volcengineAdapter.joinCredential!("AK-x", "SK-y");
		expect(volcengineAdapter.splitCredential!(stored)).toEqual(["AK-x", "SK-y"]);
		expect(volcengineAdapter.splitCredential!("legacy-raw")).toEqual(["legacy-raw", ""]);
		expect(volcengineAdapter.splitCredential!("not-json{")).toEqual(["not-json{", ""]);
	});
});
