/** 整串 Cookie 凭证的共用小件（Cookie 型适配器家族，D15/D16）：
 *  用户从浏览器 F12 复制目标域请求的整条 Cookie 请求头粘入一个框，
 *  适配器自行校验必需 cookie 名并解析中间量（csrf / userId 等），不要求用户找第二样东西。 */

/** 容错清洗：容忍 "Cookie:" 前缀、首尾引号与空白；整串原样保留（直接作后续请求的 Cookie 头）。 */
export function normalizeCookieHeader(raw: string): string {
	return raw
		.trim()
		.replace(/^cookie:\s*/i, "")
		.trim()
		.replace(/^["']|["']$/g, "")
		.trim();
}

/** 整串里取指定 cookie 名的值（值可含 = 号，如 JWT）；缺省 undefined。 */
export function cookieHeaderValue(raw: string, name: string): string | undefined {
	for (const pair of raw.split(";")) {
		const trimmed = pair.trim();
		if (trimmed.startsWith(`${name}=`)) {
			const value = trimmed.slice(name.length + 1);
			return value ? value : undefined;
		}
	}
	return undefined;
}
