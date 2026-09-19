import { Plugin } from "obsidian";
import { QuotaModal } from "./modal";
import { QuotaSettingTab } from "./settings";
import { STR } from "./strings";
import { DEFAULT_SETTINGS, type AccountRecord, type PluginSettings } from "./types";

// 必须是 default 导出：Obsidian 宿主从 module.exports.default 取插件类，
// 命名导出会在加载时报 "h is not a constructor"。
export default class AiCodingplanCheckPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new QuotaSettingTab(this.app, this));
		this.addRibbonIcon("gauge", STR.ribbonTooltip, () => this.openPanel());
		this.addCommand({
			id: "open-quota-panel",
			name: STR.commandOpen,
			callback: () => this.openPanel(),
		});
	}

	openPanel(): void {
		new QuotaModal(this.app, this).open();
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
