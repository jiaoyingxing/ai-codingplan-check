import { Plugin } from "obsidian";
import { getAdapter } from "./adapters";
import { updateLastPlan } from "./plan-record";
import { QuotaStore } from "./quota-store";
import {
	AccountModal,
	MobileUnlockModal,
	QuotaSettingTab,
} from "./settings";
import { STR } from "./strings";
import { VIEW_TYPE_QUOTA_PANEL, QuotaView } from "./view";
import { encryptSecret } from "./secret-crypto";
import {
	fingerprintCopy,
	initialExportEnabled,
	nextCopyGeneration,
	shouldDemoteExporter,
	shouldImportCopy,
} from "./device-sync";
import {
	DEFAULT_SETTINGS,
	normalizeAccounts,
	normalizeDevices,
	normalizeSort,
	type AccountRecord,
	type DeviceRecord,
	type PluginSettings,
	type QuotaSnapshot,
} from "./types";

/** 本机设备 ID 的 localStorage key（vault 级、设备本地；不随 data.json 同步）。 */
const DEVICE_ID_KEY = "ai-codingplan-check:device-id";

export default class AiCodingplanCheckPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	/** 导出口令（内存缓存，解密/重加密用；永不持久化、不进日志）。 */
	sessionPassphrase: string | null = null;
	/** 插件级额度快照缓存（§v1.3）：面板与设置页共用，首次查询后两处同步可见。 */
	quotaStore = new QuotaStore(
		async (account, secret) => {
			const adapter = getAdapter(account.provider);
			if (!adapter) throw new Error(STR.unknownProvider);
			return adapter.fetchQuota(secret);
		},
		(account, snapshots) => void this.recordLastPlan(account.id, snapshots),
	);
	/** 本机设备 ID：只在本机 localStorage 持久化，用于区分导出方 / 接收方。 */
	private deviceId: string | null = null;
	/** 并发账号共用一次「输入导出口令」弹框（§v1.12 单飞）。 */
	private unlockPromise: Promise<string | null> | null = null;
	/** data.json 写入串行化：接收方并发覆盖导入时避免写入乱序。 */
	private saveChain: Promise<void> = Promise.resolve();

	async onload(): Promise<void> {
		await this.loadSettings();
		// 清理未发布开发版遗留：钥匙串口令与死字段（发布版口令只在本会话内存）。
		if (this.app.secretStorage.getSecret("export-passphrase")) {
			this.app.secretStorage.setSecret("export-passphrase", "");
		}
		delete (this.settings as Partial<PluginSettings> & Record<string, unknown>).exportEnabled;
		await this.initDeviceState();
		this.registerView(VIEW_TYPE_QUOTA_PANEL, (leaf) => new QuotaView(leaf, this));
		this.addSettingTab(new QuotaSettingTab(this.app, this));
		this.addRibbonIcon("gauge", STR.ribbonTooltip, () => void this.activateView());
		this.addCommand({
			id: "open-quota-panel",
			name: STR.commandOpen,
			callback: () => void this.activateView(),
		});
	}

	/** 打开/聚焦额度面板主页（固定左侧栏，EasySync activateView 口径：已有 leaf 则聚焦，不叠开）。 */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_QUOTA_PANEL);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeftLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_QUOTA_PANEL, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** 添加/编辑账号共用入口（传 account 即编辑；onSaved 供局部刷新回调）。 */
	openAccountWizard(onSaved?: () => void, account?: AccountRecord): void {
		new AccountModal(this.app, this, onSaved, account).open();
	}

	/** 设置窗口不在公开类型里，用窄类型投影访问（同 easy-sync openPluginSettings 惯例）。 */
	openPluginSettings(): void {
		const setting = (this.app as unknown as {
			setting?: { open: () => void; openTabById: (id: string) => void };
		}).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	/** 本机设备条目（只由本机维护；其他设备的条目原样保留用于对账）。 */
	private ownDevice(): DeviceRecord | undefined {
		if (!this.deviceId) return undefined;
		return this.settings.devices.find((device) => device.id === this.deviceId);
	}

	/** 本机是否为导出方（未开启导出 = 接收方，用户拍板 20261105）。 */
	isExportDevice(): boolean {
		return this.ownDevice()?.exportEnabled === true;
	}

	/** 初始化设备身份并做升级识别 / 单导出方仲裁。
	 *  升级迁移：老 data.json 没有 devices 字段，无法直接知道哪台设备开过导出；
	 *  以「本机对全部有副本的账号都存有明文，且没有其他导出方」判为导出方，否则接收方。 */
	private async initDeviceState(): Promise<void> {
		const id = this.getOrCreateDeviceId();
		const now = Date.now();
		let changed = false;
		let own = this.settings.devices.find((device) => device.id === id);
		const copiedAccounts = this.settings.accounts.filter((account) => account.encSecret);
		if (!own) {
			const allLocalPlaintext =
				copiedAccounts.length > 0 &&
				copiedAccounts.every((account) =>
					Boolean(this.app.secretStorage.getSecret(account.secretId)),
				);
			const otherExporterExists = this.settings.devices.some((device) => device.exportEnabled);
			own = {
				id,
				exportEnabled: initialExportEnabled(
					copiedAccounts.length,
					allLocalPlaintext,
					otherExporterExists,
				),
				copyGeneration: 0,
				imported: {},
				updatedAt: now,
			};
			this.settings.devices.push(own);
			changed = true;
		}
		const others = this.settings.devices.filter((device) => device.id !== id);
		if (shouldDemoteExporter(own, others, copiedAccounts.length)) {
			own.exportEnabled = false;
			own.copyGeneration = 0;
			own.updatedAt = now;
			changed = true;
		}
		if (changed) await this.saveSettings();
	}

	/** 取得本机设备 ID：优先本机 localStorage（vault 级、不随 data.json 同步）；缺失时生成并落盘。 */
	private getOrCreateDeviceId(): string {
		if (this.deviceId) return this.deviceId;
		try {
			const stored = this.app.loadLocalStorage(DEVICE_ID_KEY) as unknown;
			if (typeof stored === "string" && stored.length > 0) {
				this.deviceId = stored;
				return stored;
			}
		} catch (error) {
			console.warn("[ai-codingplan-check] 读取本机设备 ID 失败：", error);
		}
		const id = crypto.randomUUID();
		this.deviceId = id;
		try {
			this.app.saveLocalStorage(DEVICE_ID_KEY, id);
		} catch (error) {
			console.warn("[ai-codingplan-check] 保存本机设备 ID 失败：", error);
		}
		return id;
	}

	/** 单飞口令框：多个账号同时需要解锁时只弹一次，共用同一结果。
	 *  取消/关闭返回 null；成功与否由调用方解密验证（口令在验证通过前不算已确认）。 */
	async requestUnlockPassphrase(): Promise<string | null> {
		if (this.sessionPassphrase) return this.sessionPassphrase;
		if (!this.unlockPromise) {
			this.unlockPromise = new MobileUnlockModal(this.app)
				.awaitPassphrase()
				.finally(() => {
					this.unlockPromise = null;
				});
		}
		return this.unlockPromise;
	}

	/** 覆盖式导入判定：有副本且本机无明文 → 导入；接收方副本指纹变化 → 覆盖；导出方有明文 → 不覆盖。 */
	async needsCopyImport(
		account: AccountRecord,
		hasLocalSecret: boolean,
		copy = account.encSecret,
	): Promise<boolean> {
		if (!copy) return false;
		// 导出方有明文时是副本来源，连指纹都不用算。
		if (hasLocalSecret && this.isExportDevice()) return false;
		const imported = this.ownDevice()?.imported[account.id];
		return shouldImportCopy({
			isExporter: this.isExportDevice(),
			hasLocalSecret,
			copyFingerprint: await fingerprintCopy(copy),
			importedFingerprint: imported,
		});
	}

	/** 记下本机已导入的副本指纹（覆盖式导入成功后调用；copy 必须是本次真正解密的那份副本）。 */
	async noteCopyImported(account: AccountRecord, copy: string): Promise<void> {
		const own = this.ownDevice();
		if (!own) return;
		own.imported[account.id] = await fingerprintCopy(copy);
		own.updatedAt = Date.now();
		await this.saveSettings();
	}

	/** 从磁盘同步副本（覆盖式导入的输入侧）：
	 *  接收方以 data.json 为准——副本变化就覆盖内存、副本消失就清掉；
	 *  导出方是副本来源——只补空，不覆盖自己内存里的副本。
	 *  只补内存、不写盘、不追加磁盘上的新账号、不回收被删账号（与 §v1.10 边界一致）。 */
	async syncCopiesFromDisk(): Promise<void> {
		let data: Partial<PluginSettings> | null;
		try {
			data = (await this.loadData()) as Partial<PluginSettings> | null;
		} catch (error) {
			console.warn("[ai-codingplan-check] 读取加密副本失败：", error);
			return;
		}
		if (!data || !Array.isArray(data.accounts)) return;
		// 空账号表可能是同步中间态：不拿它清空本机副本。
		if (data.accounts.length === 0 && this.settings.accounts.length > 0) return;
		const fresh = new Map(data.accounts.map((account) => [account.id, account]));
		const exporter = this.isExportDevice();
		for (const account of this.settings.accounts) {
			const copy = fresh.get(account.id)?.encSecret;
			if (exporter) {
				if (!account.encSecret && copy) account.encSecret = copy;
			} else if (copy) {
				if (account.encSecret !== copy) account.encSecret = copy;
			} else if (account.encSecret) {
				delete account.encSecret;
			}
		}
	}

	/** 生成/更新全部账号的加密副本（设置口令即成为导出方；传 null 清除副本并让所有设备降为接收方）。
	 *  全量重建：先清旧副本再按本机明文加密，保证整套副本同一口令；
	 *  没有本机明文的账号不会留下旧口令副本，也不额外提示。 */
	async setMobileSyncPassphrase(passphrase: string | null): Promise<void> {
		const own = this.ownDevice();
		const now = Date.now();
		if (passphrase === null) {
			for (const account of this.settings.accounts) delete account.encSecret;
			for (const device of this.settings.devices) {
				device.exportEnabled = false;
				device.copyGeneration = 0;
				device.updatedAt = now;
			}
			this.sessionPassphrase = null;
			await this.saveSettings();
			return;
		}
		for (const account of this.settings.accounts) delete account.encSecret;
		for (const account of this.settings.accounts) {
			const secret = this.app.secretStorage.getSecret(account.secretId);
			if (secret) account.encSecret = await encryptSecret(secret, passphrase);
		}
		this.sessionPassphrase = passphrase;
		if (own) {
			const generation = nextCopyGeneration(this.settings.devices);
			for (const device of this.settings.devices) {
				device.exportEnabled = device.id === own.id;
				device.copyGeneration = device.id === own.id ? generation : 0;
				device.updatedAt = now;
			}
			own.imported = {};
			for (const account of this.settings.accounts) {
				if (account.encSecret) {
					own.imported[account.id] = await fingerprintCopy(account.encSecret);
				}
			}
		}
		await this.saveSettings();
	}

	/** 凭证变化后重加密该账号副本：只有导出方且本会话已知口令时才写；
	 *  接收方只改本机凭证，不碰共享副本（返回 false 由调用方提示）。 */
	async refreshEncryptedSecret(account: AccountRecord, secret: string): Promise<boolean> {
		if (!this.sessionPassphrase || !this.isExportDevice()) return false;
		account.encSecret = await encryptSecret(secret, this.sessionPassphrase);
		const own = this.ownDevice();
		if (own) {
			own.imported[account.id] = await fingerprintCopy(account.encSecret);
			own.updatedAt = Date.now();
		}
		await this.saveSettings();
		return true;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginSettings> | null;
		// accounts / sort / devices 单独收敛：旧 data.json 缺字段或值被手改坏时，不把损坏形态直接喂给面板。
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			accounts: normalizeAccounts(data?.accounts),
			sort: normalizeSort(data?.sort),
			devices: normalizeDevices(data?.devices),
		};
	}

	/** 保存插件数据；写入串行化，避免并发导入时后发先至把设备指纹写丢。 */
	async saveSettings(): Promise<void> {
		const run = this.saveChain.then(() => this.saveData(this.settings));
		this.saveChain = run.catch(() => undefined);
		return run;
	}

	/** 查询成功后的套餐周期存档（§v1.13）：变化才写盘；存档失败不影响查询与面板。 */
	private async recordLastPlan(accountId: string, snapshots: QuotaSnapshot[]): Promise<void> {
		try {
			const account = this.settings.accounts.find((entry) => entry.id === accountId);
			if (!account) return;
			if (!updateLastPlan(account, snapshots, Date.now())) return;
			await this.saveSettings();
		} catch (error) {
			console.warn("[ai-codingplan-check] 记录套餐周期存档失败：", error);
		}
	}
}
