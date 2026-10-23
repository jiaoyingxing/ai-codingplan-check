import { requestUrl } from "obsidian";
import { firstSuccessful, jsonOf, type AttemptResult } from "./request";
import { isRecord, snippet } from "./shared";
import { toAmountText, withCurrencySymbol } from "../format";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot } from "../types";

// Moonshot 开放平台（Kimi 按量）余额接口契约（官方文档 platform.kimi.com/docs/api/balance，2026-09 核对；
// 旧控制台域名 platform.moonshot.cn 已 301 → platform.kimi.com，API 域名不变。2026-09-30 无凭证探测
// 实证：坏 Key 两站均返回 HTTP 401 + {"error":{"type":"invalid_authentication_error"}}，路由存活）：
//   GET https://api.moonshot.cn/v1/users/me/balance（国内站，CNY）
//   GET https://api.moonshot.ai/v1/users/me/balance（国际站，USD）
//     Authorization: Bearer <开放平台 API Key（sk-…；不是 Kimi For Coding 的 sk-kimi-…）>
//   200 → { code: 0, status: true, scode: "0x0",
//           data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 } }
// ⚠ 信封：code != 0 或 status = false 一律失败，判定必须看 body；金额为元（数字），两位小数展示。
//   cash_balance 可为负（欠费）——负值由面板红字呈现（§v1.2 裁决③）；available_balance = 现金 + 代金券。

const CANDIDATES = [
	{ name: "国内站", url: "https://api.moonshot.cn/v1/users/me/balance", symbol: "¥" },
	{ name: "国际站", url: "https://api.moonshot.ai/v1/users/me/balance", symbol: "$" },
] as const;

function numberLike(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export interface MoonshotApiError {
	code: number | null;
	message: string | null;
}

/** 信封判定：code 存在且非 0、或 status 显式为 false 即失败。 */
export function parseApiError(payload: unknown): MoonshotApiError | null {
	if (!isRecord(payload)) return null;
	const code = typeof payload.code === "number" ? payload.code : null;
	if (code === null && payload.status !== false) return null;
	if ((code === null || code === 0) && payload.status !== false) return null;
	const message =
		typeof payload.message === "string"
			? payload.message
			: isRecord(payload.error) && typeof payload.error.message === "string"
				? payload.error.message
				: null;
	return { code, message };
}

export function parseBalancePayload(payload: unknown, symbol: string, now = Date.now()): QuotaSnapshot | undefined {
	if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
	const data = payload.data;
	const available = numberLike(data.available_balance);
	if (available === undefined) return undefined;
	const extras: QuotaExtra[] = [];
	const cash = numberLike(data.cash_balance);
	const voucher = numberLike(data.voucher_balance);
	if (cash !== undefined) extras.push({ label: "现金余额", value: withCurrencySymbol(symbol, toAmountText(cash)) });
	if (voucher !== undefined) {
		extras.push({ label: "代金券余额", value: withCurrencySymbol(symbol, toAmountText(voucher)) });
	}
	return { coreBalance: withCurrencySymbol(symbol, toAmountText(available)), windows: [], extras, capturedAt: now };
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
		return { failure: `${detail}（${apiError.code !== null ? `code ${apiError.code}；` : ""}凭证或区域不匹配均可能）` };
	}
	if (response.status >= 400) return { failure: `HTTP ${response.status}：${snippet(raw)}` };
	const snapshot = parseBalancePayload(payload, entry.symbol);
	if (!snapshot) {
		console.warn(`[ai-codingplan-check] Moonshot ${entry.name}原始响应：`, raw);
		return { failure: `响应无法解析为已知余额结构：${snippet(raw)}` };
	}
	return { value: snapshot };
}

export const moonshotAdapter: ProviderAdapter = {
	id: "moonshot",
	label: "Moonshot 平台",
	credentialHint: "Moonshot 开放平台 API Key（sk-…，与推理用同一把；不是 Kimi For Coding 的 sk-kimi-…）",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const snapshot = await firstSuccessful(
			"Moonshot 余额查询失败",
			CANDIDATES.map((entry) => ({ name: entry.name, run: () => fetchFrom(entry, secret) })),
		);
		return [snapshot];
	},
};
