// 数据模型：账号 = 一份凭证 + 它查出的套餐快照（docs/core/PROJECT_CONTEXT.md）

export type ProviderId = "opencode-go" | "commandcode";

/** data.json 里持久化的账号记录；凭证本体在 SecretStorage，不落 data.json。 */
export interface AccountRecord {
	id: string;
	provider: ProviderId;
	alias: string;
	/** SecretStorage 中的 secret id，形如 `account-<id>`（ID 仅允许小写字母/数字/破折号）。 */
	secretId: string;
	enabled: boolean;
}

/** 一条额度窗口：三家共同的"已用百分比 + 重置时间"形状。 */
export interface QuotaWindow {
	/** 窗口标识，如 rolling / weekly / monthly。 */
	key: string;
	/** 显示名，如 近5小时 / 近一周 / 近一月。 */
	label: string;
	/** 0-100，已用份额。 */
	usedPercent: number;
	/** 窗口重置时刻（epoch ms），未知为 null。 */
	resetsAt: number | null;
	rateLimited: boolean;
}

export interface QuotaExtra {
	label: string;
	value: string;
}

/** 一次查询的套餐快照；windows 期望按 5h/周/月固定顺序。 */
export interface QuotaSnapshot {
	planName?: string;
	windows: QuotaWindow[];
	extras: QuotaExtra[];
	capturedAt: number;
}

/** 厂商适配器：新增厂商 = 新增一个实现 + 在 adapters/index.ts 注册一行。 */
export interface ProviderAdapter {
	id: ProviderId;
	label: string;
	/** 凭证输入框的标签，如 API Key / AK+SK。 */
	credentialLabel: string;
	/** 凭证输入框的说明。 */
	credentialHint: string;
	fetchQuota(secret: string): Promise<QuotaSnapshot>;
}

export interface PluginSettings {
	accounts: AccountRecord[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
	accounts: [],
};
