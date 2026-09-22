import { requestUrl } from "obsidian";
import { formatPercent } from "../format";
import { firstSuccessful, jsonOf, snippet, type AttemptResult } from "./request";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot, QuotaWindow } from "../types";

// 智谱 GLM Coding Plan 额度接口契约（来源：官方插件 zai-org/zai-coding-plugins 的
// glm-plan-usage 技能脚本 query-usage.mjs，2026-09 逐行核对；窗口口径见官方文档
// docs.bigmodel.cn/cn/coding-plan/overview）：
//   GET {base}/api/monitor/usage/quota/limit
//     Authorization: <token>          ← 裸 Token，官方不加 Bearer
//     content-type: application/json; accept-language: en-US,en
//   base：国内 https://open.bigmodel.cn、国际 https://api.z.ai（同族后端，按套餐归属站点选；
//         同族接口另有 /api/monitor/usage/model-usage 与 /tool-usage，本适配器不用）
//   200 → { success, code, msg, data: { level: "lite"|"pro"|"max"|…,
//           limits: [{ type: "TOKENS_LIMIT"|"CREDIT_LIMIT"|"TIME_LIMIT",
//                      percentage: 0-100(已用份额), nextResetTime,
//                      unit: 3=小时 4=天 5=月 6=周, number, usage/currentValue/remaining }] } }
// 认证失败也走 body：2026-09-23 无凭证探测两市均返回 HTTP 200 +
// { code: 1001, msg: "Authentication parameter not received in Header…", success: false }，
// 凭证无效时为 { code: 401, msg: "token expired or incorrect" }（社区实测口径），
// 因此错误判定必须看 body，不能只看状态码。
// 未实测（真 Key 首轮核对项）：nextResetTime 的绝对时间（官方脚本未读该字段，社区实现按 epoch ms）；
// 新旧套餐 limits 条目数差异（老套餐 TOKENS_LIMIT 只回 5 小时一条，官方脚本同口径）。

const DOMAINS = [
	{ name: "国内站", base: "https://open.bigmodel.cn" },
	{ name: "国际站", base: "https://api.z.ai" },
] as const;

const QUOTA_PATH = "/api/monitor/usage/quota/limit";

/** MCP 工具额度另属一账：只做附加信息，不占窗口（否则行总用量会被它顶替）。 */
const MCP_TYPE = "TIME_LIMIT";
const MCP_EXTRA_LABEL = "MCP 月用量";

// unit 取值（社区实测口径）：3=小时 4=天 5=月 6=周；number 为窗口个数。
const UNIT_HOUR = 3;
const UNIT_DAY = 4;
const UNIT_MONTH = 5;
const UNIT_WEEK = 6;

const LEVEL_NAMES: Record<string, string> = { lite: "Lite", pro: "Pro", max: "Max", standard: "Standard" };

/** 无 unit 时的类型兜底：老套餐只回 TOKENS_LIMIT 一条（官方脚本标为 5 小时）。 */
const TYPE_FALLBACK: Record<string, { key: string; label: string }> = {
	TOKENS_LIMIT: { key: "fiveHour", label: "近5小时" },
	CREDIT_LIMIT: { key: "credit", label: "本期" },
};

export interface GlmApiError {
	code: string | number | null;
	message: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	return undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

/** 兼容 epoch 毫秒、epoch 秒与 ISO-8601；输出 epoch ms，未知为 null。 */
function toEpochMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value >= 1e12 ? value : value * 1000;
	}
	if (typeof value === "string" && value.trim()) {
		const trimmed = value.trim();
		const parsed = /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
		return Number.isFinite(parsed) && parsed > 0 ? (parsed >= 1e12 ? parsed : parsed * 1000) : null;
	}
	return null;
}

/** 由 unit+number 判定窗口；无法判定返回 undefined。 */
function shapeFromUnit(unit: number | undefined, count: number | undefined): { key: string; label: string } | undefined {
	if (unit === undefined) return undefined;
	const n = count ?? 1;
	if (unit === UNIT_HOUR) return n === 5 ? { key: "fiveHour", label: "近5小时" } : { key: `hour${n}`, label: `近${n}小时` };
	if (unit === UNIT_DAY) return n === 1 ? { key: "daily", label: "近一天" } : { key: `day${n}`, label: `近${n}天` };
	if (unit === UNIT_WEEK) return n === 1 ? { key: "weekly", label: "近一周" } : { key: `week${n}`, label: `近${n}周` };
	if (unit === UNIT_MONTH) return n === 1 ? { key: "monthly", label: "近一月" } : { key: `month${n}`, label: `近${n}月` };
	return undefined;
}

