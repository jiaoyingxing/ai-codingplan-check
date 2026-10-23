import type { QuotaSnapshot, QuotaWindow } from "./types";

/** 窗口摘要：折叠行阻断提示用的窗口视图（只保留定位与重置时刻，阻断判断由 isWindowBlocked 现算）。 */
export interface WindowSummary {
	key: string;
	label: string;
	resetsAt: number | null;
}

export interface QuotaSummary {
	/** 折叠行总额度所代表的那份计划的**末位窗口**已满：行尾照旧显示 100%。 */
	totalBlocked: boolean;
	/** 同一份计划里排在末位之前的窗口已满：行尾只显示时钟回退图标（不报窗口/天数）。 */
	shortBlocked: WindowSummary | null;
	/** 现有总额度口径：各套餐末位窗口已用 %，多套餐取最小值；无窗口为 null（余额型）。 */
	total: number | null;
	/** 余额型核心余额（首个非空）。 */
	balance: string | null;
}

export function isWindowBlocked(window: Pick<QuotaWindow, "usedPercent" | "rateLimited">): boolean {
	return window.rateLimited || window.usedPercent >= 100;
}

function toSummary(window: QuotaWindow): WindowSummary {
	return {
		key: window.key,
		label: window.label,
		resetsAt: window.resetsAt,
	};
}

/** 多个阻断短窗口中取已知重置最晚者；全部未知时取首个（只用于标签，不展示时间）。 */
function pickLatest(windows: WindowSummary[]): WindowSummary | null {
	let best: WindowSummary | null = null;
	for (const window of windows) {
		if (window.resetsAt === null) continue;
		if (best === null || window.resetsAt > (best.resetsAt ?? 0)) best = window;
	}
	return best ?? windows[0] ?? null;
}

export function summarizeQuota(snapshots: QuotaSnapshot[]): QuotaSummary {
	// 折叠行总额度代表"末位窗口已用最小"的那份计划（多套餐取剩余最多者）。
	// 阻断判断只跟这份计划走：另一份套餐的月窗满，不能把整行误报成 100%。
	let representative: QuotaSnapshot | null = null;
	let total: number | null = null;
	for (const snapshot of snapshots) {
		if (snapshot.windows.length === 0) continue;
		const last = snapshot.windows[snapshot.windows.length - 1];
		const pct = Math.max(0, Math.min(last.usedPercent, 100));
		if (total === null || pct < total) {
			total = pct;
			representative = snapshot;
		}
	}

	let totalBlocked = false;
	let shortBlocked: WindowSummary | null = null;
	if (representative) {
		const lastIndex = representative.windows.length - 1;
		totalBlocked = isWindowBlocked(representative.windows[lastIndex]);
		shortBlocked = pickLatest(
			representative.windows
				.slice(0, lastIndex)
				.filter(isWindowBlocked)
				.map(toSummary),
		);
	}

	const balance = snapshots.find((snapshot) => snapshot.coreBalance)?.coreBalance ?? null;
	return { totalBlocked, shortBlocked, total, balance };
}
