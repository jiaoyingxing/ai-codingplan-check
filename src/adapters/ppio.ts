import { requestUrl } from "obsidian";
import { firstSuccessful, jsonOf, snippet, type AttemptResult } from "./request";
import { toAmountText, withCurrencySymbol } from "../format";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot } from "../types";

// PPIO 派欧云余额接口契约（官方文档 ppio.com/docs/management/reference-billing-get-balance-detail，2026-09 核对；
// 域名已从 ppinfra.com 301 → ppio.com，旧主机同形仍可用。2026-09-30 无凭证探测实证：坏 Key 两主机均返回
// HTTP 401 + {"code":401,"reason":"UNAUTHORIZED","message":"key not found"}，路由存活）：
//   GET https://api.ppio.com/openapi/v1/billing/balance/detail（旧主机 api.ppinfra.com 回退）
//     Authorization: Bearer <API Key（sk_…，与推理同一把）>
//   200 → { availableBalance, cashBalance, creditLimit, pendingCharges, outstandingInvoices }
// ⚠ 金额单位为 1/10000 元（0.0001 元）：展示统一 ÷10000 保留两位小数（官方文档口径，社区实现同）。
//   availableBalance = 可用余额（现金 + 信用可用）；pendingCharges / outstandingInvoices 语义未实测，不展示。

const CANDIDATES = [
	{ name: "主站", url: "https://api.ppio.com/openapi/v1/billing/balance/detail" },
	{ name: "旧主机", url: "https://api.ppinfra.com/openapi/v1/billing/balance/detail" },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberLike(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** 1/10000 元 → 元文本（两位小数）。 */
function fromBasisPoint(value: unknown): string | undefined {
	const raw = numberLike(value);
	return raw === undefined ? undefined : toAmountText(raw / 10000);
}

export interface PpioApiError {
	code: number | null;
	message: string | null;
}

/** 信封判定：code 存在且非 0 即失败（401 信封带 reason/message）。 */
export function parseApiError(payload: unknown): PpioApiError | null {
	if (!isRecord(payload) || typeof payload.code !== "number") return null;
	if (payload.code === 0) return null;
	const message =
		typeof payload.message === "string"
			? payload.message
			: typeof payload.reason === "string"
				? payload.reason
				: null;
	return { code: payload.code, message };
}

export function parseBalancePayload(payload: unknown, now = Date.now()): QuotaSnapshot | undefined {
	if (!isRecord(payload)) return undefined;
	const available = fromBasisPoint(payload.availableBalance);
	if (available === undefined) return undefined;
	const extras: QuotaExtra[] = [];
	const cash = fromBasisPoint(payload.cashBalance);
	const credit = fromBasisPoint(payload.creditLimit);
	if (cash !== undefined) extras.push({ label: "现金余额", value: withCurrencySymbol("¥", cash) });
	if (credit !== undefined) extras.push({ label: "信用额度", value: withCurrencySymbol("¥", credit) });
	return { coreBalance: withCurrencySymbol("¥", available), windows: [], extras, capturedAt: now };
}

async function fetchFrom(entry: (typeof CANDIDATES)[number], secret: string): Promise<AttemptResult<QuotaSnapshot>> {
	let response;
	try {
		// throw:false：401/5xx 也要拿到响应体，错误里带状态码与片段。
		response = await requestUrl({
			url: entry.url,
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${secret}` },
			throw: false,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { failure: `请求失败：${message}` };
	}
	const raw = response.text;
	const payload = jsonOf(response);
	const apiError = parseApiError(payload);
	if (apiError) {
		const detail = apiError.message ?? "凭证被拒绝";
		return { failure: `${detail}（code ${apiError.code}）` };
	}
	if (response.status >= 400) return { failure: `HTTP ${response.status}：${snippet(raw)}` };
	const snapshot = parseBalancePayload(payload);
	if (!snapshot) {
		console.warn(`[ai-codingplan-check] PPIO ${entry.name}原始响应：`, raw);
		return { failure: `响应无法解析为已知余额结构：${snippet(raw)}` };
	}
	return { value: snapshot };
}

export const ppioAdapter: ProviderAdapter = {
	id: "ppio",
	label: "PPIO",
	credentialLabel: "API Key",
	credentialHint: "PPIO API Key（sk_…，与推理用同一把）",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const snapshot = await firstSuccessful(
			"PPIO 余额查询失败",
			CANDIDATES.map((entry) => ({ name: entry.name, run: () => fetchFrom(entry, secret) })),
		);
		return [snapshot];
	},
};
