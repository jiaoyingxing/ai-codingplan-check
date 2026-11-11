import type { AccountRecord, QuotaSnapshot } from "./types";

/** 套餐周期存档（§v1.13，20261105 用户拍板先只存不显示）：
 *  订阅结束后厂商接口查不到历史周期（CC history/invoices 均 404），只能在还查得到时存档。
 *  只有快照里数据源明确给出的 planPeriodEnd 才收（现役 = Command Code / MiMo 的 currentPeriodEnd），
 *  滚动窗口重置时间不冒充到期日；无该字段时不动存档、不下结论。 */

/** 从快照组里取第一份带真实周期结束时刻的读数；没有返回 null（多套餐现役至多一份，将来有需要再扩）。 */
export function observedPlanPeriod(snapshots: QuotaSnapshot[]): { name?: string; periodEnd: number } | null {
	for (const snapshot of snapshots) {
		if (typeof snapshot.planPeriodEnd === "number" && Number.isFinite(snapshot.planPeriodEnd) && snapshot.planPeriodEnd > 0) {
			return { ...(snapshot.planName ? { name: snapshot.planName } : {}), periodEnd: snapshot.planPeriodEnd };
		}
	}
	return null;
}

/** 把本次观察到的周期存进账号；与已存档完全一致时不改写（返回 false，避免每次刷新都写盘）。
 *  重新订阅 = 新周期覆盖旧档；直接改传入对象，调用方负责 saveSettings。 */
export function updateLastPlan(account: AccountRecord, snapshots: QuotaSnapshot[], now: number): boolean {
	const observed = observedPlanPeriod(snapshots);
	if (!observed) return false;
	const stored = account.lastPlan;
	if (stored && stored.periodEnd === observed.periodEnd && stored.name === observed.name) return false;
	account.lastPlan = { ...observed, observedAt: now };
	return true;
}
