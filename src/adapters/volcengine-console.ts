import { requestUrl } from "obsidian";
import { jsonOf, snippet } from "./request";
import { cookieHeaderValue, normalizeCookieHeader } from "./cookie";
import { isAuthErrorCode, parseAfpTiers, parseCodingTiers, responseError, resultOf } from "./volcengine";
import type { ProviderAdapter, QuotaSnapshot } from "../types";

// 火山方舟（Cookie）——console.volcengine.com 会话链（D16 首批，2026-09-30 立项；同日真号反馈补 Agent Plan）：
// 数据面 API（ark.cn-beijing.volces.com）无 quota 端点，这是无 AK/SK 用户查方舟用量的唯一来源，
// 与 AK/SK 版「火山方舟」互补（同两个 Action：GetCodingPlanUsage / GetAgentPlanAFPUsage，
// 控制台网关走 Cookie 而非 SigV4；卡序与 AK/SK 版相反——Coding Plan 为主链在前，真号先验的是它）。
// 契约：volcengine-coding-plan-monitor（2026-07 实测）+ OmniRoute（2026-09 活跃）双实现印证，
// 见 dev-log 20260930-153531：
//   凭证 = 整条 Cookie 请求头（console.volcengine.com；必需含 csrfToken=，x-csrf-token 自解析；
//   登录态权限大，勿外传）。社区经验约 7 天需重贴一次。
//   POST /api/top/ark/cn-beijing/2024-01-01/{Action}，头：cookie + x-csrf-token + origin/referer
//   （referer 按 Plan 分页面，OmniRoute 口径）。monitor 会附带 x-web-id，但 OmniRoute 完全不带
//   也可用（2026-09 活跃实证）——故不要求，缺了不影响。
//   Coding Plan body {"ProjectName":"default"}（本仓真号实证）；AFP body "{}"（OmniRoute 口径）。
//   响应解析复用 volcengine.ts 的 parseCodingTiers / parseAfpTiers。
//   失败语义对齐 AK/SK 版：401/403 或鉴权类 Error 信封 = 会话失效 → 报重贴（两 Action 同命）；
//   业务 Error / 非 2xx / 未订阅 → soft（收集后定夺）；Coding 未订阅而 Agent 有窗时只出 Agent 卡，反之亦然。

const CONSOLE_ORIGIN = "https://console.volcengine.com";
const GATEWAY = `${CONSOLE_ORIGIN}/api/top/ark/cn-beijing/2024-01-01`;
const CODING_REFERER = `${CONSOLE_ORIGIN}/ark/region:cn-beijing/subscription/coding-plan`;
const AGENT_REFERER = `${CONSOLE_ORIGIN}/ark/region:cn-beijing/subscription/agent-plan`;

