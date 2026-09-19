import { App, Modal, Notice, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter, listAdapters } from "./adapters";
import { STR } from "./strings";
import type { AccountRecord, ProviderId } from "./types";

export class QuotaSettingTab extends PluginSettingTab {
	plugin: AiCodingplanCheckPlugin;
	private accountGroup: SettingGroup | null = null;

	constructor(app: App, plugin: AiCodingplanCheckPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// SettingGroup（1.11.0+）：宽模块分组节奏；列表区局部重绘不整页重建。
		this.accountGroup = new SettingGroup(containerEl);
		this.accountGroup.setHeading(STR.settingsHeading);
		this.renderAccounts();
	}

	/** 账号组局部重绘：添加/编辑/删除只重建本组列表，不动整页。 */
	private renderAccounts(): void {
		const group = this.accountGroup;
		if (!group) return;
		group.listEl.empty();
		group.addSetting((setting) => {
			setting.setName(STR.addAccount).addButton((button) =>
				button.setButtonText(STR.addAccount).setCta().onClick(() => {
					this.plugin.openAccountWizard(() => this.renderAccounts());
				}),
			);
		});
		const accounts = this.plugin.settings.accounts;
		if (accounts.length === 0) {
			group.addSetting((setting) => {
				setting.setName(STR.accountEmpty);
			});
			return;
		}
		for (const account of accounts) {
			const adapter = getAdapter(account.provider);
			const describe = () => `${adapter?.label ?? account.provider} · ${account.enabled ? "已启用" : "已停用"}`;
			group.addSetting((setting) => {
				setting.setName(account.alias).setDesc(describe());
				setting.addToggle((toggle) =>
					toggle.setValue(account.enabled).onChange((value) => {
						void (async () => {
							account.enabled = value;
							await this.plugin.saveSettings();
							setting.setDesc(describe());
						})();
					}),
				);
				setting.addExtraButton((button) =>
					button.setIcon("pencil").setTooltip(STR.edit).onClick(() => {
						new AccountModal(this.app, this.plugin, () => this.renderAccounts(), account).open();
					}),
				);
				setting.addExtraButton((button) =>
					button.setIcon("trash").setTooltip(STR.delete).onClick(() => {
						void (async () => {
							this.plugin.settings.accounts = this.plugin.settings.accounts.filter((a) => a.id !== account.id);
							// SecretStorage 公开 API 只有 set/get/list，无删除；以空串覆写即视为清除。
							this.app.secretStorage.setSecret(account.secretId, "");
							await this.plugin.saveSettings();
							this.renderAccounts();
						})();
					}),
				);
			});
		}
	}
}

/** 添加/编辑账号共享表单：编辑时别名预填、凭证留空不修改、provider 只读；测通才写入。 */
export class AccountModal extends Modal {
	plugin: AiCodingplanCheckPlugin;
	onSaved: (() => void) | undefined;
	account: AccountRecord | undefined;
	testing = false;

	constructor(app: App, plugin: AiCodingplanCheckPlugin, onSaved?: () => void, account?: AccountRecord) {
		super(app);
		this.plugin = plugin;
		this.onSaved = onSaved;
		this.account = account;
	}

	onOpen(): void {
		const adapters = listAdapters();
		const editing = this.account !== undefined;
		this.titleEl.setText(editing ? STR.editAccount : STR.wizardTitle);
		let provider: ProviderId | undefined = this.account?.provider ?? adapters[0]?.id;
		let alias = this.account?.alias ?? "";
		let credential = "";
		let saveButton: HTMLButtonElement | null = null;
		const saveLabel = () => (this.testing ? STR.wizardTesting : editing ? STR.wizardSave : STR.wizardTestAndSave);

		const providerSetting = new Setting(this.contentEl).setName(STR.wizardProvider);
		if (editing) {
			providerSetting.setDesc((provider ? getAdapter(provider)?.label : "") ?? "");
		} else {
			providerSetting.addDropdown((dropdown) => {
				for (const adapter of adapters) dropdown.addOption(adapter.id, adapter.label);
				dropdown.onChange((value) => {
					provider = value as ProviderId;
					refreshHint();
				});
			});
		}

		new Setting(this.contentEl).setName(STR.wizardAlias).addText((text) => {
			text.setValue(alias).setPlaceholder(STR.wizardAliasPlaceholder).onChange((value) => {
				alias = value.trim();
			});
		});

		const credentialSetting = new Setting(this.contentEl).setName(STR.wizardCredential);
		const refreshHint = () => {
			credentialSetting.setDesc(
				editing ? STR.credentialKeepHint : (provider ? getAdapter(provider)?.credentialHint : "") ?? "",
			);
		};
		refreshHint();
		credentialSetting.addText((text) => {
			text.inputEl.type = "password";
			text.onChange((value) => {
				credential = value.trim();
			});
		});

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(STR.wizardCancel).onClick(() => this.close()))
			.addButton((button) => {
				saveButton = button.buttonEl;
				button.setButtonText(saveLabel()).setCta().onClick(async () => {
					if (this.testing) return;
					const adapter = provider ? getAdapter(provider) : undefined;
					if (!adapter) return;
					const wantsNewKey = !editing || credential !== "";
					if (wantsNewKey && !credential) {
						new Notice(`${STR.wizardCredential}不能为空`);
						return;
					}
					this.testing = true;
					button.setButtonText(saveLabel());
					if (saveButton) saveButton.disabled = true;
					try {
						let testSummary = "";
						if (wantsNewKey) {
							const snapshot = await adapter.fetchQuota(credential);
							testSummary = snapshot.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(" · ");
							if (editing && this.account) {
								this.app.secretStorage.setSecret(this.account.secretId, credential);
							} else {
								const id = crypto.randomUUID();
								this.account = {
									id,
									provider: adapter.id,
									alias: alias || adapter.label,
									secretId: `account-${id}`,
									enabled: true,
								};
								this.app.secretStorage.setSecret(this.account.secretId, credential);
							}
						}
						const record = this.account!;
						record.alias = alias || adapter.label;
						if (!this.plugin.settings.accounts.includes(record)) {
							this.plugin.settings.accounts.push(record);
						}
						await this.plugin.saveSettings();
						new Notice(`${STR.savedOk}${testSummary ? `：${testSummary}` : ""}`, 6000);
						this.close();
						this.onSaved?.();
					} catch (error) {
						new Notice(`${STR.fetchFailedPrefix}：${describeError(error)}`, 8000);
						this.testing = false;
						button.setButtonText(saveLabel());
						if (saveButton) saveButton.disabled = false;
					}
				});
			});
	}
}

/** requestUrl 失败时错误消息带状态码（如 "HTTP 401"），尽量还原给用户。 */
export function describeError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}
