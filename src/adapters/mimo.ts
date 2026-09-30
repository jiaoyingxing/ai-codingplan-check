import { requestUrl } from "obsidian";
import { jsonOf, snippet } from "./request";
import { cookieHeaderValue, normalizeCookieHeader } from "./cookie";
import { toAmountText, withCurrencySymbol } from "../format";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot, QuotaWindow } from "../types";

// 小米 MiMo（Cookie）——platform.xiaomimimo.com 控制台会话链（D16 首批，2026-09-30 立项）：
// 无公开 API Key 的余额/套餐查询口，登录态 Cookie 是唯一来源（契约：api-balance-panel
// mimo / mimo-plan 适配器实测抓包 2026-09-09，多仓交叉印证，见 dev-log 20260930-153531）。
//   凭证 = 整条 Cookie 请求头（必需含 api-platform_serviceToken 与 userId；登录态权限大，勿外传）。
//   ① GET /api/v1/tokenPlan/detail → data.planName / currentPeriodEnd（ISO 字符串）/ planCode
//   ② GET /api/v1/tokenPlan/usage  → data.usage.items[]（used / limit 为原始 Credits 数，
//        取 limit>0 的首条；÷1e6 = M Credits 展示口径）
//   ③ GET /api/v1/balance          → data.balance / cashBalance / giftBalance / currency
//   三端点零 CSRF、共用同一份 Cookie；套餐与余额一张凭证出两类卡（§v1.2）。
// ⚠ 社区两仓踩过的坑：若读 percent 字段，它是 0-1 比例不是百分比——本实现不读 percent，
//   统一由 used/limit 计算。passToken 3 跳 302 自动续期在 requestUrl 下不可复刻（拿不到
//   中间跳的 Set-Cookie），会话失效（401/403）一律报重贴；serviceToken 寿命无定量数据，真号补。

const BASE = "https://platform.xiaomimimo.com";
const DETAIL_URL = `${BASE}/api/v1/tokenPlan/detail`;
const USAGE_URL = `${BASE}/api/v1/tokenPlan/usage`;
const BALANCE_URL = `${BASE}/api/v1/balance`;

const REQUIRED_COOKIE = "api-platform_serviceToken";
/** 原始 Credits → M Credits（百万 Credits，社区通用展示口径）。 */
const CREDITS_PER_M = 1e6;

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

/** ISO 字符串 / epoch 秒 / 毫秒 → epoch ms（currentPeriodEnd 实测为 ISO 字符串）。 */
function toEpochMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value >= 1e12 ? value : value * 1000;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value.trim());
		if (!Number.isFinite(parsed) || parsed <= 0) return null;
		return parsed >= 1e12 ? parsed : parsed * 1000;
	}
	return null;
}

function sessionExpired(detail: string): never {
	throw new Error(
		`小米 MiMo 登录 Cookie 已失效或不可用：${detail}；请重新从浏览器复制整条 Cookie 请求头（platform.xiaomimimo.com）`,
	);
}

export interface PlanDetail {
	planName?: string;
	periodEnd: number | null;
}

/** 解析套餐详情；无 planCode = 未开通套餐（返回 undefined，属正常而非错误）。 */
export function parsePlanDetail(payload: unknown): PlanDetail | undefined {
	if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
	const data = payload.data;
	if (typeof data.planCode !== "string" || !data.planCode.trim()) return undefined;
	const planName = typeof data.planName === "string" && data.planName.trim() ? data.planName.trim() : undefined;
	return { planName, periodEnd: toEpochMs(data.currentPeriodEnd) };
}

export interface PlanUsage {
	usedPercent: number;
	/** 原始 Credits 数（未除 1e6）。 */
	remainingCredits: number;
}

/** 解析套餐用量：取 limit>0 的首条（与参考实现一致），used/limit 计算已用百分比。 */
export function parsePlanUsage(payload: unknown): PlanUsage | undefined {
	if (
		!isRecord(payload) ||
		!isRecord(payload.data) ||
		!isRecord(payload.data.usage) ||
		!Array.isArray(payload.data.usage.items)
	) {
		return undefined;
	}
	for (const row of payload.data.usage.items) {
		if (!isRecord(row)) continue;
		const limit = numberLike(row.limit);
		if (limit === undefined || limit <= 0) continue;
		const used = numberLike(row.used) ?? 0;
		return {
			usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
			remainingCredits: Math.max(0, limit - used),
		};
	}
	return undefined;
}

export interface BalanceTexts {
	core: string;
	cash?: string;
	gift?: string;
}

