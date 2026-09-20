import { Plugin } from "obsidian";
import { QuotaSettingTab, AccountModal } from "./settings";
import { STR } from "./strings";
import { VIEW_TYPE_QUOTA_PANEL, QuotaView } from "./view";
import { DEFAULT_SETTINGS, type AccountRecord, type PluginSettings } from "./types";

export default class AiCodingplanCheckPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;

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

	/** 打开/聚焦额度面板主页（右侧栏常驻视图；已存在则聚焦，不叠开）。 */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_QUOTA_PANEL);
		const leaf = existing.length > 0 ? existing[0] : workspace.getRightLeaf(false);
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

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
