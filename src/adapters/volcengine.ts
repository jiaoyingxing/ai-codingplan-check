import { requestUrl } from "obsidian";
import type { ProviderAdapter, QuotaSnapshot, QuotaWindow } from "../types";

// 火山方舟额度查询契约（来源：farion1231/cc-switch src-tauri/src/services/coding_plan.rs，
// 生产实测实现，2026-09 核对）：
// - 额度是**控制面 OpenAPI**：网关 https://open.volcengineapi.com（不是推理域名
//   ark.cn-beijing.volces.com），POST /?Action=...&Region=cn-beijing&Version=2024-01-01，空 body。
// - **强制火山签名 V4（AK/SK）**，与推理 Bearer Key 是两套凭据（Bearer 会被网关
//   400 InvalidAuthorization 格式层拒绝）。签名是 AWS SigV4 的火山变体，两处致命差异：
//   ① canonical headers 与 SignedHeaders 固定顺序 host;x-date;x-content-sha256;content-type（不按字母序）；
//   ② 算法串 HMAC-SHA256（无 AWS4 前缀）、scope 结尾 request（非 aws4_request）、kDate=HMAC(SK,date)（SK 不加前缀）。
// - 自动探测双计划：先 GetAFPUsage（Agent Plan，Result.AFPFiveHour/AFPWeekly/AFPMonthly，
//   绝对值 Quota/Used，Quota<=0=未订阅跳过；AFPDaily 官方控制台隐藏，跳过）；
//   再 GetCodingPlanUsage（Coding Plan，Result.QuotaUsage[]，Level=session|weekly|monthly，
//   只给已用百分比 Percent，ResetTime 秒级）。两 plan 共用同一份 AK/SK，鉴权错误即停。
// - 错误信封：ResponseMetadata.Error（或顶层 Error）；火山常以 200+Error 返回业务错误。

const OPENAPI_HOST = "open.volcengineapi.com";
const API_VERSION = "2024-01-01";
const REGION = "cn-beijing"; // Agent/Coding Plan 控制面目前在 cn-beijing
const SERVICE = "ark";
const CONTENT_TYPE = "application/json; charset=utf-8";
const SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";

