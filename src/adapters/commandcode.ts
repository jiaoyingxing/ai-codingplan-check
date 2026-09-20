import { requestUrl } from "obsidian";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot, QuotaWindow } from "../types";

// Command Code 额度接口契约（来源：patlux/pi-commandcode-provider src/quota.ts，2026-09 核对）：
// 基址 https://api.commandcode.ai，headers accept: application/json + Authorization: Bearer <key>
//   GET /alpha/whoami                          → {org?:{login,id}, user?:{userName|name,...}}（阻塞：401/403 即失败）
//   GET /alpha/billing/credits?orgId=          → {credits:{monthlyCredits,purchasedCredits,freeCredits},
//                                                 windowLimits:{fiveHour|weekly:{used,cap,resetAt}}}（单位 credits≈美元面额）
//   GET /alpha/billing/subscriptions?orgId=    → {data:{planId,status,currentPeriodStart,currentPeriodEnd}}
//   GET /alpha/usage/summary?orgId=&since=     → {totalCost,totalCount,totalTokens?}
// 除 whoami 与 401/403 外，各段失败互不阻塞；窗口仅 5 小时与每周两条（无月窗口）。

const API_BASE = "https://api.commandcode.ai";

export interface CommandCodeAccount {
	login: string;
	orgId: string | null;
}

export interface CommandCodeCredits {
	/** 月度套餐额度（credits，美元面额）；本期窗口的 cap。 */
	monthly: number;
	remaining: number;
	windows: QuotaWindow[];
}

export interface CommandCodeSubscription {
	planId: string | null;
	periodStartMs: number | null;
	periodEndMs: number | null;
}