function planNameFromLevel(level: unknown): string | undefined {
	if (typeof level !== "string" || !level.trim()) return undefined;
	const raw = level.trim();
	return `GLM Coding Plan ${LEVEL_NAMES[raw.toLowerCase()] ?? raw}`;
}

/** body 层错误（认证失败等也走 200 + code，故必须看 body）。 */
export function parseApiError(payload: unknown): GlmApiError | null {
	if (!isRecord(payload)) return null;
	const rawCode = payload.code;
	const code =
		typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : null;
	const message =
		typeof payload.msg === "string" ? payload.msg : typeof payload.message === "string" ? payload.message : null;
	if (payload.success === false) return { code, message };
	if (code !== null && String(code) !== "200" && String(code) !== "0") return { code, message };
	return null;
}

/** 解析 quota/limit 响应；无任何可用窗口返回 undefined，由调用方报"无法识别"。
 *  同 key 条目重复时保留先出现的一条（迭代序即服务端返回序，不猜优先级）。 */
export function parseQuotaLimit(payload: unknown, now = Date.now()): QuotaSnapshot | undefined {
	if (!isRecord(payload)) return undefined;
	const data = isRecord(payload.data) ? payload.data : undefined;
	if (!data || !Array.isArray(data.limits)) return undefined;
	const windows: QuotaWindow[] = [];
	const extras: QuotaExtra[] = [];
	const seen = new Set<string>();
	for (const entry of data.limits as unknown[]) {
		if (!isRecord(entry)) continue;
		const percentage = toFiniteNumber(entry.percentage);
		if (percentage === undefined) continue;
		const type = typeof entry.type === "string" ? entry.type.toUpperCase() : "";
		const usedPercent = clampPercent(percentage);
		if (type === MCP_TYPE) {
			if (!extras.some((extra) => extra.label === MCP_EXTRA_LABEL)) {
				extras.push({ label: MCP_EXTRA_LABEL, value: `${formatPercent(usedPercent)}%` });
			}
			continue;
		}
		const shape = shapeFromUnit(toFiniteNumber(entry.unit), toFiniteNumber(entry.number)) ?? TYPE_FALLBACK[type];
		if (!shape || seen.has(shape.key)) continue;
		seen.add(shape.key);
		windows.push({
			key: shape.key,
			label: shape.label,
			usedPercent,
			resetsAt: toEpochMs(entry.nextResetTime),
			rateLimited: usedPercent >= 100,
		});
	}
	if (windows.length === 0) return undefined;
	return { planName: planNameFromLevel(data.level), windows, extras, capturedAt: now };
}

type Attempt = AttemptResult<QuotaSnapshot>;

/** 单站点查询：站点名只用于失败描述。国内站优先，失败再试国际站（两边同一份凭证语义）。 */
async function fetchFrom(domain: (typeof DOMAINS)[number], secret: string): Promise<Attempt> {
	let response;
	try {
		// throw:false：4xx/5xx 也要拿到响应体，错误里带状态码与片段，别让宿主抛笼统错误。
		response = await requestUrl({
			url: `${domain.base}${QUOTA_PATH}`,
			method: "GET",
			headers: {
				authorization: secret,
				"content-type": "application/json",
				"accept-language": "en-US,en",
			},
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
		return { failure: apiError.code === null ? detail : `${detail}（code ${apiError.code}）` };
	}
	if (response.status >= 400) return { failure: `HTTP ${response.status}：${snippet(raw)}` };
	const snapshot = parseQuotaLimit(payload);
	if (!snapshot) {
		console.warn(`[ai-codingplan-check] 智谱 GLM ${domain.name}原始响应：`, raw);
		return { failure: `响应无可用的额度窗口（该凭证可能没有 Coding Plan 订阅）：${snippet(raw)}` };
	}
	return { value: snapshot };
}

export const glmAdapter: ProviderAdapter = {
	id: "glm",
	label: "智谱 GLM",
	credentialLabel: "API Key",
	credentialHint: "GLM Coding Plan 的 API Key（bigmodel 国内 / z.ai 国际均可）",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		// 国内站优先，失败再试国际站：两边是同一份凭证语义，用户不需要知道自己该用哪个站。
		const snapshot = await firstSuccessful(
			"智谱额度查询失败",
			DOMAINS.map((domain) => ({ name: domain.name, run: () => fetchFrom(domain, secret) })),
		);
		return [snapshot];
	},
};