/** 解析余额：core = balance（缺则现金+赠送求和兜底）；非 CNY 币种退「金额 + 代码」后缀形态。 */
export function parseBalance(payload: unknown): BalanceTexts | undefined {
	if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
	const data = payload.data;
	const currency = typeof data.currency === "string" && data.currency.trim() ? data.currency.trim() : "CNY";
	const fmt = (value: unknown): string | undefined => {
		const amount = numberLike(value);
		if (amount === undefined) return undefined;
		const text = toAmountText(amount);
		return currency === "CNY" ? withCurrencySymbol("¥", text) : `${text} ${currency}`;
	};
	let core = fmt(data.balance);
	if (core === undefined) {
		const cashN = numberLike(data.cashBalance);
		const giftN = numberLike(data.giftBalance);
		if (cashN !== undefined || giftN !== undefined) core = fmt((cashN ?? 0) + (giftN ?? 0));
	}
	if (core === undefined) return undefined;
	return { core, cash: fmt(data.cashBalance), gift: fmt(data.giftBalance) };
}

async function getJson(url: string, cookie: string): Promise<{ raw: string; payload: unknown }> {
	let response;
	try {
		// throw:false：401/403 也要拿到响应体——会话失效要给可解释文案，不是笼统报错。
		response = await requestUrl({ url, method: "GET", headers: { accept: "application/json", cookie }, throw: false });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`请求失败：${message}`);
	}
	const raw = response.text;
	if (response.status === 401 || response.status === 403) sessionExpired(`HTTP ${response.status}：${snippet(raw)}`);
	if (response.status >= 400) throw new Error(`HTTP ${response.status}：${snippet(raw)}`);
	return { raw, payload: jsonOf(response) };
}

export const mimoAdapter: ProviderAdapter = {
	id: "mimo",
	label: "小米 MiMo（Cookie）",
	credentialLabel: "会话 Cookie",
	credentialHint:
		"小米 MiMo 控制台登录态 Cookie：登录 platform.xiaomimimo.com 后，从 F12 Network 任意请求复制整条 Cookie 请求头（需含 api-platform_serviceToken 与 userId；非 API Key，权限更大，勿外传）。失效后重新复制",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const cookie = normalizeCookieHeader(secret);
		if (cookieHeaderValue(cookie, REQUIRED_COOKIE) === undefined) {
			throw new Error(
				`Cookie 里缺少 ${REQUIRED_COOKIE}（请登录 platform.xiaomimimo.com 后，从 F12 Network 任意请求复制整条 Cookie 请求头）`,
			);
		}

		const snapshots: QuotaSnapshot[] = [];

		// 套餐两跳：detail（名称/周期）→ usage（used/limit）。未开通套餐 = 正常跳过该卡；
		// 开通了但用量结构解析不出 = 平台改版，必须报错（失败要可解释，不静默少卡）。
		const detail = await getJson(DETAIL_URL, cookie);
		const detailParsed = parsePlanDetail(detail.payload);
		const usage = await getJson(USAGE_URL, cookie);
		const usageParsed = parsePlanUsage(usage.payload);
		if (detailParsed && usageParsed) {
			const extras: QuotaExtra[] = [
				{ label: "剩余额度", value: `${toAmountText(usageParsed.remainingCredits / CREDITS_PER_M)} M Credits` },
			];
			const window: QuotaWindow = {
				key: "plan",
				label: "套餐周期",
				usedPercent: usageParsed.usedPercent,
				resetsAt: detailParsed.periodEnd,
				rateLimited: usageParsed.usedPercent >= 100,
			};
			snapshots.push({ planName: detailParsed.planName, windows: [window], extras, capturedAt: Date.now() });
		} else if (detailParsed && !usageParsed) {
			throw new Error(`套餐用量响应无法解析（平台可能改版）：${snippet(usage.raw)}`);
		}

		// 余额：现金/赠送拆分进 extras（§v1.2），核心余额进行尾槽位。
		const balance = await getJson(BALANCE_URL, cookie);
		const balanceParsed = parseBalance(balance.payload);
		if (balanceParsed) {
			const extras: QuotaExtra[] = [];
			if (balanceParsed.cash !== undefined) extras.push({ label: "现金余额", value: balanceParsed.cash });
			if (balanceParsed.gift !== undefined) extras.push({ label: "赠送余额", value: balanceParsed.gift });
			snapshots.push({ coreBalance: balanceParsed.core, windows: [], extras, capturedAt: Date.now() });
		}

		if (snapshots.length === 0) {
			throw new Error(
				`未查到套餐用量或余额（账号可能未开通套餐）：${[detail.raw, usage.raw, balance.raw]
					.map((raw) => snippet(raw))
					.join(" || ")}`,
			);
		}
		return snapshots;
	},
};
