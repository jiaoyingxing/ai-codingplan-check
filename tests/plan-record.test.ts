import { describe, expect, it } from "vitest";
import { observedPlanPeriod, updateLastPlan } from "../src/plan-record";
import type { AccountRecord, QuotaSnapshot } from "../src/types";

const ACCOUNT: AccountRecord = {
	id: "acc-1",
	provider: "commandcode",
	alias: "主号",
	secretId: "account-acc-1",
	enabled: true,
};

function snapshot(fields: Partial<QuotaSnapshot>): QuotaSnapshot {
	return { windows: [], extras: [], capturedAt: 1, ...fields };
}

describe("observedPlanPeriod", () => {
	it("取第一份带真实周期结束时刻的读数，名称随 planName", () => {
		expect(observedPlanPeriod([{ planName: "Pro 档", planPeriodEnd: 1_794_000_000_000, windows: [], extras: [], capturedAt: 1 }])).toEqual({
			name: "Pro 档",
			periodEnd: 1_794_000_000_000,
		});
		expect(observedPlanPeriod([snapshot({ planName: "余额卡" }), snapshot({ planName: "套餐卡", planPeriodEnd: 42 })])).toEqual({
			name: "套餐卡",
			periodEnd: 42,
		});
	});

	it("没有 planPeriodEnd（接口没给/暂未订阅/余额型）→ null，不下结论", () => {
		expect(observedPlanPeriod([])).toBeNull();
		expect(observedPlanPeriod([snapshot({ planName: "Pro 档" })])).toBeNull();
		expect(observedPlanPeriod([snapshot({ planPeriodEnd: Number.NaN })])).toBeNull();
		expect(observedPlanPeriod([snapshot({ planPeriodEnd: 0 })])).toBeNull();
	});

	it("planName 缺失时只存周期", () => {
		expect(observedPlanPeriod([snapshot({ planPeriodEnd: 42 })])).toEqual({ periodEnd: 42 });
	});
});

describe("updateLastPlan", () => {
	it("首查建档：periodEnd + observedAt，返回 true", () => {
		const account = { ...ACCOUNT };
		expect(updateLastPlan(account, [snapshot({ planName: "Pro 档", planPeriodEnd: 1_794_000_000_000 })], 1_000)).toBe(true);
		expect(account.lastPlan).toEqual({ name: "Pro 档", periodEnd: 1_794_000_000_000, observedAt: 1_000 });
	});

	it("与存档一致时不改写（返回 false，避免每次刷新都写盘）", () => {
		const account: AccountRecord = { ...ACCOUNT, lastPlan: { name: "Pro 档", periodEnd: 42, observedAt: 1 } };
		expect(updateLastPlan(account, [snapshot({ planName: "Pro 档", planPeriodEnd: 42 })], 2_000)).toBe(false);
		expect(account.lastPlan?.observedAt).toBe(1);
	});

	it("重新订阅 = 新周期覆盖旧档", () => {
		const account: AccountRecord = { ...ACCOUNT, lastPlan: { name: "旧档", periodEnd: 42, observedAt: 1 } };
		expect(updateLastPlan(account, [snapshot({ planName: "Pro 档", planPeriodEnd: 100 })], 2_000)).toBe(true);
		expect(account.lastPlan).toEqual({ name: "Pro 档", periodEnd: 100, observedAt: 2_000 });
	});

	it("快照无周期时不动存档：到期后接口查不到历史，旧档原样保留", () => {
		const account: AccountRecord = { ...ACCOUNT, lastPlan: { name: "Pro 档", periodEnd: 42, observedAt: 1 } };
		expect(updateLastPlan(account, [snapshot({ unavailableReason: "暂未订阅" })], 2_000)).toBe(false);
		expect(account.lastPlan).toEqual({ name: "Pro 档", periodEnd: 42, observedAt: 1 });
		expect(updateLastPlan({ ...ACCOUNT }, [], 2_000)).toBe(false);
	});
});
