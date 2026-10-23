import { describe, expect, it } from "vitest";
import { summarizeQuota } from "../src/quota-summary";
import type { QuotaSnapshot, QuotaWindow } from "../src/types";

const NOW = Date.parse("2026-10-23T12:00:00+08:00");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function windowOf(
	key: string,
	label: string,
	usedPercent: number,
	resetsAt: number | null = null,
	rateLimited = usedPercent >= 100,
): QuotaWindow {
	return { key, label, usedPercent, resetsAt, rateLimited };
}

function snapshotOf(windows: QuotaWindow[], extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
	return { windows, extras: [], capturedAt: NOW, ...extra };
}

describe("summarizeQuota 总额度与余额", () => {
	it("总额度沿用末位窗口口径，多套餐取已用最少的一份", () => {
		const summary = summarizeQuota([
			snapshotOf([windowOf("rolling", "近5小时", 100), windowOf("monthly", "近一月", 80)]),
			snapshotOf([windowOf("rolling", "近5小时", 0), windowOf("monthly", "近一月", 35)]),
		]);
		expect(summary.total).toBe(35);
	});

	it("余额型无窗口：total 为 null，核心余额单独返回", () => {
		const summary = summarizeQuota([snapshotOf([], { coreBalance: "-¥2.50" })]);
		expect(summary.total).toBeNull();
		expect(summary.balance).toBe("-¥2.50");
	});
});

describe("summarizeQuota 折叠行阻断判断", () => {
	it("5h 与周同时用尽：shortBlocked 取重置更晚的周", () => {
		const summary = summarizeQuota([
			snapshotOf([
				windowOf("rolling", "近5小时", 100, NOW + HOUR),
				windowOf("weekly", "近一周", 100, NOW + 3 * DAY),
				windowOf("monthly", "近一月", 40, NOW + 20 * DAY),
			]),
		]);
		expect(summary.totalBlocked).toBe(false);
		expect(summary.shortBlocked?.key).toBe("weekly");
	});

	it("短窗口重置时刻未知（null）仍算阻断；有已知时刻者优先作为标签", () => {
		const summary = summarizeQuota([
			snapshotOf([
				windowOf("rolling", "近5小时", 100, null),
				windowOf("weekly", "近一周", 100, NOW + 3 * DAY),
				windowOf("monthly", "近一月", 40, NOW + 20 * DAY),
			]),
		]);
		expect(summary.shortBlocked?.key).toBe("weekly");
	});

	it("短窗口全部未知：取首个，不编造时间", () => {
		const summary = summarizeQuota([
			snapshotOf([
				windowOf("rolling", "近5小时", 100, null),
				windowOf("monthly", "近一月", 40, NOW + 20 * DAY),
			]),
		]);
		expect(summary.shortBlocked?.key).toBe("rolling");
	});

	it("rateLimited 但百分比未到 100 也算短窗口阻断", () => {
		const summary = summarizeQuota([
			snapshotOf([
				windowOf("rolling", "近5小时", 62, NOW + HOUR, true),
				windowOf("monthly", "近一月", 40, NOW + 20 * DAY),
			]),
		]);
		expect(summary.totalBlocked).toBe(false);
		expect(summary.shortBlocked?.key).toBe("rolling");
	});

	it("末位总窗口满：totalBlocked 优先，短窗口不再接管", () => {
		const summary = summarizeQuota([
			snapshotOf([
				windowOf("rolling", "近5小时", 100, NOW + HOUR),
				windowOf("weekly", "近一周", 100, NOW + 3 * DAY),
				windowOf("monthly", "近一月", 100, NOW + 20 * DAY),
			]),
		]);
		expect(summary.totalBlocked).toBe(true);
	});

	it("单窗口计划（无月窗厂商）：末位周窗满即 totalBlocked", () => {
		const summary = summarizeQuota([
			snapshotOf([windowOf("weekly", "近一周", 100, NOW + DAY)]),
		]);
		expect(summary.totalBlocked).toBe(true);
		expect(summary.shortBlocked).toBeNull();
	});

	it("多套餐：另一份月窗满但总额度代表另一份，不误报 100%", () => {
		const summary = summarizeQuota([
			snapshotOf([windowOf("rolling", "近5小时", 0), windowOf("monthly", "近一月", 100, NOW + DAY)]),
			snapshotOf([windowOf("rolling", "近5小时", 0), windowOf("monthly", "近一月", 35, NOW + 20 * DAY)]),
		]);
		expect(summary.total).toBe(35);
		expect(summary.totalBlocked).toBe(false);
		expect(summary.shortBlocked).toBeNull();
	});

	it("没有阻断窗口时 totalBlocked 为 false、shortBlocked 为 null", () => {
		const summary = summarizeQuota([
			snapshotOf([windowOf("weekly", "近一周", 62, NOW + DAY)]),
		]);
		expect(summary.totalBlocked).toBe(false);
		expect(summary.shortBlocked).toBeNull();
	});
});
