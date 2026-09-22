import { requestUrl } from "obsidian";
import { firstSuccessful, jsonOf, snippet, type AttemptResult } from "./request";
import type { ProviderAdapter, QuotaSnapshot, QuotaWindow } from "../types";

// MiniMax Token Plan（编程套餐）额度接口契约（来源：官方 FAQ 的 curl 示例 + 官方仓库 issue 与
// 多个社区实现的实测响应，2026-09 核对；**官方未给字段表**，字段语义只有社区实证）：
//   GET {host}/v1/token_plan/remains（现行路径，官方 FAQ 写法）
//     Authorization: Bearer <Subscription Key：sk-cp-…（与按量付费 API Key 不通用）>
//   旧路径 {host}/v1/api/openplatform/coding_plan/remains 仍在服务；区域靠 host 区分：
//     中国 www.minimax.cn、国际 www.minimax.io（官方文档）；社区另有 api.minimaxi.com / api.minimax.io。
//   ⚠ base_resp.status_code 非 0 一律是 auth 类失败：1004 + "cookie is missing, log in again" 的
//     实测语义是**凭证被拒或区域不匹配**（官方 issue：同一把中国区 Key 在 api.minimax.io 得 1004、
//     在 api.minimaxi.com 得真实数据），不能读成"必须带 cookie"，也不要提示"key 无效"。
//   字段语义（多实现一致 + 官方 issue 确认）：model_remains[].current_interval_usage_count 与
//     current_weekly_usage_count 名字像"已用"，**实际是剩余**；新响应另给
//     current_interval_remaining_percent / current_weekly_remaining_percent（更可靠：count 全 0 时仍有效）。
//     已用 = 100 − remaining_percent；缺该字段时才用 (total − usage_count) / total。
//     *_status == 3 = 该账号没有这条窗口（跳过，不画 0%）。
//   时间：end_time / weekly_end_time 为 epoch 毫秒；boost_permille（加购倍率）语义未定，暂不参与换算。

const CANDIDATES = [
	{ name: "中国站", url: "https://www.minimax.cn/v1/token_plan/remains" },
	{ name: "中国站·旧路径", url: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains" },
	{ name: "国际站", url: "https://www.minimax.io/v1/token_plan/remains" },
	{ name: "国际站·旧路径", url: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains" },
] as const;

/** current_*_status == 3 = 该账号没有这条窗口。 */
const NO_WINDOW_STATUS = 3;

export interface MiniMaxApiError {
	code: number | null;
	message: string | null;
}

interface WindowFields {
	/** 字段名后缀组：count 侧名字有误导性，见文件头。 */
	total: string;
	usage: string;
	remainingPercent: string;
	endTime: string;
	status: string;
}

const INTERVAL_FIELDS: WindowFields = {
	total: "current_interval_total_count",
	usage: "current_interval_usage_count",
	remainingPercent: "current_interval_remaining_percent",
	endTime: "end_time",
	status: "current_interval_status",
};

const WEEKLY_FIELDS: WindowFields = {
	total: "current_weekly_total_count",
	usage: "current_weekly_usage_count",
	remainingPercent: "current_weekly_remaining_percent",
	endTime: "weekly_end_time",
	status: "current_weekly_status",
};

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

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

/** epoch 毫秒 / 秒 / ISO-8601 → epoch ms。 */
function toEpochMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value >= 1e12 ? value : value * 1000;
	}
	if (typeof value === "string" && value.trim()) {
		const normalized = value.trim().replace(/(\.\d{3})\d+/, "$1");
		const parsed = /^-?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : Date.parse(normalized);
		if (!Number.isFinite(parsed) || parsed <= 0) return null;
		return parsed >= 1e12 ? parsed : parsed * 1000;
	}
	return null;
}

export function parseApiError(payload: unknown): MiniMaxApiError | null {
	if (!isRecord(payload) || !isRecord(payload.base_resp)) return null;
	const code = numberLike(payload.base_resp.status_code);
	const message = typeof payload.base_resp.status_msg === "string" ? payload.base_resp.status_msg : null;
	if (code === undefined || code === 0) return null;
	return { code, message };
}

function windowOf(key: string, label: string, row: Record<string, unknown>, fields: WindowFields): QuotaWindow | undefined {
	if (numberLike(row[fields.status]) === NO_WINDOW_STATUS) return undefined;
	const remainingPercent = numberLike(row[fields.remainingPercent]);
	let usedPercent: number | undefined;
	if (remainingPercent !== undefined) {
		usedPercent = clampPercent(100 - remainingPercent);
	} else {
		const total = numberLike(row[fields.total]);
		const usageCount = numberLike(row[fields.usage]);
		if (total !== undefined && usageCount !== undefined && total > 0) {
			usedPercent = clampPercent(((total - usageCount) / total) * 100);
		}
	}
	if (usedPercent === undefined) return undefined;
	return {
		key,
		label,
		usedPercent,
		resetsAt: toEpochMs(row[fields.endTime]),
		rateLimited: usedPercent >= 100,
	};
}

/** 套餐名（订阅标题）；官方无字段表，取不到就不显示。 */
function planTitleOf(payload: Record<string, unknown>): string | undefined {
	const title = payload.current_subscribe_title;
	return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

/** 解析 remains 响应；model_remains 里取第一条能出窗口的记录（多模型分组时以首条为准，未实测多分组口径）。 */
export function parseRemainsPayload(payload: unknown, now = Date.now()): QuotaSnapshot | undefined {
	if (!isRecord(payload)) return undefined;
	const rows = Array.isArray(payload.model_remains) ? (payload.model_remains as unknown[]) : null;
	if (!rows) return undefined;
	for (const row of rows) {
		if (!isRecord(row)) continue;
		const windows = [
			windowOf("fiveHour", "近5小时", row, INTERVAL_FIELDS),
			windowOf("weekly", "近一周", row, WEEKLY_FIELDS),
		].filter((window): window is QuotaWindow => window !== undefined);
		if (windows.length === 0) continue;
		return { planName: planTitleOf(payload), windows, extras: [], capturedAt: now };
	}
	return undefined;
}

async function fetchFrom(entry: (typeof CANDIDATES)[number], secret: string): Promise<AttemptResult<QuotaSnapshot>> {
	let response;
	try {
		// throw:false：4xx/5xx 也要拿到响应体——该接口鉴权失败走 200 + base_resp。
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
		return { failure: `${detail}（code ${apiError.code}；凭证或区域不匹配均可能）` };
	}
	if (response.status >= 400) return { failure: `HTTP ${response.status}：${snippet(raw)}` };
	const snapshot = parseRemainsPayload(payload);
	if (!snapshot) {
		console.warn(`[ai-codingplan-check] MiniMax ${entry.name}原始响应：`, raw);
		return { failure: `响应无可用的额度窗口（该凭证可能不是 Token Plan 订阅 Key）：${snippet(raw)}` };
	}
	return { value: snapshot };
}

export const miniMaxAdapter: ProviderAdapter = {
	id: "minimax",
	label: "MiniMax",
	credentialLabel: "Subscription Key",
	credentialHint: "Token Plan 的 Subscription Key（sk-cp-…；中国站 / 国际站均可）",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const snapshot = await firstSuccessful(
			"MiniMax 额度查询失败",
			CANDIDATES.map((entry) => ({ name: entry.name, run: () => fetchFrom(entry, secret) })),
		);
		return [snapshot];
	},
};
