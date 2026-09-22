import { Plugin } from "obsidian";
import { QuotaSettingTab, AccountModal } from "./settings";
import { STR } from "./strings";
import { VIEW_TYPE_QUOTA_PANEL, QuotaView } from "./view";
import { encryptSecret } from "./secret-crypto";
import { DEFAULT_SETTINGS, normalizeSort, type AccountRecord, type PluginSettings } from "./types";

export default class AiCodingplanCheckPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	/** 导出口令（内存缓存，解密/重加密用；永不持久化、不进日志）。 */
	sessionPassphrase: string | null = null;

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

	getSecret(account: AccountRecord): string | null {
		return this.app.secretStorage.getSecret(account.secretId);
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

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginSettings> | null;
		// sort 单独收敛（其余字段仍走浅合并）：旧 data.json 无此字段，值也可能被手改坏。
		this.settings = { ...DEFAULT_SETTINGS, ...data, sort: normalizeSort(data?.sort) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
