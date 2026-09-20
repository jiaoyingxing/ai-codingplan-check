import { describe, expect, it } from "vitest";
import { STR } from "../src/strings";

/** 语言收口机械门（20260920 定稿）：用户可见文案不出现技术词、弃用词与设备窄化词（同步面向所有设备）。 */
describe("用户文案禁词与定稿口径", () => {
	const text = JSON.stringify(STR);

	it("不含实现层技术词（密文副本 / data.json / 会话）", () => {
		expect(text).not.toContain("密文副本");
		expect(text).not.toContain("data.json");
		expect(text).not.toContain("会话");
	});

	it("不含弃用的开发视角词（移动端解锁 / 解密失败）", () => {
		expect(text).not.toContain("移动端解锁");
		expect(text).not.toContain("解密失败");
	});

	it("同步面向所有设备，不窄化为手机/移动端", () => {
		expect(text).not.toContain("手机");
		expect(text).not.toContain("移动端");
	});

	it("跨设备同步定稿术语齐备", () => {
		expect(text).toContain("跨设备同步");
		expect(text).toContain("同步口令");
		expect(text).toContain("加密副本");
		expect(text).toContain("开启同步");
		expect(text).toContain("更新副本");
		expect(text).toContain("停用");
	});
});
