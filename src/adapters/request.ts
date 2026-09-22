/** 适配器共用的请求层小件：响应片段、容错 JSON 取值、多端点尝试。
 *  多端点尝试是几家厂商的共同形态（同族域名 / 新旧路径并存，区域靠 host 区分），
 *  失败文案必须带端点名与原因片段，且同一句话只出现一次（凭证无效时各端点往往同因）。 */

/** 错误里附带的响应片段（截断，避免整页 HTML 灌进 Notice）。 */
export function snippet(raw: string): string {
	return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

/** 宿主 response.json 在非 JSON 响应体上会抛，取不到就当 undefined 交给上层判定。 */
export function jsonOf(response: { json: unknown }): unknown {
	try {
		return response.json;
	} catch {
		return undefined;
	}
}

export type AttemptResult<T> = { value: T } | { failure: string };

export interface EndpointAttempt<T> {
	/** 失败文案里的端点名，如 国内站 / 国际站·旧路径。 */
	name: string;
	run: () => Promise<AttemptResult<T>>;
}

/** 按序请求，第一个成功即返回；全失败时抛出带各端点原因的合并错误。 */
export async function firstSuccessful<T>(label: string, attempts: EndpointAttempt<T>[]): Promise<T> {
	const failures: { name: string; failure: string }[] = [];
	for (const attempt of attempts) {
		const result = await attempt.run();
		if ("value" in result) return result.value;
		failures.push({ name: attempt.name, failure: result.failure });
	}
	const distinct = [...new Set(failures.map((item) => item.failure))];
	const detail =
		distinct.length === 1
			? `${failures.map((item) => item.name).join("、")}同因：${distinct[0]}`
			: failures.map((item) => `${item.name} ${item.failure}`).join("；");
	throw new Error(`${label}：${detail}`);
}
