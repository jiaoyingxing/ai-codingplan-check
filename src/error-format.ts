/** 错误串分段：错误正文整篇红色；机器细节（HTTP 状态、code、厂商原始响应）用等宽小字呈现。 */
export interface ErrorSegment {
	text: string;
	code: boolean;
}

/** 机器细节的起点：HTTP 状态码、code 数字、JSON 对象/数组（截断片段也能识别）。 */
const TOKEN_PATTERN =
	/HTTP\s*\d{3}(?:\s*[，,]\s*[A-Za-z][\w.-]*)?|\bcode\s+\d{3,}\b|\{["{[]|\[\s*["{[]/gi;


/** 从 JSON 起点找配对的收尾位置（忽略字符串内的括号）；响应片段被 snippet 截断时返回 -1。 */
function findJsonEnd(message: string, start: number): number {
	const open = message[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < message.length; i += 1) {
		const char = message[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === open) depth += 1;
		else if (char === close) {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/** 把错误串拆成说明文字与机器细节，供面板分别着色。 */
export function splitErrorSegments(message: string): ErrorSegment[] {
	const segments: ErrorSegment[] = [];
	const token = new RegExp(TOKEN_PATTERN.source, "gi");
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = token.exec(message)) !== null) {
		const start = match.index;
		if (start > cursor) segments.push({ text: message.slice(cursor, start), code: false });
		let end = start + match[0].length;
		if (match[0].startsWith("{") || match[0].startsWith("[")) {
			const jsonEnd = findJsonEnd(message, start);
			if (jsonEnd === -1) {
				// 响应片段常被截断，技术细节一直到结尾；外层包裹的右括号仍算说明文字。
				const tail = message.endsWith("）") ? message.length - 1 : message.length;
				segments.push({ text: message.slice(start, tail), code: true });
				if (tail < message.length) segments.push({ text: message.slice(tail), code: false });
				return segments;
			}
			end = jsonEnd;
		}
		segments.push({ text: message.slice(start, end), code: true });
		cursor = end;
		token.lastIndex = end;
	}
	if (cursor < message.length) segments.push({ text: message.slice(cursor), code: false });
	return segments;
}

/** 单个响应片段排版：只改字符串外的结构标点（补空格供折行）；
 *  引号内的值原样保留，避免把时间戳 `10:41:58` 或其他正文改坏。 */
function formatErrorFragment(text: string): string {
	const out: string[] = [];
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			out.push(char);
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			out.push(char);
			continue;
		}
		out.push(char);
		if (char === "," || char === ":") {
			const next = text[i + 1];
			if (next !== undefined && /["{[\]}\-\d]/.test(next)) out.push(" ");
		}
	}
	return out.join("");
}

/** 原始响应排版：` || ` 是适配器拼接多个独立响应的硬边界（前一段常被 snippet 截断，
 *  可能停在字符串内部），因此先分段再各自排版，避免后一段被前一段的未闭合引号吞掉。 */
export function formatErrorCode(text: string): string {
	return text
		.split(/\s*\|\|\s*/)
		.map(formatErrorFragment)
		.join("\n|| ");
}
