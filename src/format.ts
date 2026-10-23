/** 与宿主无关的纯格式化函数（不依赖 obsidian，供单测直测与视图复用）。 */

/** 百分比显示：最多两位小数、去尾零（0.4 → "0.4"，67.526 → "67.53"，100 → "100"）。 */
export function formatPercent(value: number): string {
	return String(parseFloat(value.toFixed(2)));
}

/** 重置倒计时的人话格式（复合单位）：<1h → 分钟；<24h → 小时+分；≥1天 → 天+小时，零余数省略。
 *  compact=true 为行内紧凑排版：去空格且不带「后重置」后缀，只留时长（"22天13小时"），信息量不变。 */
export function formatResetCountdown(resetsAt: number | null, now = Date.now(), compact = false): string {
	if (resetsAt === null) return "";
	const diff = resetsAt - now;
	if (diff <= 0) return "即将重置";
	const s = compact ? "" : " ";
	const tail = compact ? "" : "后重置";
	const minutes = Math.floor(diff / 60000);
	if (minutes < 60) return `${minutes}${s}分钟${tail}`;
	const hours = Math.floor(minutes / 60);
	const hourPart = minutes % 60;
	if (hours < 24) return hourPart > 0 ? `${hours}${s}小时${s}${hourPart}${s}分${tail}` : `${hours}${s}小时${tail}`;
	const days = Math.floor(hours / 24);
	const dayPart = hours % 24;
	return dayPart > 0 ? `${days}${s}天${s}${dayPart}${s}小时${tail}` : `${days}${s}天${tail}`;
}

/** 金额显示文本：统一两位小数（"110.00"、49.58894 → "49.59"、-2.5 → "-2.50"）；
 *  输入非法时原样转字符串返回，由上层兜底展示。 */
export function toAmountText(value: string | number): string {
	const parsed = typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isFinite(parsed)) return String(value);
	return parsed.toFixed(2);
}

/** 货币符号 + 金额组合：负号恒置于符号最前（如 "-¥2.50"）——面板按前缀负号识别负值。 */
export function withCurrencySymbol(symbol: string, amount: string): string {
	return amount.startsWith("-") ? `-${symbol}${amount.slice(1)}` : `${symbol}${amount}`;
}
