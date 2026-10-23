import { requestUrl } from "obsidian";
import { jsonOf } from "./request";
import { isRecord, snippet } from "./shared";
import { toAmountText, withCurrencySymbol } from "../format";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot } from "../types";

// 阶跃星辰账户接口契约（官方文档 platform.stepfun.com/docs/zh/api-reference/accounts/get，2026-09 核对；
// 无凭证探测实证：坏 Key 返回 HTTP 401 + {"error":{"type":"invalid_api_key"}}，路由存活）：
//   GET https://api.stepfun.com/v1/accounts
//     Authorization: Bearer <API Key（与推理同一把）>
//   200 → { object: "account", type: "prepaid" | "postpaid",
//           balance: 12.34, total_cash_balance: …, total_voucher_balance: … }（CNY）
// balance = 当前可用余额（数字或字符串）；充值/赠送为累计总额（非剩余拆分），键名相应作「总额」。
// 后付费（postpaid）账户余额可为负——负值由面板红字呈现（§v1.2 裁决③）。

const USAGE_URL = "https://api.stepfun.com/v1/accounts";

/** 计费类型展示值；未知类型不进 extras（避免硬编码翻译错误）。 */
const BILLING_TYPES: Record<string, string> = { prepaid: "预付费", postpaid: "后付费" };

function numberLike(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function textOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 解析账户响应；balance 缺失视为结构不符（undefined，由调用方报可解释错误）。 */
export function parseAccountPayload(payload: unknown, now = Date.now()): QuotaSnapshot | undefined {
	if (!isRecord(payload)) return undefined;
	const balance = numberLike(payload.balance);
	if (balance === undefined) return undefined;
	const extras: QuotaExtra[] = [];
	const cash = numberLike(payload.total_cash_balance);
	const voucher = numberLike(payload.total_voucher_balance);
	if (cash !== undefined) extras.push({ label: "充值总额", value: withCurrencySymbol("¥", toAmountText(cash)) });
	if (voucher !== undefined) extras.push({ label: "赠送总额", value: withCurrencySymbol("¥", toAmountText(voucher)) });
	const billingType = textOf(payload.type);
	const typeLabel = billingType ? BILLING_TYPES[billingType] : undefined;
	if (typeLabel) extras.push({ label: "计费类型", value: typeLabel });
	return { coreBalance: withCurrencySymbol("¥", toAmountText(balance)), windows: [], extras, capturedAt: now };
}

export const stepFunAdapter: ProviderAdapter = {
	id: "stepfun",
	label: "StepFun",
	credentialHint: "阶跃星辰 API Key（与推理用同一把）",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		// throw:false：401 等也要拿到响应体，错误里带状态码与片段。
		const response = await requestUrl({
			url: USAGE_URL,
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${secret}` },
			throw: false,
		});
		const raw = response.text;
		if (response.status >= 400) {
			throw new Error(`HTTP ${response.status}：${snippet(raw)}`);
		}
		const snapshot = parseAccountPayload(jsonOf(response));
		if (!snapshot) {
			console.warn("[ai-codingplan-check] StepFun 原始响应：", raw);
			throw new Error(`HTTP ${response.status} 响应无法解析为已知账户结构：${snippet(raw)}`);
		}
		return [snapshot];
	},
};
