import { describe, expect, it } from "vitest";
import { formatPercent, formatResetCountdown, toAmountText, withCurrencySymbol } from "../src/format";
describe("formatPercent", () => {
	it("最多两位小数并去尾零", () => {
		expect(formatPercent(67.526)).toBe("67.53");
		expect(formatPercent(0.4)).toBe("0.4");
		expect(formatPercent(1)).toBe("1");
		expect(formatPercent(100)).toBe("100");
		expect(formatPercent(0)).toBe("0");
	});
	it("四舍五入进位到整数时无小数残留", () => {
		expect(formatPercent(99.999)).toBe("100");
		expect(formatPercent(0.96)).toBe("0.96");
	});
});

describe("formatResetCountdown", () => {
	const now = Date.parse("2026-09-20T12:00:00+08:00");

	it("null 返回空串，已过期返回即将重置", () => {
		expect(formatResetCountdown(null, now)).toBe("");
		expect(formatResetCountdown(now - 1000, now)).toBe("即将重置");
	});

	it("<1小时 只报分钟", () => {
		expect(formatResetCountdown(now + 45 * 60000, now)).toBe("45 分钟后重置");
	});

	it("<24小时 复合小时+分，零分省略", () => {
		expect(formatResetCountdown(now + (13 * 60 + 47) * 60000, now)).toBe("13 小时 47 分后重置");
		expect(formatResetCountdown(now + 2 * 3600000, now)).toBe("2 小时后重置");
		expect(formatResetCountdown(now + 60 * 60000, now)).toBe("1 小时后重置");
	});

	it("≥1天 复合天+小时，零小时省略", () => {
		expect(formatResetCountdown(now + (22 * 24 + 13) * 3600000, now)).toBe("22 天 13 小时后重置");
		expect(formatResetCountdown(now + 3 * 86400000, now)).toBe("3 天后重置");
	});

	it("compact 紧凑排版去空格与后缀，只留时长", () => {
		expect(formatResetCountdown(now + (22 * 24 + 13) * 3600000, now, true)).toBe("22天13小时");
		expect(formatResetCountdown(now + (13 * 60 + 47) * 60000, now, true)).toBe("13小时47分");
		expect(formatResetCountdown(now + 45 * 60000, now, true)).toBe("45分钟");
		expect(formatResetCountdown(now + 3 * 86400000, now, true)).toBe("3天");
		expect(formatResetCountdown(null, now, true)).toBe("");
		expect(formatResetCountdown(now - 1000, now, true)).toBe("即将重置");
	});
});

describe("toAmountText（余额型 §v1.2）", () => {
	it("统一两位小数：数字、字符串、负值", () => {
		expect(toAmountText("110.00")).toBe("110.00");
		expect(toAmountText(49.58894)).toBe("49.59");
		expect(toAmountText(-2.5)).toBe("-2.50");
		expect(toAmountText(0)).toBe("0.00");
	});
	it("非法输入原样返回（上层兜底展示）", () => {
		expect(toAmountText("abc")).toBe("abc");
		expect(toAmountText(Number.NaN)).toBe("NaN");
	});
});

describe("withCurrencySymbol（余额型 §v1.2 裁决③）", () => {
	it("负号恒置于符号最前，面板按前缀负号识别红字", () => {
		expect(withCurrencySymbol("¥", "110.00")).toBe("¥110.00");
		expect(withCurrencySymbol("¥", "-2.50")).toBe("-¥2.50");
		expect(withCurrencySymbol("$", "-0.01")).toBe("-$0.01");
	});
});
