import { Plugin } from "obsidian";
import { getAdapter } from "./adapters";
import { QuotaStore } from "./quota-store";
import { QuotaSettingTab, AccountModal } from "./settings";
import { STR } from "./strings";
import { VIEW_TYPE_QUOTA_PANEL, QuotaView } from "./view";
import { encryptSecret } from "./secret-crypto";
import {
	DEFAULT_SETTINGS,
	normalizeAccounts,
	normalizeSort,
	type AccountRecord,
	type PluginSettings,
} from "./types";

export default class AiCodingplanCheckPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	/** 导出口令（内存缓存，解密/重加密用；永不持久化、不进日志）。 */
	sessionPassphrase: string | null = null;
	/** 插件级额度快照缓存（§v1.3）：面板与设置页共用，首次查询后两处同步可见。 */
	quotaStore = new QuotaStore(async (account, secret) => {
		const adapter = getAdapter(account.provider);
		if (!adapter) throw new Error(STR.unknownProvider);
		return adapter.fetchQuota(secret);
	});

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerView(VIEW_TYPE_QUOTA_PANEL, (leaf) => new QuotaView(leaf, this));
		this.addSettingTab(new QuotaSettingTab(this.app, this));
		this.addRibbonIcon("gauge", STR.ribbonTooltip, () => void this.activateView());
		this.addCommand({
			id: "open-quota-panel",
			name: STR.commandOpen,
			callback: () => void this.activateView(),
		});
		// 清理未发布开发版遗留：钥匙串口令与死字段（发布版口令只在本会话内存）。
		if (this.app.secretStorage.getSecret("export-passphrase")) {
			this.app.secretStorage.setSecret("export-passphrase", "");
		}
		delete (this.settings as Partial<PluginSettings> & Record<string, unknown>).exportEnabled;
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

	/** 生成/更新全部账号的加密副本（设置口令即启用；传 null 清除副本即停用）。 */
	async setMobileSyncPassphrase(passphrase: string | null): Promise<void> {
		for (const account of this.settings.accounts) {
			if (passphrase === null) {
				delete account.encSecret;
				continue;
			}
			const secret = this.app.secretStorage.getSecret(account.secretId);
			if (secret) account.encSecret = await encryptSecret(secret, passphrase);
		}
		this.sessionPassphrase = passphrase;
		await this.saveSettings();
	}

	/** 凭证变化后重加密该账号副本（仅当本会话已知口令；未知时由调用方失效化处理）。 */
	async refreshEncryptedSecret(account: AccountRecord, secret: string): Promise<void> {
		if (!this.sessionPassphrase) return;
		account.encSecret = await encryptSecret(secret, this.sessionPassphrase);
		await this.saveSettings();
	}

	/** 从磁盘补读缺失的密文副本（只填空、不写盘）：同步可能晚于插件启动，
	 *  接收设备打开面板时给本机无副本的已知账号补上 encSecret，避免把"尚未同步到"当成"没有可还原副本"。
	 *  不追加磁盘上的新账号、不覆盖已有副本、不做任何跨设备对账。 */
	private async mergeCopiesFromDisk(accountId?: string): Promise<number> {
		let filled = 0;
		try {
			const data = (await this.loadData()) as Partial<PluginSettings> | null;
			for (const fresh of data?.accounts ?? []) {
				if (accountId && fresh.id !== accountId) continue;
				if (!fresh.encSecret) continue;
				const account = this.settings.accounts.find((item) => item.id === fresh.id);
				if (account && !account.encSecret) {
					account.encSecret = fresh.encSecret;
					filled += 1;
				}
			}
		} catch (error) {
			console.warn("[ai-codingplan-check] 读取加密副本失败：", error);
		}
		return filled;
	}

	/** 面板缺副本时补读该账号并返回（只补内存，不落盘）。 */
	async refreshAccountCopy(accountId: string): Promise<string | undefined> {
		const account = this.settings.accounts.find((item) => item.id === accountId);
		if (!account) return undefined;
		if (!account.encSecret) await this.mergeCopiesFromDisk(accountId);
		return account.encSecret;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginSettings> | null;
		// accounts / sort 单独收敛：旧 data.json 缺字段或值被手改坏时，不把损坏形态直接喂给面板。
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			accounts: normalizeAccounts(data?.accounts),
			sort: normalizeSort(data?.sort),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
