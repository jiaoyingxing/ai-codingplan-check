import { describe, expect, it } from "vitest";
import { formatErrorCode, splitErrorSegments } from "../src/error-format";

const join = (message: string) => splitErrorSegments(message).map((s) => `${s.code ? "[code]" : "[text]"}${s.text}`);

describe("splitErrorSegments", () => {
	it("纯说明文字不产生代码段", () => {
		expect(join("主号：口令不正确，请重试")).toEqual(["[text]主号：口令不正确，请重试"]);
	});

	it("HTTP 状态与厂商错误码标红，说明文字保持正文", () => {
		expect(join("主号：查询失败（HTTP 401，InvalidAuthorization：密钥被拒绝）")).toEqual([
			"[text]主号：查询失败（",
			"[code]HTTP 401，InvalidAuthorization",
			"[text]：密钥被拒绝）",
		]);
	});

	it("code 数字标红", () => {
		expect(join("查询失败（code 20092；凭证不匹配）")).toEqual([
			"[text]查询失败（",
			"[code]code 20092",
			"[text]；凭证不匹配）",
		]);
	});

	it("完整 JSON 响应整段标红，外层括号仍是说明文字", () => {
		expect(join('查询失败（{"Result":{"Quota":0}}）')).toEqual([
			"[text]查询失败（",
			'[code]{"Result":{"Quota":0}}',
			"[text]）",
		]);
	});

	it("截断的 JSON 片段到结尾标红，包裹右括号不染红", () => {
		const message =
			'主号：查询失败（签名已通过但未解析到任何订阅额度（可能未订阅）：{"ResponseMetadata":{"RequestId":"abc"）';
		expect(join(message)).toEqual([
			"[text]主号：查询失败（签名已通过但未解析到任何订阅额度（可能未订阅）：",
			'[code]{"ResponseMetadata":{"RequestId":"abc"',
			"[text]）",
		]);
	});
});

describe("formatErrorCode", () => {
	it("JSON 标点后补空格，多个响应片段另起一行", () => {
		expect(formatErrorCode('{"A":1,"B":"x"} || {"C":2}')).toBe(
			'{"A": 1, "B": "x"}\n|| {"C": 2}',
		);
	});

	it("已有空格不重复补，URL 冒号不受影响", () => {
		expect(formatErrorCode('{"url":"https://example.com/a","n": 1}')).toBe(
			'{"url": "https://example.com/a", "n": 1}',
		);
	});

	it("引号内的时间戳与逗号原样保留，只改字符串外的标点", () => {
		expect(formatErrorCode('{"time":"10:41:58","msg":"a,b:c","n":1}')).toBe(
			'{"time": "10:41:58", "msg": "a,b:c", "n": 1}',
		);
	});

	it("前一段被截断在字符串内时，后一段仍独立排版并换行", () => {
		expect(formatErrorCode('{"A":"x… || {"B":"y","C":1}')).toBe(
			'{"A": "x…\n|| {"B": "y", "C": 1}',
		);
	});
});
