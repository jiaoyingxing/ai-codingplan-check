import { requestUrl } from "obsidian";
import { firstSuccessful, jsonOf, snippet, type AttemptResult } from "./request";
import type { ProviderAdapter, QuotaSnapshot, QuotaWindow } from "../types";

// Kimi For Coding（上游现名 Kimi Code）额度接口契约（来源：官方仓库 MoonshotAI/kimi-code 的
// packages/oauth/src/managed-usage.ts + 官方 issue 里的实测响应，2026-09 核对；端点未进官方 API 文档）：
//   GET {base}/usages，Authorization: Bearer <Kimi Code 控制台创建的 API Key：sk-kimi-…>
//   base：中国 https://api.kimi.com/coding/v1、国际 https://api.kimi.ai/coding/v1（2026-09 上游拆区，
//        同一把 Key 只对其归属区生效，故按序尝试）
//   两代 payload 并存，本适配器都读：
//   ① legacy（响应里字段级实证）：usage{ limit, used, remaining, resetTime } = **周窗**，数值为 0-100
//      百分比且以字符串返回；limits[]{ window{ duration, timeUnit }, detail{ limit, used, remaining, resetTime } }
//      覆盖 5 小时等窗口，窗口长度 = duration × timeUnit（MINUTE/HOUR/DAY/WEEK，WEEK 可无 duration）。
//   ② quota 模型（2026-09-15 起官方切流）：usages{ limit_5h, limit_7d, … } 每项 { used_ratio(0-1 已用),
//      reset_time(ISO) }。**已知线上失真**：用量耗尽时 used_ratio 仍可能为 0（official issue 实证），
//      故只作补充：同窗口取两者中已用更大的一侧，绝不覆盖 legacy 的真实值。
//   月池（limit_month_total / limit_month_code）语义与口径未定，暂不展示。
// 认证失败：HTTP 401 + { error: { message, type: "invalid_authentication_error" } }（2026-09-23 探测实证）。

const BASES = [
	{ name: "中国站", base: "https://api.kimi.com/coding/v1" },
	{ name: "国际站", base: "https://api.kimi.ai/coding/v1" },
] as const;

const USAGES_PATH = "/usages";

/** window.timeUnit → 每单位分钟数（TIME_UNIT_WEEK 无 duration 时的兜底也走这张表）。 */
const UNIT_MINUTES: Record<string, number> = {
	TIME_UNIT_MINUTE: 1,
	TIME_UNIT_HOUR: 60,
	TIME_UNIT_DAY: 1440,
	TIME_UNIT_WEEK: 10080,
};

export interface KimiApiError {
	message: string | null;
	type: string | null;
}