export interface CommandCodeSummary {
	totalCost: number | null;
	totalCount: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 兼容 ISO-8601 字符串、epoch 秒、epoch 毫秒；输出 epoch ms。 */
function toEpochMs(value: unknown): number | null {
	let timestamp: number | undefined;
	if (typeof value === "number" && Number.isFinite(value)) timestamp = value;
	else if (typeof value === "string" && value.trim()) {
		const trimmed = value.trim();
		timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
	}
	if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp < 0) return null;
	return timestamp >= 1e12 ? timestamp : timestamp * 1000;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

export function parseWhoamiAccount(payload: unknown): CommandCodeAccount | null {
	if (!isRecord(payload)) return null;
	const org = isRecord(payload.org) ? payload.org : undefined;
	const user = isRecord(payload.user) ? payload.user : undefined;
	const login =
		(org ? stringValue(org.login) : undefined) ??
		(user ? (stringValue(user.userName) ?? stringValue(user.name)) : undefined);
	if (!login) return null;
	const orgId = org ? stringValue(org.id) : undefined;
	return { login, orgId: orgId ?? null };
}

function windowFromLimit(key: string, label: string, entry: unknown): QuotaWindow | null {
	if (!isRecord(entry)) return null;
	const used = numberValue(entry.used);
	const cap = numberValue(entry.cap);
	if (used === undefined || cap === undefined || (used === 0 && cap === 0)) return null;
	const usedPercent = cap > 0 ? clampPercent((used / cap) * 100) : 100;
	return {
		key,
		label,
		usedPercent,
		resetsAt: toEpochMs(entry.resetAt),
		rateLimited: usedPercent >= 100,
	};
}

export function parseCreditsInfo(payload: unknown): CommandCodeCredits | null {
	if (!isRecord(payload) || !isRecord(payload.credits)) return null;
	const credits = payload.credits;
	const monthly = numberValue(credits.monthlyCredits) ?? 0;
	const purchased = numberValue(credits.purchasedCredits) ?? 0;
	const free = numberValue(credits.freeCredits) ?? 0;
	const limits = isRecord(payload.windowLimits) ? payload.windowLimits : {};
	const windows = [
		windowFromLimit("fiveHour", "近5小时", limits.fiveHour),
		windowFromLimit("weekly", "近一周", limits.weekly),
	].filter((w): w is QuotaWindow => w !== null);
	if (monthly + purchased + free === 0 && windows.length === 0) return null;
	return { monthly: monthly, remaining: monthly + purchased + free, windows };
}

export function parseSubscriptionInfo(payload: unknown): CommandCodeSubscription | null {
	if (!isRecord(payload) || !isRecord(payload.data)) return null;
	const data = payload.data;
	const planId = stringValue(data.planId) ?? null;
	const currentPeriodStart = toEpochMs(data.currentPeriodStart);
	const currentPeriodEnd = toEpochMs(data.currentPeriodEnd);
	if (planId === null && currentPeriodStart === null && currentPeriodEnd === null) return null;
	return { planId, periodStartMs: currentPeriodStart, periodEndMs: currentPeriodEnd };
}

export function parseSummaryInfo(payload: unknown): CommandCodeSummary | null {
	if (!isRecord(payload)) return null;
	const totalCost = numberValue(payload.totalCost);
	const totalCount = numberValue(payload.totalCount);
	if (totalCost === undefined && totalCount === undefined) return null;
	return { totalCost: totalCost ?? null, totalCount: totalCount ?? null };
}

async function getJson(path: string, secret: string): Promise<{ status: number; json: unknown }> {
	// throw:false：4xx/5xx 也要拿到响应体，错误里带状态码与片段。
	const response = await requestUrl({
		url: `${API_BASE}${path}`,
		method: "GET",
		headers: { accept: "application/json", authorization: `Bearer ${secret}` },
		throw: false,
	});
	return { status: response.status, json: response.json };
}

async function getJsonSafe(path: string, secret: string): Promise<{ status: number; json: unknown } | null> {
	try {
		return await getJson(path, secret);
	} catch {
		return null; // 可选段：单段网络失败不阻塞整体
	}
}

function snippet(raw: string): string {
	return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

export const commandCodeAdapter: ProviderAdapter = {
	id: "commandcode",
	label: "Command Code",
	credentialLabel: "API Key",
	credentialHint: "commandcode.ai 的 API Key",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const whoami = await getJson("/alpha/whoami", secret);
		if (whoami.status === 401 || whoami.status === 403) {
			throw new Error(`HTTP ${whoami.status}：密钥被拒绝（${snippet(JSON.stringify(whoami.json ?? ""))}）`);
		}
		const account = parseWhoamiAccount(whoami.json);
		if (!account) {
			throw new Error(`HTTP ${whoami.status} 无法识别账号响应：${snippet(JSON.stringify(whoami.json ?? ""))}`);
		}
		const orgParam = account.orgId ? `?orgId=${encodeURIComponent(account.orgId)}` : "";

		const [creditsRes, subRes] = await Promise.all([
			getJsonSafe(`/alpha/billing/credits${orgParam}`, secret),
			getJsonSafe(`/alpha/billing/subscriptions${orgParam}`, secret),
		]);
		const credits =
			creditsRes && creditsRes.status < 400 ? parseCreditsInfo(creditsRes.json) : null;
		const subscription =
			subRes && subRes.status < 400 ? parseSubscriptionInfo(subRes.json) : null;

		const since = subscription?.periodStartMs
			? `${orgParam ? "&" : "?"}since=${new Date(subscription.periodStartMs).toISOString()}`
			: "";
		const summaryRes = await getJsonSafe(`/alpha/usage/summary${orgParam}${since}`, secret);
		const summary =
			summaryRes && summaryRes.status < 400 ? parseSummaryInfo(summaryRes.json) : null;

		const snapshot = composeQuotaSnapshot(credits, subscription, summary);
		if (!snapshot) throw new Error("无任何可用额度数据（余额/订阅/用量均不可得）");
		return [snapshot];
	},
};

/** 组装快照。CC 无原生月窗口：用 本期费用÷月度套餐额度 推导"本期"条，重置点=账单周期结束，
 *  与其他家三窗口对齐（真实数据自洽验证：70 − 69.90 = 0.10 余额）。 */
export function composeQuotaSnapshot(
	credits: CommandCodeCredits | null,
	subscription: CommandCodeSubscription | null,
	summary: CommandCodeSummary | null,
	now = Date.now(),
): QuotaSnapshot | null {
	if (!credits && !subscription && !summary) return null;
	const extras: QuotaExtra[] = [];
	if (credits) extras.push({ label: "余额", value: `$${credits.remaining.toFixed(2)}` });
	if (summary?.totalCost != null) extras.push({ label: "本期费用", value: `$${summary.totalCost.toFixed(2)}` });
	if (summary?.totalCount != null) extras.push({ label: "本期请求", value: `${summary.totalCount}` });
	if (subscription?.periodEndMs) {
		const days = Math.ceil((subscription.periodEndMs - now) / 86_400_000);
		if (days >= 0) extras.push({ label: "剩余天数", value: `${days} 天` });
	}
	const windows = credits ? [...credits.windows] : [];
	if (subscription && summary?.totalCost != null && credits && credits.monthly > 0) {
		const usedPercent = clampPercent((summary.totalCost / credits.monthly) * 100);
		windows.push({
			key: "monthly",
			label: "本期",
			usedPercent,
			resetsAt: subscription.periodEndMs,
			rateLimited: usedPercent >= 100,
		});
	}
	return {
		planName: subscription?.planId ?? undefined,
		windows,
		extras,
		capturedAt: now,
	};
}
