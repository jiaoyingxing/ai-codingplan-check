import { requestUrl } from "obsidian";
import { jsonOf, snippet } from "./request";
import { toAmountText, withCurrencySymbol } from "../format";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot } from "../types";

// 硅基流动（Cookie）——控制台 walletd 会话链（D15，2026-09-30 立项，承接 D13 重开条款）：
// 国内站 API-Key 余额接口已被官方停用（见 siliconflow.ts 文件头），本适配器改走控制台会话。
// 链路规格与多实现证据见 dev-log 20260930-144411：
//   凭证 = 单个 Cookie `__SF_auth.session-token` 的值（控制台登录态，权限大于 API Key，存 SecretStorage）。
//   ① GET https://account.siliconflow.cn/api/subjects                （Cookie）
//        → data[0].subjectId（自动获取，用户只粘这一个 Cookie 值）
//   ② GET https://cloud.siliconflow.cn/walletd-server/api/v1/subject/profile/peek
//        （Cookie + X-Subject-Id；tokenbank 口径另带 Origin/Referer）
//        → code 20000 + data.financialInfo.{balance, available, recharged, used, …}
//   ③ GET …/walletd-server/api/v1/subject/wallets?pageSize=50&visible=1（同②头，best-effort：
//        失败只少代金券行，不拖垮余额）→ data.wallets[]（status 0=可用；cap=-1 为授信账户跳过；
//        name 为多语言 JSON 字符串取 zh-cn）
// ⚠ 金额单位统一 1 元 = 1e12（字符串数字，÷1e12 展示两位小数）。
// ⚠ 会话失效表象：30x/401/403、返回登录页 HTML、业务码 40100/40001/40003——文案统一引导重贴；
//   实名是前置（未实名连控制台余额都不可见）。
// 展现（§v1.2 余额型）：coreBalance = 可用额度合计（裁决⑥，20260930 拍板）= 现金可用
// （financialInfo.available，缺则退 balance）+ 可用代金券合计（wallets 求和；失败退纯现金）；
// 累计充值/消费与代金券/资源包进 extras（用户拍板"一起查"）。移动端 requestUrl 自定义 Cookie
// 头行为已实测保留（厂商接口现状 №5）。

const SUBJECTS_URL = "https://account.siliconflow.cn/api/subjects";
const PEEK_URL = "https://cloud.siliconflow.cn/walletd-server/api/v1/subject/profile/peek";
const WALLETS_URL = "https://cloud.siliconflow.cn/walletd-server/api/v1/subject/wallets?pageSize=50&visible=1";

const COOKIE_NAME = "__SF_auth.session-token";
/** 1 元对应的内部单位数（字符串金额 ÷ 该值 = 元）。 */
const UNITS_PER_YUAN = 1e12;
/** 控制台信封成功码。 */
const OK_CODE = 20000;
/** 会话失效类业务码（llm-gateway / FeeQuery 口径：40100；FeeQuery 另见 40001/40003）。 */
const SESSION_CODES = new Set([40100, 40001, 40003]);

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

/** 容错凭证输入：容忍裸值 / 整对 name=value / 带 "Cookie:" 前缀 / 首尾引号，
 *  也容忍**整串 Cookie**（如从 Network 请求头复制的 "a=1; __SF_auth.session-token=…; b=2"）——
 *  含目标对时直接提取该对，用户粘哪一层都能用。 */
