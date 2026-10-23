import { requestUrl } from "obsidian";
import { jsonOf } from "./request";
import { isRecord, snippet } from "./shared";
import { toAmountText, withCurrencySymbol } from "../format";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot } from "../types";

// DeepSeek 按量余额接口契约（官方 API 文档 api-docs.deepseek.com/api/get-user-balance，2026-09 核对；
// 无凭证探测实证：坏 Key 返回 HTTP 401 + {"error":{"type":"authentication_error"...}}，路由存活）：
//   GET https://api.deepseek.com/user/balance
//     Authorization: Bearer <API Key（与推理同一把）>
//   200 → { is_available: boolean, balance_infos: [{ currency: "CNY" | "USD" | …,
//           total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] }
// 金额官方即两位小数字符串；多币种分账（CNY / USD 各一条，都展示）。
// is_available = 余额是否足以调用（false 时再调返回 402）：§v1.2 审核裁决④默认不展示该状态，
// 此处留档——启用时在 extras 加一行条件文案即可。

const USAGE_URL = "https://api.deepseek.com/user/balance";

/** 已知币种的显示符号；未收录币种退回「金额 + 代码」后缀形态。 */
const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€" };
/** 其余币种余额的 extras 键名（中文币种名；未收录退回代码本身）。 */
const CURRENCY_NAMES: Record<string, string> = { CNY: "人民币", USD: "美元", EUR: "欧元" };

function textOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface BalanceEntry {
	currency: string;
	total: string;
	granted?: string;
	toppedUp?: string;
}

/** 解析 balance_infos；金额字符串经 toAmountText 规整两位小数。 */
export function parseBalanceInfos(payload: unknown): BalanceEntry[] | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.balance_infos)) return undefined;
	const entries: BalanceEntry[] = [];
	for (const row of payload.balance_infos) {
		if (!isRecord(row)) continue;
		const currency = textOf(row.currency);
		const total = textOf(row.total_balance);
		if (!currency || total === undefined) continue;
		const granted = textOf(row.granted_balance);
		const toppedUp = textOf(row.topped_up_balance);
		entries.push({
			currency,
			total: toAmountText(total),
			granted: granted !== undefined ? toAmountText(granted) : undefined,
			toppedUp: toppedUp !== undefined ? toAmountText(toppedUp) : undefined,
		});
	}
	return entries.length > 0 ? entries : undefined;
}

/** 主币种：CNY 优先（国内主币种），无 CNY 取响应首个（§v1.2 裁决①）。 */
export function pickPrimary(entries: BalanceEntry[]): BalanceEntry {
	return entries.find((entry) => entry.currency === "CNY") ?? entries[0];
}

function amountText(currency: string, amount: string): string {
	const symbol = CURRENCY_SYMBOLS[currency];
	return symbol ? withCurrencySymbol(symbol, amount) : `${amount} ${currency}`;
}

/** 解析余额响应为快照：coreBalance = 主币种总额，extras = 主币种赠送/充值拆分 + 其余币种余额（信息不丢）。 */
export function parseBalancePayload(payload: unknown, now = Date.now()): QuotaSnapshot | undefined {
	const entries = parseBalanceInfos(payload);
	if (!entries) return undefined;
	const primary = pickPrimary(entries);
	const extras: QuotaExtra[] = [];
	if (primary.granted !== undefined) extras.push({ label: "赠送余额", value: amountText(primary.currency, primary.granted) });
	if (primary.toppedUp !== undefined) {
		extras.push({ label: "充值余额", value: amountText(primary.currency, primary.toppedUp) });
	}
	for (const entry of entries) {
		if (entry === primary) continue;
		const name = CURRENCY_NAMES[entry.currency] ?? entry.currency;
		extras.push({ label: `${name}余额`, value: amountText(entry.currency, entry.total) });
	}
	return { coreBalance: amountText(primary.currency, primary.total), windows: [], extras, capturedAt: now };
}

export const deepSeekAdapter: ProviderAdapter = {
	id: "deepseek",
	label: "DeepSeek",
	credentialHint: "DeepSeek 开放平台 API Key（sk-…，与推理用同一把）",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		// throw:false：401 等也要拿到响应体，错误里带状态码与片段，别让宿主抛笼统错误。
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
		const snapshot = parseBalancePayload(jsonOf(response));
		if (!snapshot) {
			console.warn("[ai-codingplan-check] DeepSeek 原始响应：", raw);
			throw new Error(`HTTP ${response.status} 响应无法解析为已知余额结构：${snippet(raw)}`);
		}
		return [snapshot];
	},
};