const encoder = new TextEncoder();

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as unknown as ArrayBuffer,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", cryptoKey, data as unknown as ArrayBuffer);
	return new Uint8Array(digest);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function hmacHex(key: Uint8Array, data: Uint8Array): Promise<string> {
	return Array.from(new Uint8Array(await hmac(key, data)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** RFC3986 unreserved 之外全部 %XX 编码（canonical query 用）。 */
function uriEncode(input: string): string {
	let out = "";
	for (const byte of encoder.encode(input)) {
		if (
			(byte >= 65 && byte <= 90) ||
			(byte >= 97 && byte <= 122) ||
			(byte >= 48 && byte <= 57) ||
			byte === 45 ||
			byte === 95 ||
			byte === 46 ||
			byte === 126
		) {
			out += String.fromCharCode(byte);
		} else {
			out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

/** 按 key 字母序、逐段编码的 canonical query；签名与实际 URL 共用同一份字符串。 */
export function canonicalQuery(action: string, region: string): string {
	const pairs: [string, string][] = [
		["Action", action],
		["Region", region],
		["Version", API_VERSION],
	];
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
	return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
}

/** 火山签名 V4：返回 (Authorization, X-Date, X-Content-Sha256)，三者都须进请求头。 */
export async function signRequest(
	accessKeyId: string,
	secretAccessKey: string,
	region: string,
	query: string,
	body: Uint8Array,
	now: Date,
): Promise<[string, string, string]> {
	const xDate = toVolcDate(now);
	const shortDate = xDate.slice(0, 8);
	const contentSha = await sha256Hex(body);
	// 火山特有：canonical headers 固定顺序，不按字母序。
	const canonicalHeaders = `host:${OPENAPI_HOST}\nx-date:${xDate}\nx-content-sha256:${contentSha}\ncontent-type:${CONTENT_TYPE}\n`;
	const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${contentSha}`;
	const scope = `${shortDate}/${region}/${SERVICE}/request`;
	const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${await sha256Hex(encoder.encode(canonicalRequest))}`;
	// 密钥链：kDate=HMAC(SK,date)（SK 不加 AWS4 前缀），终止串 request。
	let key = await hmac(encoder.encode(secretAccessKey), encoder.encode(shortDate));
	key = await hmac(key, encoder.encode(region));
	key = await hmac(key, encoder.encode(SERVICE));
	key = await hmac(key, encoder.encode("request"));
	const signature = await hmacHex(key, encoder.encode(stringToSign));
	const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;
	return [authorization, xDate, contentSha];
}

function toVolcDate(now: Date): string {
	return (
		`${now.getUTCFullYear()}`.padStart(4, "0") +
		`${now.getUTCMonth() + 1}`.padStart(2, "0") +
		`${now.getUTCDate()}`.padStart(2, "0") +
		"T" +
		`${now.getUTCHours()}`.padStart(2, "0") +
		`${now.getUTCMinutes()}`.padStart(2, "0") +
		`${now.getUTCSeconds()}`.padStart(2, "0") +
		"Z"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 兼容 epoch 秒/毫秒/ISO 字符串；输出 epoch ms。 */
function toEpochMs(value: unknown): number | null {
	let ts: number | undefined;
	if (typeof value === "number" && Number.isFinite(value)) ts = value;
	else if (typeof value === "string" && value.trim()) {
		const t = value.trim();
		ts = /^\d+$/.test(t) ? Number(t) : Date.parse(t);
	}
	if (ts === undefined || !Number.isFinite(ts) || ts < 0) return null;
	return ts >= 1e12 ? ts : ts * 1000;
}

function clampPercent(v: number): number {
	return Math.min(100, Math.max(0, v));
}

/** 响应里的 ResponseMetadata.Error（或顶层 Error）；无则 null。 */
export function responseError(body: unknown): { code: string; message: string } | null {
	const err = isRecord(body)
		? (isRecord(body.ResponseMetadata) && isRecord(body.ResponseMetadata.Error)
			? body.ResponseMetadata.Error
			: isRecord(body.Error)
				? body.Error
				: undefined)
		: undefined;
	if (!err) return null;
	const code = typeof err.Code === "string" ? err.Code : "";
	const message = typeof err.Message === "string" ? err.Message : "";
	return code || message ? { code, message } : null;
}

function isAuthErrorCode(code: string): boolean {
	const c = code.toLowerCase();
	return (
		c.includes("auth") ||
		c.includes("signature") ||
		c.includes("accessdenied") ||
		c.includes("denied") ||
		c.includes("unauthorized") ||
		c.includes("forbidden") ||
		c.includes("credential") ||
		c.includes("token")
	);
}

type VolcCall =
	| { kind: "body"; body: unknown }
	| { kind: "auth"; detail: string }
	| { kind: "soft"; detail: string }
	| { kind: "transient"; detail: string };

async function openApiCall(
	accessKeyId: string,
	secretAccessKey: string,
	action: string,
): Promise<VolcCall> {
	const query = canonicalQuery(action, REGION);
	const url = `https://${OPENAPI_HOST}/?${query}`;
	const body = encoder.encode("");
	const [authorization, xDate, contentSha] = await signRequest(
		accessKeyId,
		secretAccessKey,
		REGION,
		query,
		body,
		new Date(),
	);
	let response;
	try {
		response = await requestUrl({
			url,
			method: "POST",
			headers: {
				"X-Date": xDate,
				"X-Content-Sha256": contentSha,
				"Content-Type": CONTENT_TYPE,
				Authorization: authorization,
			},
			body: "",
			throw: false,
		});
	} catch (error) {
		return { kind: "transient", detail: `网络错误：${String(error)}` };
	}
	const raw = response.text;
	if (response.status === 401 || response.status === 403) {
		return { kind: "auth", detail: `HTTP ${response.status}：${snippet(raw)}` };
	}
	if (response.status >= 400) {
		// 火山网关对签名/凭据类错误常返 4xx 并带与 200 相同的 Error 信封。
		let body: unknown = null;
		try {
			body = JSON.parse(raw);
		} catch {
			body = null;
		}
		const err = responseError(body);
		if (err && isAuthErrorCode(err.code)) {
			return { kind: "auth", detail: `HTTP ${response.status}，${err.code}：${err.message}` };
		}
		return { kind: "soft", detail: `HTTP ${response.status}：${snippet(raw)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "soft", detail: `HTTP ${response.status} 响应不是合法 JSON` };
	}
	const err = responseError(parsed);
	if (err) {
		return isAuthErrorCode(err.code)
			? { kind: "auth", detail: `${err.code}：${err.message}` }
			: { kind: "soft", detail: `${err.code}：${err.message}` };
	}
	return { kind: "body", body: parsed };
}

function snippet(raw: string): string {
	return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

const AFP_WINDOWS: [string, string][] = [
	["AFPFiveHour", "近5小时"],
	["AFPWeekly", "近一周"],
	["AFPMonthly", "近一月"],
];

/** Agent Plan：Result.AFP* 窗口（Quota/Used 绝对值）；Quota<=0 = 未订阅跳过。 */
export function parseAfpTiers(result: unknown): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	if (!isRecord(result)) return windows;
	for (const [key, label] of AFP_WINDOWS) {
		const win = isRecord(result[key]) ? result[key] : undefined;
		if (!win) continue;
		const quota = num(win.Quota);
		if (quota === undefined || quota <= 0) continue;
		const used = num(win.Used) ?? 0;
		const usedPercent = clampPercent((used / quota) * 100);
		windows.push({
			key,
			label,
			usedPercent,
			resetsAt: toEpochMs(win.ResetTime),
			rateLimited: usedPercent >= 100,
		});
	}
	return windows;
}

const CODING_LEVELS: [string[], string][] = [
	[["session", "5h", "fivehour", "five_hour", "rolling_5h"], "近5小时"],
	[["weekly", "week", "7d"], "近一周"],
	[["monthly", "month"], "近一月"],
];

function codingLevel(label: string): string | null {
	const l = label.toLowerCase();
	for (const [names, out] of CODING_LEVELS) if (names.includes(l)) return out;
	return null;
}

/** Coding Plan：Result.QuotaUsage/Usages/Details[]，Level 字段实测 session/weekly/monthly，只给已用百分比。 */
export function parseCodingTiers(result: unknown): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	if (!isRecord(result)) return windows;
	const arr =
		(Array.isArray(result.QuotaUsage) && result.QuotaUsage) ||
		(Array.isArray(result.Usages) && result.Usages) ||
		(Array.isArray(result.Details) && result.Details) ||
		null;
	if (!arr) return windows;
	for (const item of arr as unknown[]) {
		if (!isRecord(item)) continue;
		const level =
			(typeof item.Level === "string" && item.Level) ||
			(typeof item.Type === "string" && item.Type) ||
			(typeof item.Period === "string" && item.Period) ||
			"";
		const label = codingLevel(level);
		if (!label) continue;
		const percent =
			num(item.Percent) ?? num(item.UsedPercent) ?? num(item.UsagePercent) ?? 0;
		windows.push({
			key: level,
			label,
			usedPercent: clampPercent(percent),
			resetsAt: toEpochMs(item.ResetTime ?? item.ResetTimestamp),
			rateLimited: clampPercent(percent) >= 100,
		});
	}
	return windows;
}

function resultOf(body: unknown): unknown {
	return isRecord(body) && "Result" in body ? body.Result : body;
}

export const volcengineAdapter: ProviderAdapter = {
	id: "volcengine",
	label: "火山方舟",
	credentialLabel: "AccessKey ID",
	credentialHint: "火山引擎控制台-API 访问密钥的 AccessKey ID",
	credential2: {
		label: "Secret Access Key",
		hint: "与 AccessKey ID 成对保存的 Secret（额度查询走 OpenAPI，与推理 Key 是两套凭据）",
	},
	splitCredential(stored: string): [string, string] {
		try {
			const parsed = JSON.parse(stored) as { ak?: unknown; sk?: unknown };
			if (isRecord(parsed) && typeof parsed.ak === "string" && typeof parsed.sk === "string") {
				return [parsed.ak, parsed.sk];
			}
		} catch {
			// 旧格式或坏数据：整体当作 AK，SK 置空由用户重填
		}
		return [stored, ""];
	},
	joinCredential(first: string, second: string): string {
		return JSON.stringify({ ak: first, sk: second });
	},
	async fetchQuota(secret: string): Promise<QuotaSnapshot[]> {
		let ak = "";
		let sk = "";
		try {
			const parsed = JSON.parse(secret) as { ak?: unknown; sk?: unknown };
			if (isRecord(parsed)) {
				ak = typeof parsed.ak === "string" ? parsed.ak : "";
				sk = typeof parsed.sk === "string" ? parsed.sk : "";
			}
		} catch {
			ak = secret;
		}
		if (!ak || !sk) throw new Error("AccessKey ID / Secret 不完整，请重新编辑账号");

		const snapshots: QuotaSnapshot[] = [];
		const softErrors: string[] = [];
		const emptyRaw: string[] = [];

		// 1) Agent Plan：GetAFPUsage（回绝对额度 Quota/Used）
		const afp = await openApiCall(ak, sk, "GetAFPUsage");
		if (afp.kind === "auth") throw new Error(`${afp.detail}。请检查 AccessKey/Secret 与 OpenAPI 权限`);
		if (afp.kind === "transient") throw new Error(`GetAFPUsage：${afp.detail}`);
		if (afp.kind === "soft") softErrors.push(`GetAFPUsage：${afp.detail}`);
		if (afp.kind === "body") {
			const result = resultOf(afp.body);
			const windows = parseAfpTiers(result);
			if (windows.length > 0) {
				const planType =
					isRecord(result) && typeof result.PlanType === "string" ? result.PlanType.trim() : "";
				snapshots.push({
					planName: planType ? `Agent Plan ${planType}` : "Agent Plan",
					windows,
					extras: [],
					capturedAt: Date.now(),
				});
			} else {
				emptyRaw.push(snippet(JSON.stringify(afp.body)));
			}
		}

		// 2) Coding Plan：GetCodingPlanUsage（只回已用百分比）
		const coding = await openApiCall(ak, sk, "GetCodingPlanUsage");
		if (coding.kind === "auth") throw new Error(`${coding.detail}。请检查 AccessKey/Secret 与 OpenAPI 权限`);
		if (coding.kind === "transient") throw new Error(`GetCodingPlanUsage：${coding.detail}`);
		if (coding.kind === "soft") softErrors.push(`GetCodingPlanUsage：${coding.detail}`);
		if (coding.kind === "body") {
			const result = resultOf(coding.body);
			const windows = parseCodingTiers(result);
			if (windows.length > 0) {
				snapshots.push({ planName: "Coding Plan", windows, extras: [], capturedAt: Date.now() });
			} else {
				emptyRaw.push(snippet(JSON.stringify(coding.body)));
			}
		}

		if (snapshots.length > 0) return snapshots;
		if (softErrors.length > 0) throw new Error(softErrors.join("; "));
		throw new Error(
			`签名已通过但未解析到任何订阅额度（可能未订阅）：${emptyRaw.join(" || ")}`,
		);
	},
};
