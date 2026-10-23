import type { AccountRecord, SortDir, SortKey } from "./types";

export interface AccountSortContext {
	key: SortKey;
	dir: SortDir;
	/** 查询失败 / 额度用尽待刷新：恒排到列表底部。 */
	sinking: (account: AccountRecord) => boolean;
	labelOf: (account: AccountRecord) => string;
	metricOf: (account: AccountRecord) => number | null;
}

/** 账号列表排序：异常账号（查询失败 / 额度用尽待刷新）恒沉底，正常账号组内沿用现有排序键；
 *  不稳定输入由 JS 稳定排序保持原序，不再额外维护第二套顺序。 */
export function sortAccountRows(accounts: AccountRecord[], context: AccountSortContext): AccountRecord[] {
	const sign = context.dir === "asc" ? 1 : -1;
	return [...accounts].sort((a, b) => {
		const rank = Number(context.sinking(a)) - Number(context.sinking(b));
		if (rank !== 0) return rank;
		if (context.key === "provider") {
			return sign * context.labelOf(a).localeCompare(context.labelOf(b), "zh");
		}
		const va = context.metricOf(a);
		const vb = context.metricOf(b);
		if (va === null && vb === null) return 0;
		if (va === null) return 1;
		if (vb === null) return -1;
		return sign * (va - vb);
	});
}
