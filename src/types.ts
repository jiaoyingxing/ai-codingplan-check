// 数据模型：账号 = 一份凭证 + 它查出的套餐快照（docs/core/PROJECT_CONTEXT.md）

export type ProviderId =
	| "opencode-go"
	| "commandcode"
	| "volcengine"
	| "volcengine-console"
	| "glm"
	| "kimi-for-coding"
	| "minimax"
	| "deepseek"
	| "siliconflow"
	| "siliconflow-cookie"
	| "moonshot"
	| "stepfun"
	| "ppio"
	| "mimo";

/** data.json 里持久化的账号记录；凭证明文在 SecretStorage（运行时唯一明文源）。
 *  encSecret 是口令加密的凭证副本（用户拍板 20260920）：随 data.json 同步到移动端，手机首次解锁后写入本地 SecretStorage。 */
export interface AccountRecord {
	id: string;
	provider: ProviderId;
	alias: string;
	/** SecretStorage 中的 secret id，形如 `account-<id>`（ID 仅允许小写字母/数字/破折号）。 */
	secretId: string;
	enabled: boolean;
	/** 同步密文（src/secret-crypto.ts 自描述 JSON）；缺省 = 未启用移动端同步或副本已失效。 */
	encSecret?: string;
	/** 最后一次查询到的套餐周期存档（§v1.13，20261105 用户拍板先只存不显示）：
	 *  订阅结束后厂商接口查不到历史周期（CC history/invoices 均 404），靠它回忆到期时间。
	 *  只有数据源明确给出的周期结束时刻才存（现役 = Command Code / MiMo 的 currentPeriodEnd），
	 *  滚动窗口重置时间不冒充到期日；重新订阅后由新周期覆盖。非凭证，随 data.json 同步。 */
	lastPlan?: { name?: string; periodEnd: number; observedAt: number };
}

/** 一条额度窗口：各厂商共同的"已用百分比 + 重置时间"形状。 */
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
	/** 次要数值列（如代金券到期日 / 张数）：与 value 分列、进对齐账本（20260930 真号反馈），缺省留在双列键值区。 */
	detail?: string;
}

/** 一次查询的套餐快照；windows 按窗口由短到长排列，末位 = 该套餐的账单周期窗口（行总用量取末位）。
 *  余额型快照（20260930 D14 / 方案单 §v1.2）：windows 为空数组，coreBalance = 展示就绪的核心余额
 *  （含货币符号、负号最前；主币种口径见各适配器文件头）——行尾槽位显金额不画条，拆分与特殊额度进 extras。 */
export interface QuotaSnapshot {
	planName?: string;
	/** 余额型核心余额（如 "¥110.00"、负值 "-¥2.50"）；缺省 = 窗口型，行尾槽位走总%口径。 */
	coreBalance?: string;
	windows: QuotaWindow[];
	extras: QuotaExtra[];
	/** 数据源明确表示当前无可用订阅 / 额度时的原因（如 CC 暂未订阅）：
	 *  展开体照常展示 extras，折叠行按不可用态灰条 + 警示图标处理；正常快照缺省。 */
	unavailableReason?: string;
	/** 数据源明确给出的订阅周期结束时刻（epoch ms，如 CC / MiMo 的 currentPeriodEnd）：
	 *  供账号周期存档（§v1.13）；只有适配器能拿到真实值时才填，缺省 = 接口没有该字段。 */
	planPeriodEnd?: number;
	capturedAt: number;
}

/** 厂商适配器：新增厂商 = 新增一个实现 + 在 adapters/index.ts 注册一行。 */
export interface ProviderAdapter {
	id: ProviderId;
	label: string;
	/** 凭证输入框的说明。 */
	credentialHint: string;
	/** 双凭证厂商（AK/SK）的第二凭证框；缺省单凭证。secret 以 joinCredential 结果存储。 */
	credential2?: { label: string; hint: string };
	/** 双凭证：把存储串拆回 [第一凭证, 第二凭证] 回填（仅在定义 credential2 时被调用）。 */
	splitCredential?: (stored: string) => [string, string];
	/** 双凭证：把两框合成存储串。 */
	joinCredential?: (first: string, second: string) => string;
	/** 查询套餐额度。一凭证多套餐（如方舟双订阅）返回多张快照，渲染为多张卡。 */
	fetchQuota(secret: string): Promise<QuotaSnapshot[]>;
}

/** 列表排序键：套餐名（provider 标签）/ 总用量 / 重置时间。 */
export type SortKey = "provider" | "usage" | "reset";
export type SortDir = "asc" | "desc";

export interface SortMode {
	key: SortKey;
	dir: SortDir;
}

/** data.json 里的设备状态（多设备对账，20261105）：
 *  id 只存在本机 localStorage，不随同步；每台设备只写自己的条目。
 *  exportEnabled = 是否导出方；未开启导出即接收方。
 *  imported 记录本机上次导入的副本指纹，用于「副本变化才导入」。
 *  条目内不含任何凭证或口令。 */