interface Candidate {
	key: string;
	label: string;
	/** 窗口长度（分钟），用于由短到长排序。 */
	minutes: number;
	usedPercent: number;
	resetsAt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 数值字段线上同时存在 number 与字符串两种形态（"100"）。 */
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

/** ISO-8601（可带微秒）/ epoch 秒 / epoch 毫秒 → epoch ms。
 *  微秒小数先截到 3 位：iOS 的 JavaScriptCore 对 6 位小数不一定宽容。 */
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

/** detail{ limit, used, remaining } → 已用百分比；limit 缺省视为不可判定。 */
function usedPercentOf(detail: unknown): number | undefined {
	if (!isRecord(detail)) return undefined;
	const limit = numberLike(detail.limit);
	if (limit === undefined || limit <= 0) return undefined;
	const used = numberLike(detail.used);
	if (used !== undefined) return clampPercent((used / limit) * 100);
	const remaining = numberLike(detail.remaining);
	if (remaining !== undefined) return clampPercent(((limit - remaining) / limit) * 100);
	return undefined;
}

function resetOf(detail: unknown): number | null {
	return isRecord(detail) ? toEpochMs(detail.resetTime) : null;
}

/** window{ duration, timeUnit } → 窗口长度（分钟）。 */
function windowMinutes(raw: unknown): number | undefined {
	if (!isRecord(raw)) return undefined;
	const unit = typeof raw.timeUnit === "string" ? UNIT_MINUTES[raw.timeUnit] : undefined;
	if (unit === undefined) return undefined;
	const duration = numberLike(raw.duration);
	if (duration === undefined || duration <= 0) return unit === UNIT_MINUTES.TIME_UNIT_WEEK ? unit : undefined;
	return duration * unit;
}

function shapeFromMinutes(minutes: number): { key: string; label: string } {
	if (minutes === 300) return { key: "fiveHour", label: "近5小时" };
	if (minutes === 1440) return { key: "daily", label: "近一天" };
	if (minutes === 10080) return { key: "weekly", label: "近一周" };
	if (minutes % 1440 === 0) return { key: `day${minutes / 1440}`, label: `近${minutes / 1440}天` };
	if (minutes % 60 === 0) return { key: `hour${minutes / 60}`, label: `近${minutes / 60}小时` };
	return { key: `minute${minutes}`, label: `近${minutes}分钟` };
}

/** 同窗口出现多份数据（legacy 与 quota 模型、或多分组）：已用取更大值，重置时间取先到的非空值。 */
function mergeCandidate(list: Candidate[], next: Candidate): void {
	const existing = list.find((item) => item.key === next.key);
	if (!existing) {
		list.push(next);
		return;
	}
	existing.usedPercent = Math.max(existing.usedPercent, next.usedPercent);
	if (existing.resetsAt === null) existing.resetsAt = next.resetsAt;
}

export function parseApiError(payload: unknown): KimiApiError | null {
	if (!isRecord(payload) || !isRecord(payload.error)) return null;
	const message = typeof payload.error.message === "string" ? payload.error.message : null;
	const type = typeof payload.error.type === "string" ? payload.error.type : null;
	if (message === null && type === null) return null;
	return { message, type };
}

/** 解析 usages 响应；无任何可用窗口返回 undefined，由调用方报"无法识别"。 */
export function parseUsagesPayload(payload: unknown, now = Date.now()): QuotaSnapshot | undefined {
	if (!isRecord(payload)) return undefined;
	const candidates: Candidate[] = [];
	// legacy ①：顶层 usage = 周窗
	const weeklyUsed = usedPercentOf(payload.usage);
	if (weeklyUsed !== undefined) {
		mergeCandidate(candidates, {
			key: "weekly",
			label: "近一周",
			minutes: 10080,
			usedPercent: weeklyUsed,
			resetsAt: resetOf(payload.usage),
		});
	}
	// legacy ②：limits[] 覆盖其余窗口
	if (Array.isArray(payload.limits)) {
		for (const entry of payload.limits as unknown[]) {
			if (!isRecord(entry)) continue;
			const minutes = windowMinutes(entry.window);
			const usedPercent = usedPercentOf(entry.detail);
			if (minutes === undefined || usedPercent === undefined) continue;
			const shape = shapeFromMinutes(minutes);
			mergeCandidate(candidates, { ...shape, minutes, usedPercent, resetsAt: resetOf(entry.detail) });
		}
	}
	// quota 模型：usages.limit_5h / limit_7d（只作补充，见文件头说明）
	if (isRecord(payload.usages)) {
		const quotaWindows: [string, string, number, string][] = [
			["limit_5h", "fiveHour", 300, "近5小时"],
			["limit_7d", "weekly", 10080, "近一周"],
		];
		for (const [field, key, minutes, label] of quotaWindows) {
			const entry = payload.usages[field];
			if (!isRecord(entry)) continue;
			const ratio = numberLike(entry.used_ratio);
			if (ratio === undefined) continue;
			mergeCandidate(candidates, {
				key,
				label,
				minutes,
				usedPercent: clampPercent(ratio * 100),
				resetsAt: toEpochMs(entry.reset_time),
			});
		}
	}
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => a.minutes - b.minutes);
	const windows: QuotaWindow[] = candidates.map((item) => ({
		key: item.key,
		label: item.label,
		usedPercent: item.usedPercent,
		resetsAt: item.resetsAt,
		rateLimited: item.usedPercent >= 100,
	}));
	return { windows, extras: [], capturedAt: now };
}

/** 单站点查询：站点名只用于失败描述（Key 只对其归属区生效）。 */
async function fetchFrom(entry: (typeof BASES)[number], secret: string): Promise<AttemptResult<QuotaSnapshot>> {
	let response;
	try {
		// throw:false：4xx 也要拿到响应体，错误里带状态码与片段。
		response = await requestUrl({
			url: `${entry.base}${USAGES_PATH}`,
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
		return { failure: apiError.type === null ? detail : `${detail}（${apiError.type}）` };
	}
	if (response.status >= 400) return { failure: `HTTP ${response.status}：${snippet(raw)}` };
	const snapshot = parseUsagesPayload(payload);
	if (!snapshot) {
		console.warn(`[ai-codingplan-check] Kimi For Coding ${entry.name}原始响应：`, raw);
		return { failure: `响应无可用的额度窗口（该凭证可能不是 Kimi Code 订阅 Key）：${snippet(raw)}` };
	}
	return { value: snapshot };
}

export const kimiAdapter: ProviderAdapter = {
	id: "kimi-for-coding",
	label: "Kimi For Coding",
	credentialLabel: "API Key",
	credentialHint: "Kimi Code 控制台创建的 API Key（sk-kimi-…；中国站 / 国际站均可）",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const snapshot = await firstSuccessful(
			"Kimi 额度查询失败",
			BASES.map((entry) => ({ name: entry.name, run: () => fetchFrom(entry, secret) })),
		);
		return [snapshot];
	},
};