/** csrfToken cookie 值即 x-csrf-token 头（控制台前端同款取法）。导出仅为单测。 */
export function extractCsrfToken(cookie: string): string | undefined {
	return cookieHeaderValue(cookie, "csrfToken");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionExpired(detail: string): never {
	throw new Error(
		`火山引擎控制台登录 Cookie 已失效或不可用：${detail}；请重新从浏览器复制整条 Cookie 请求头（console.volcengine.com）`,
	);
}

type ConsoleResult = { kind: "body"; raw: string; payload: unknown } | { kind: "soft"; detail: string };

async function consoleCall(
	action: string,
	referer: string,
	body: string,
	cookie: string,
	csrf: string,
): Promise<ConsoleResult> {
	let response;
	try {
		// throw:false：401/403 也要拿到响应体——会话失效要给可解释文案，不是笼统报错。
		response = await requestUrl({
			url: `${GATEWAY}/${action}`,
			method: "POST",
			headers: {
				accept: "application/json, text/plain, */*",
				"content-type": "application/json",
				cookie,
				origin: CONSOLE_ORIGIN,
				referer,
				"x-csrf-token": csrf,
			},
			body,
			throw: false,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`请求失败：${message}`);
	}
	const raw = response.text;
	if (response.status === 401 || response.status === 403) sessionExpired(`HTTP ${response.status}：${snippet(raw)}`);
	if (response.status >= 400) return { kind: "soft", detail: `HTTP ${response.status}：${snippet(raw)}` };
	const payload = jsonOf(response);
	const err = responseError(payload);
	if (err) {
		const detail = `${err.code ? `${err.code}：` : ""}${err.message}`;
		if (isAuthErrorCode(err.code) || /登录|login/i.test(err.message)) sessionExpired(detail);
		return { kind: "soft", detail };
	}
	return { kind: "body", raw, payload };
}

/** PlanType 在场时拼到套餐名后（与 AK/SK 版口径一致）。 */
function planNameOf(result: unknown, prefix: string): string {
	const planType = isRecord(result) && typeof result.PlanType === "string" ? result.PlanType.trim() : "";
	return planType ? `${prefix} ${planType}` : prefix;
}

async function fetchPlans(cookie: string, csrf: string): Promise<QuotaSnapshot[]> {
	const snapshots: QuotaSnapshot[] = [];
	const softErrors: string[] = [];
	const emptyRaw: string[] = [];

	// 1) Coding Plan（主链，真号先验路径）
	const coding = await consoleCall(
		"GetCodingPlanUsage",
		CODING_REFERER,
		JSON.stringify({ ProjectName: "default" }),
		cookie,
		csrf,
	);
	if (coding.kind === "soft") softErrors.push(`GetCodingPlanUsage：${coding.detail}`);
	if (coding.kind === "body") {
		const result = resultOf(coding.payload);
		const windows = parseCodingTiers(result);
		if (windows.length > 0) {
			snapshots.push({ planName: planNameOf(result, "Coding Plan"), windows, extras: [], capturedAt: Date.now() });
		} else {
			emptyRaw.push(snippet(coding.raw));
		}
	}

	// 2) Agent Plan（best-effort：未订阅 / 结构不符只少一张卡，不拖垮 Coding Plan）
	const afp = await consoleCall("GetAgentPlanAFPUsage", AGENT_REFERER, "{}", cookie, csrf);
	if (afp.kind === "soft") softErrors.push(`GetAgentPlanAFPUsage：${afp.detail}`);
	if (afp.kind === "body") {
		const result = resultOf(afp.payload);
		const windows = parseAfpTiers(result);
		if (windows.length > 0) {
			snapshots.push({ planName: planNameOf(result, "Agent Plan"), windows, extras: [], capturedAt: Date.now() });
		}
	}

	if (snapshots.length > 0) return snapshots;
	if (softErrors.length > 0) throw new Error(`火山方舟控制台返回错误：${softErrors.join("；")}`);
	console.warn("[ai-codingplan-check] 火山方舟（Cookie）原始响应：", emptyRaw.join(" || "));
	throw new Error(`响应未解析到任何用量窗口（可能未订阅 Coding / Agent Plan 或平台改版）：${emptyRaw.join(" || ")}`);
}

export const volcengineConsoleAdapter: ProviderAdapter = {
	id: "volcengine-console",
	label: "火山方舟（Cookie）",
	credentialLabel: "会话 Cookie",
	credentialHint:
		"火山引擎控制台登录态 Cookie：登录 console.volcengine.com 后，从 F12 Network 任意请求复制整条 Cookie 请求头（需含 csrfToken=；非 API Key，权限更大，勿外传）。查询 Coding / Agent Plan 用量，与 AccessKey 版互补；社区经验约 7 天需重贴",
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		const cookie = normalizeCookieHeader(secret);
		const csrf = extractCsrfToken(cookie);
		if (csrf === undefined) {
			throw new Error(
				"Cookie 里缺少 csrfToken=（请登录 console.volcengine.com 后，从 F12 Network 任意请求复制整条 Cookie 请求头）",
			);
		}
		return fetchPlans(cookie, csrf);
	},
};