export function normalizeCookie(raw: string): string {
	let value = raw.trim().replace(/^cookie:\s*/i, "").trim();
	const marker = `${COOKIE_NAME}=`;
	const idx = value.indexOf(marker);
	if (idx !== -1) {
		const pairValue = value
			.slice(idx + marker.length)
			.split(";")[0]
			.trim()
			.replace(/^["']|["']$/g, "");
		return `${COOKIE_NAME}=${pairValue}`;
	}
	value = value.replace(/^["']|["']$/g, "").trim();
	return `${COOKIE_NAME}=${value}`;
}

/** 从 subjects 响应取 subjectId（兼容 data 为数组或对象）。 */
export function parseSubjectId(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const pick = (row: unknown): string | undefined => {
		if (!isRecord(row)) return undefined;
		const id = row.subjectId ?? row.subject_id;
		if (typeof id === "string" && id.trim()) return id.trim();
		if (typeof id === "number" && Number.isFinite(id)) return String(id);
		return undefined;
	};
	if (Array.isArray(payload.data)) {
		for (const row of payload.data) {
			const id = pick(row);
			if (id) return id;
		}
		return undefined;
	}
	return pick(payload.data);
}

/** 1e12 内部单位 → 元文本（两位小数）。 */
function fromWalletUnit(value: unknown): string | undefined {
	const raw = numberLike(value);
	return raw === undefined ? undefined : toAmountText(raw / UNITS_PER_YUAN);
}

/** 行槽位统一语义（§v1.2 裁决⑥，20260930 拍板）：可用额度的合计 = 现金可用 + 可用代金券。
 *  输入均为元文本；任一非法时退现金值原样（上层兜底展示）。 */
export function totalAvailableText(cashYuan: string, voucherYuan: string | undefined): string {
	const cash = Number(cashYuan);
	if (!Number.isFinite(cash)) return cashYuan;
	const voucher = voucherYuan === undefined ? 0 : Number(voucherYuan);
	return toAmountText(cash + (Number.isFinite(voucher) ? voucher : 0));
}

export interface FinancialTexts {
	available: string;
	/** 现金余额（充值剩余的现金部分，展示口径作「充值余额」；代金券是独立钱包不在其中）。 */
	balance?: string;
	recharged?: string;
	used?: string;
}

/** 解析 peek 的 financialInfo；coreBalance 口径 = available（缺则退 balance）。 */
export function parseFinancialInfo(payload: unknown): FinancialTexts | undefined {
	if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.financialInfo)) return undefined;
	const info = payload.data.financialInfo;
	const available = fromWalletUnit(info.available) ?? fromWalletUnit(info.balance);
	if (available === undefined) return undefined;
	return {
		available,
		balance: fromWalletUnit(info.balance),
		recharged: fromWalletUnit(info.recharged),
		used: fromWalletUnit(info.used),
	};
}

/** 钱包名是多语言 JSON 字符串（如 {"zh-cn":"认证奖励金",...}），取 zh-cn，失败退原文。 */
export function parseWalletName(name: unknown): string {
	if (typeof name !== "string" || !name.trim()) return "代金券";
	const trimmed = name.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isRecord(parsed)) {
				const zh = parsed["zh-cn"] ?? parsed["zh-CN"] ?? parsed["zh"];
				if (typeof zh === "string" && zh.trim()) return zh.trim();
				for (const value of Object.values(parsed)) {
					if (typeof value === "string" && value.trim()) return value.trim();
				}
			}
		} catch {
			// 非 JSON，走原文
		}
	}
	return trimmed;
}

export interface WalletBreakdown {
	extras: QuotaExtra[];
	/** 计入合计的代金券总额（元文本）；无可用代金券时缺省。 */
	total?: string;
	/** 计入合计的张数。 */
	count: number;
}

/** 钱包 → 代金券明细：跳过授信（cap=-1）、用尽（status=1）与零余额；到期日拆到次要列（不并入金额串）。
 *  同时给出合计与张数（§v1.2 展开位补「代金券合计」行，20260930 真号反馈）。 */
export function parseWallets(payload: unknown): WalletBreakdown {
	if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.wallets)) {
		return { extras: [], count: 0 };
	}
	const extras: QuotaExtra[] = [];
	let totalUnits = 0;
	let count = 0;
	for (const row of payload.data.wallets) {
		if (!isRecord(row)) continue;
		if (String(row.cap) === "-1") continue;
		if (numberLike(row.status) === 1) continue;
		const balanceUnits = numberLike(row.balance);
		if (balanceUnits === undefined || balanceUnits <= 0) continue;
		let detail: string | undefined;
		const expiresAt = numberLike(row.expiresAt);
		if (expiresAt !== undefined && expiresAt > 0) {
			const ms = expiresAt >= 1e12 ? expiresAt : expiresAt * 1000;
			const date = new Date(ms);
			if (!Number.isNaN(date.getTime())) detail = `${date.toISOString().slice(0, 10)} 到期`;
		}
		extras.push({
			label: parseWalletName(row.name),
			value: withCurrencySymbol("¥", toAmountText(balanceUnits / UNITS_PER_YUAN)),
			detail,
		});
		totalUnits += balanceUnits;
		count += 1;
	}
	return count > 0 ? { extras, total: toAmountText(totalUnits / UNITS_PER_YUAN), count } : { extras, count: 0 };
}

function sessionExpired(detail: string): never {
	throw new Error(
		`硅基流动会话 Cookie 已失效或不可用：${detail}；请重新从浏览器复制 ${COOKIE_NAME} 的值（账号需已实名）`,
	);
}

