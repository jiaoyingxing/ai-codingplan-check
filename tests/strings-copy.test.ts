import { describe, expect, it } from "vitest";
import { STR } from "../src/strings";

/** 语言收口机械门（20260920 三次定稿）：用户可见文案不出现技术词、弃用词与设备窄化词；
 *  「同步」一词多义易惑，凭证导出模块整体弃用（用户拍板），口径改为导出到插件数据/其他设备导入。 */
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

	it("不窄化为手机/移动端，且弃用「同步」一词", () => {
		expect(text).not.toContain("手机");
		expect(text).not.toContain("移动端");
		expect(text).not.toContain("同步");
	});

	it("凭证导出定稿术语齐备", () => {
		expect(text).toContain("凭证导出");
		expect(text).toContain("导出加密副本");
		expect(text).toContain("导出口令");
		expect(text).toContain("加密副本");
		expect(text).toContain("设置导出口令");
		expect(text).toContain("开启导出");
		expect(text).toContain("更新副本");
	});
});
