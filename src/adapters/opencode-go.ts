import { requestUrl } from "obsidian";
import type { ProviderAdapter, QuotaSnapshot, QuotaWindow } from "../types";

// OpenCode Go 用量接口契约（来源：monotykamary/pi-opencode-go-provider usage.ts，2026-09 核对）：
// GET https://opencode.ai/zen/go/v1/usage
//   accept: application/json
//   authorization: Bearer <api-key>
// 200 → { usage: { rolling | weekly | monthly: { status: "ok"|"rate-limited",
//         percent: 0-100(已用份额), resetsAt: ISO-8601 | epoch 秒/毫秒 },
//         bankedResets?: int } }
// percent 为服务端已计算的已用份额（限速窗口强制 100）；美元额度上限不在响应里。

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;
const WINDOW_LABELS: Record<(typeof WINDOW_KEYS)[number], string> = {
	rolling: "近5小时",
	weekly: "近一周",
	monthly: "近一月",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	return undefined;
}

/** 兼容 ISO-8601 字符串、epoch 秒、epoch 毫秒。 */
export function parseResetAt(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === "string" && value.trim()) {
		const trimmed = value.trim();
		if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return parseResetAt(Number(trimmed));
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function parseWindow(key: (typeof WINDOW_KEYS)[number], raw: unknown): QuotaWindow | undefined {
	if (!isRecord(raw)) return undefined;
	const percent = toFiniteNumber(raw.percent);
	if (percent === undefined) return undefined;
	const rateLimited = raw.status === "rate-limited";
	return {
		key,
		label: WINDOW_LABELS[key],
		usedPercent: clampPercent(rateLimited ? 100 : percent),
		resetsAt: parseResetAt(raw.resetsAt),
		rateLimited,
	};
}

/** 解析 usage 响应；无任何可用窗口时返回 undefined，由调用方报"无法识别"。 */
export function parseUsagePayload(payload: unknown, now = Date.now()): QuotaSnapshot | undefined {
	if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
	const usage = payload.usage;
	const windows: QuotaWindow[] = [];
	for (const key of WINDOW_KEYS) {
		const window = parseWindow(key, usage[key]);
		if (window) windows.push(window);
	}
	if (windows.length === 0) return undefined;
	return { windows, extras: [], capturedAt: now };
}

export const opencodeGoAdapter: ProviderAdapter = {
	id: "opencode-go",
	label: "OpenCode Go",
	credentialLabel: "API Key",
	credentialHint: "opencode.ai Go 计划的 API Key",
	async fetchQuota(secret: string): Promise<QuotaSnapshot> {
		// throw:false：4xx/5xx 也要拿到响应体，错误里带状态码与片段，别让宿主抛笼统错误。
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
		const snapshot = parseUsagePayload(response.json);
		if (!snapshot) {
			console.warn("[ai-codingplan-check] OpenCode Go 原始响应：", raw);
			throw new Error(`HTTP ${response.status} 响应无法解析为已知用量结构：${snippet(raw)}`);
		}
		return snapshot;
	},
};

function snippet(raw: string): string {
	return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}