async function fetchSubjectId(cookie: string): Promise<string> {
	// throw:false：30x/401 也要拿到响应体——会话失效常表现为重定向到登录页。
	const response = await requestUrl({
		url: SUBJECTS_URL,
		method: "GET",
		headers: { accept: "application/json", cookie },
		throw: false,
	});
	const raw = response.text;
	if (response.status >= 400) sessionExpired(`HTTP ${response.status}：${snippet(raw)}`);
	const subjectId = parseSubjectId(jsonOf(response));
	if (!subjectId) {
		sessionExpired(raw.trimStart().startsWith("<") ? "返回的是登录页而非数据" : `无法从响应中获取账户标识：${snippet(raw)}`);
	}
	return subjectId;
}

async function fetchFinancial(cookie: string, subjectId: string): Promise<FinancialTexts> {
	const response = await requestUrl({
		url: PEEK_URL,
		method: "GET",
		headers: {
			accept: "application/json",
			cookie,
			"x-subject-id": subjectId,
			origin: "https://cloud.siliconflow.cn",
			referer: "https://cloud.siliconflow.cn/",
		},
		throw: false,
	});
	const raw = response.text;
	if (response.status >= 400) sessionExpired(`HTTP ${response.status}：${snippet(raw)}`);
	const payload = jsonOf(response);
	if (isRecord(payload) && typeof payload.code === "number" && payload.code !== OK_CODE) {
		const message = typeof payload.message === "string" ? payload.message : "无描述";
		if (SESSION_CODES.has(payload.code)) sessionExpired(`控制台返回 ${message}（code ${payload.code}）`);
		throw new Error(`硅基流动控制台返回错误（code ${payload.code}；${message}）；若持续出现请重贴会话 Cookie`);
	}
	const financial = parseFinancialInfo(payload);
	if (!financial) {
		console.warn("[ai-codingplan-check] 硅基流动（Cookie）peek 原始响应：", raw);
		throw new Error(`响应无法解析为已知余额结构：${snippet(raw)}`);
	}
	return financial;
}

/** 代金券/资源包：best-effort——失败只少 extras 行，不拖垮余额主链。 */
async function fetchWallets(cookie: string, subjectId: string): Promise<WalletBreakdown> {
	try {
		const response = await requestUrl({
			url: WALLETS_URL,
			method: "GET",
			headers: {
				accept: "application/json",
				cookie,
				"x-subject-id": subjectId,
				origin: "https://cloud.siliconflow.cn",
				referer: "https://cloud.siliconflow.cn/",
			},
			throw: false,
		});
		if (response.status >= 400) return { extras: [], count: 0 };
		return parseWallets(jsonOf(response));
	} catch (error) {
		console.warn("[ai-codingplan-check] 硅基流动（Cookie）wallets 获取失败（忽略）：", error);
		return { extras: [], count: 0 };
	}
}

export const siliconFlowCookieAdapter: ProviderAdapter = {
	id: "siliconflow-cookie",
	label: "硅基流动（Cookie）",
	credentialLabel: "会话 Cookie",
	credentialHint:
		"控制台登录态 Cookie：__SF_auth.session-token 的值（非 API Key，权限更大，勿外传）。获取：登录 cloud.siliconflow.cn 后 F12 → Application → Cookies 复制其 Value；整串 Cookie 或 Network 里任意请求的 Cookie 请求头粘入也可。失效后重新复制",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const cookie = normalizeCookie(secret);
		const subjectId = await fetchSubjectId(cookie);
		const financial = await fetchFinancial(cookie, subjectId);
		const wallets = await fetchWallets(cookie, subjectId);
		const extras: QuotaExtra[] = [];
		// 真号反馈（20260930）：补「充值余额」（现金口径，与 DeepSeek 的充值余额同义）与「代金券合计」。
		if (financial.balance !== undefined) {
			extras.push({ label: "充值余额", value: withCurrencySymbol("¥", financial.balance) });
		}
		if (financial.recharged !== undefined) {
			extras.push({ label: "累计充值", value: withCurrencySymbol("¥", financial.recharged) });
		}
		if (financial.used !== undefined) {
			extras.push({ label: "累计消费", value: withCurrencySymbol("¥", financial.used) });
		}
		if (wallets.total !== undefined) {
			extras.push({ label: "代金券合计", value: withCurrencySymbol("¥", wallets.total), detail: `${wallets.count} 张` });
		}
		extras.push(...wallets.extras);
		return [{ coreBalance: withCurrencySymbol("¥", totalAvailableText(financial.available, wallets.total)), windows: [], extras, capturedAt: Date.now() }];
	},
};
