import { describe, expect, it } from "vitest";
import { formatPercent, formatResetCountdown } from "../src/format";

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
