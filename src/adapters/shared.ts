/** 适配器共用的纯小件（无宿主依赖）：记录判定、百分比夹取、响应片段截断。
 *  各厂商自己的 numberLike / toFiniteNumber / toEpochMs 变体保留在各自文件——
 *  它们对输入形态的容忍度不同（字符串数字、负数、微秒精度等），不强行合并。 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

/** 错误里附带的响应片段（截断，避免整页 HTML 灌进 Notice）。 */
export function snippet(raw: string): string {
	return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}
