import { requestUrl } from "obsidian";
import { firstSuccessful, jsonOf, snippet, type AttemptResult } from "./request";
import { withCurrencySymbol } from "../format";
import type { ProviderAdapter, QuotaExtra, QuotaSnapshot } from "../types";

// 硅基流动用户信息接口契约（官方文档 docs.siliconflow.com/cn/api-reference/userinfo/get-user-info；
// 国内站 docs.siliconflow.cn 该页已下线但端点存活。2026-09-30 无凭证探测实证：坏 Key 两站均返回
// HTTP 401 + {"code":30014,"message":"Token is invalid."}，路由存活）：
//   GET https://api.siliconflow.cn/v1/user/info（国内站，CNY）
//   GET https://api.siliconflow.com/v1/user/info（国际站，USD）
//     Authorization: Bearer <API Key（与推理同一把）>
//   200 → { code: 20000, message: "OK", status: true,
//           data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88", status: "normal", … } }
// ⚠ 信封：code != 20000 一律失败，判定必须看 body（错误可能伴随非 200 状态码，两种路径都覆盖）。
//   余额币种不在响应里，由命中的 host 决定（国内 ¥ / 国际 $）；金额为字符串。
//   官方注明 2026-06-11 后 name/image/email 固定空串（本插件不读这些字段）。

// ⚠ 国内站变故（2026-09-30 真号实测 + 官方公告核实）：/v1/user/info 已于 2026-08-14 停止服务
//   （官方 2026-08-11 公告「接口服务调整」，原文见 docs.siliconflow.cn/cn/release-notes/overview；
//   替代 API 尚未上线——该 release-notes 页是官方指定的"另行通知"位置，上线后第一时间接入）。
//   废弃检查在鉴权之后：无效 Key 得 30014，有效国内 Key 得 401/410 + code 20092（社区两态都有报告）——
//   20092 是确定性终态，按 body code 判定（不按 HTTP 状态码），直接报可解释文案并终止回退
//   （国内 Key 在国际站只会再吃一次 30014）。国际站 /v1/user/info 不受影响（官方文档 deprecated: false）。
const CANDIDATES = [
	{ name: "国内站", url: "https://api.siliconflow.cn/v1/user/info", symbol: "¥" },
	{ name: "国际站", url: "https://api.siliconflow.com/v1/user/info", symbol: "$" },
] as const;

const OK_CODE = 20000;
/** 官方停用码（2026-08-14 起）：终态，不回退。 */
const DEPRECATED_CODE = 20092;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface SiliconFlowApiError {
	code: number | null;
	message: string | null;
}

/** 信封判定：code 存在且非 20000 即失败（20000 之外没有"成功"变体）。 */
export function parseApiError(payload: unknown): SiliconFlowApiError | null {
	if (!isRecord(payload) || typeof payload.code !== "number") return null;
	if (payload.code === OK_CODE) return null;
	const message = typeof payload.message === "string" ? payload.message : null;
	return { code: payload.code, message };
}

export function parseUserPayload(payload: unknown, symbol: string, now = Date.now()): QuotaSnapshot | undefined {
	if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
	const data = payload.data;
	const total = textOf(data.totalBalance);
	if (total === undefined) return undefined;
	const extras: QuotaExtra[] = [];
	const granted = textOf(data.balance);
	const toppedUp = textOf(data.chargeBalance);
	if (granted !== undefined) extras.push({ label: "赠送余额", value: withCurrencySymbol(symbol, granted) });
	if (toppedUp !== undefined) extras.push({ label: "充值余额", value: withCurrencySymbol(symbol, toppedUp) });
	return { coreBalance: withCurrencySymbol(symbol, total), windows: [], extras, capturedAt: now };
}

async function fetchFrom(entry: (typeof CANDIDATES)[number], secret: string): Promise<AttemptResult<QuotaSnapshot>> {
	let response;
	try {
		// throw:false：401/5xx 也要拿到响应体——鉴权失败走 401 + body code。
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
		// 20092 = 官方已停用（2026-08-14）：终态——直接给可解释文案，终止回退（国内 Key 在国际站不会更好）。
		if (apiError.code === DEPRECATED_CODE) {
			throw new Error(
				"硅基流动国内站余额接口已被官方停用（code 20092；2026-08-14 生效，替代接口尚未上线；不代表 Key 无效，可到控制台 cloud.siliconflow.cn 查余额）",
			);
		}
		const detail = apiError.message ?? "凭证被拒绝";
		return { failure: `${detail}（code ${apiError.code}；凭证或区域不匹配均可能）` };
	}
	if (response.status >= 400) return { failure: `HTTP ${response.status}：${snippet(raw)}` };
	const snapshot = parseUserPayload(payload, entry.symbol);
	if (!snapshot) {
		console.warn(`[ai-codingplan-check] 硅基流动 ${entry.name}原始响应：`, raw);
		return { failure: `响应无法解析为已知余额结构：${snippet(raw)}` };
	}
	return { value: snapshot };
}

export const siliconFlowAdapter: ProviderAdapter = {
	id: "siliconflow",
	label: "硅基流动",
	credentialLabel: "API Key",
	credentialHint: "硅基流动 API Key（sk-…，与推理用同一把；国内站 / 国际站均可）",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const snapshot = await firstSuccessful(
			"硅基流动余额查询失败",
			CANDIDATES.map((entry) => ({ name: entry.name, run: () => fetchFrom(entry, secret) })),
		);
		return [snapshot];
	},
};
