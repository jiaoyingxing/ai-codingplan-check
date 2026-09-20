/** 与宿主无关的纯格式化函数（不依赖 obsidian，供单测直测与视图复用）。 */

/** 百分比显示：最多两位小数、去尾零（0.4 → "0.4"，67.526 → "67.53"，100 → "100"）。 */
export function formatPercent(value: number): string {
	return String(parseFloat(value.toFixed(2)));
}

/** 重置倒计时的人话格式（复合单位）：<1h → 分钟；<24h → 小时+分；≥1天 → 天+小时，零余数省略。
 *  compact=true 输出去空格的紧凑排版（列表行内嵌场景），信息量不变。 */
export function formatResetCountdown(resetsAt: number | null, now = Date.now(), compact = false): string {
	if (resetsAt === null) return "";
	const diff = resetsAt - now;
	if (diff <= 0) return "即将重置";
	const s = compact ? "" : " ";
	const minutes = Math.floor(diff / 60000);
	if (minutes < 60) return `${minutes}${s}分钟后重置`;
	const hours = Math.floor(minutes / 60);
	const hourPart = minutes % 60;
	if (hours < 24) return hourPart > 0 ? `${hours}${s}小时${s}${hourPart}${s}分后重置` : `${hours}${s}小时后重置`;
	const days = Math.floor(hours / 24);
	const dayPart = hours % 24;
	return dayPart > 0 ? `${days}${s}天${s}${dayPart}${s}小时后重置` : `${days}${s}天后重置`;
}