export interface DeviceRecord {
	id: string;
	exportEnabled: boolean;
	/** 该设备最近一次生成副本的代次；多设备仲裁时以最大代次为当前导出方。 */
	copyGeneration: number;
	/** 账号 id → 副本指纹（SHA-256 截断），供接收方判断是否要覆盖导入。 */
	imported: Record<string, string>;
	updatedAt: number;
}

export interface PluginSettings {
	accounts: AccountRecord[];
	/** 列表排序选择（持久化：面板 Menu 一选即存，重启与面板关开沿用）。 */
	sort: SortMode;
	/** 多设备状态（设备角色与副本导入对账）；本机只更新自己的条目。 */
	devices: DeviceRecord[];
}

export const DEFAULT_SORT: SortMode = { key: "provider", dir: "asc" };

export const DEFAULT_SETTINGS: PluginSettings = {
	accounts: [],
	sort: { ...DEFAULT_SORT },
	devices: [],
};

/** 收敛 data.json 里的排序：旧版本无此字段，也可能被手改成未知值——
 *  非法一律回默认（排序键不认识会让排序静默失效，20260920 已吃过静默失效的亏）。 */
export function normalizeSort(value: unknown): SortMode {
	const candidate = value as Partial<SortMode> | null | undefined;
	const key = candidate?.key;
	if (key !== "provider" && key !== "usage" && key !== "reset") return { ...DEFAULT_SORT };
	return { key, dir: candidate?.dir === "desc" ? "desc" : "asc" };
}

/** 收敛 data.json 里的账号数组：手改坏字段或整体非数组时不崩面板。
 *  逐项只保留 id/provider/secretId 为非空字符串的记录；alias 非字符串回空串；
 *  enabled 缺省按启用（仅显式 false 视为停用）；encSecret 只留非空字符串；同 id 保留首个；
 *  lastPlan 只留 periodEnd 为正数的存档（§v1.13），坏形整份丢弃。
 *  provider 只要求非空字符串（UI 对未知来源已有兜底），不在此校验联合类型。 */
export function normalizeAccounts(value: unknown): AccountRecord[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const accounts: AccountRecord[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as Record<string, unknown>;
		const { id, provider, secretId } = candidate;
		if (typeof id !== "string" || id.length === 0) continue;
		if (typeof provider !== "string" || provider.length === 0) continue;
		if (typeof secretId !== "string" || secretId.length === 0) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		const account: AccountRecord = {
			id,
			provider: provider as ProviderId,
			alias: typeof candidate.alias === "string" ? candidate.alias : "",
			secretId,
			enabled: candidate.enabled !== false,
		};
		if (typeof candidate.encSecret === "string" && candidate.encSecret.length > 0) {
			account.encSecret = candidate.encSecret;
		}
		const lastPlan = candidate.lastPlan as Record<string, unknown> | null | undefined;
		if (typeof lastPlan === "object" && lastPlan !== null && typeof lastPlan.periodEnd === "number" && Number.isFinite(lastPlan.periodEnd) && lastPlan.periodEnd > 0) {
			account.lastPlan = {
				periodEnd: lastPlan.periodEnd,
				observedAt: typeof lastPlan.observedAt === "number" && Number.isFinite(lastPlan.observedAt) ? lastPlan.observedAt : 0,
				...(typeof lastPlan.name === "string" && lastPlan.name.length > 0 ? { name: lastPlan.name } : {}),
			};
		}
		accounts.push(account);
	}
	return accounts;
}

/** 收敛 data.json 里的设备状态：非数组回空、坏条目丢弃、同 id 保留首个；
 *  imported 只保留「账号 id → 非空字符串指纹」，其余字段给安全默认值。
 *  这里不校验设备是否属于当前库——ID 只是随机标识，不影响凭证明文。 */
export function normalizeDevices(value: unknown): DeviceRecord[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const devices: DeviceRecord[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as Record<string, unknown>;
		const { id } = candidate;
		if (typeof id !== "string" || id.length === 0) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		const imported: Record<string, string> = {};
		if (typeof candidate.imported === "object" && candidate.imported !== null) {
			for (const [accountId, fingerprint] of Object.entries(candidate.imported)) {
				if (typeof fingerprint === "string" && fingerprint.length > 0) {
					imported[accountId] = fingerprint;
				}
			}
		}
		devices.push({
			id,
			exportEnabled: candidate.exportEnabled === true,
			copyGeneration:
				typeof candidate.copyGeneration === "number" &&
				Number.isFinite(candidate.copyGeneration) &&
				candidate.copyGeneration >= 0
					? candidate.copyGeneration
					: 0,
			imported,
			updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
		});
	}
	return devices;
}
