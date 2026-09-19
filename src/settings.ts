import { App, Notice, PluginSettingTab, Setting, Modal } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter, listAdapters } from "./adapters";
import { STR } from "./strings";

export class QuotaSettingTab extends PluginSettingTab {
	plugin: AiCodingplanCheckPlugin;

	constructor(app: App, plugin: AiCodingplanCheckPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName(STR.settingsHeading).setHeading();

		new Setting(containerEl)
			.setName(STR.addAccount)
			.addButton((button) =>
				button
					.setButtonText(STR.addAccount)
					.setCta()
					.onClick(() => {
						new AddAccountModal(this.app, this.plugin, () => this.display()).open();
					}),
			);

		if (this.plugin.settings.accounts.length === 0) {
			new Setting(containerEl).setName(STR.accountEmpty);
			return;
		}

		for (const account of this.plugin.settings.accounts) {
			const adapter = getAdapter(account.provider);
			const setting = new Setting(containerEl)
				.setName(account.alias)
				.setDesc(`${adapter?.label ?? account.provider} · ${account.enabled ? "已启用" : "已停用"}`);
			setting.addToggle((toggle) =>
				toggle.setValue(account.enabled).onChange(async (value) => {
					account.enabled = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);
			setting.addButton((button) =>
				button.setIcon("trash").setTooltip(STR.delete).onClick(async () => {
					this.plugin.settings.accounts = this.plugin.settings.accounts.filter((a) => a.id !== account.id);
					// SecretStorage 公开 API 只有 set/get/list，无删除；以空串覆写即视为清除。
					this.app.secretStorage.setSecret(account.secretId, "");
					await this.plugin.saveSettings();
					this.display();
				}),
			);
		}
	}
}

/** 三步向导：选来源 → 填别名与凭证 → 测通后保存（凭证入 SecretStorage）。 */
export class AddAccountModal extends Modal {
	plugin: AiCodingplanCheckPlugin;
	onSaved: () => void;
	testing = false;

	constructor(app: App, plugin: AiCodingplanCheckPlugin, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.onSaved = onSaved;
	}

	onOpen(): void {
		const adapters = listAdapters();
		let provider = adapters[0]?.id;
		this.titleEl.setText(STR.wizardTitle);

		let alias = "";
		let credential = "";
		let saveButton: HTMLButtonElement | null = null;

		new Setting(this.contentEl)
			.setName(STR.wizardProvider)
			.addDropdown((dropdown) => {
				for (const adapter of adapters) dropdown.addOption(adapter.id, adapter.label);
				dropdown.onChange((value) => {
					provider = value as typeof provider;
				});
			});

		new Setting(this.contentEl)
			.setName(STR.wizardAlias)
			.addText((text) =>
				text.setPlaceholder(STR.wizardAliasPlaceholder).onChange((value) => {
					alias = value.trim();
				}),
			);

		const credentialSetting = new Setting(this.contentEl).setName(STR.wizardCredential);
		const refreshHint = () => {
			const adapter = provider !== undefined ? getAdapter(provider) : undefined;
			credentialSetting.setDesc(adapter?.credentialHint ?? "");
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
				button
					.setButtonText(STR.wizardTestAndSave)
					.setCta()
					.onClick(async () => {
						if (this.testing) return;
						const adapter = provider !== undefined ? getAdapter(provider) : undefined;
						if (!adapter || !credential) {
							new Notice(`${STR.wizardCredential}不能为空`);
							return;
						}
						this.testing = true;
						button.setButtonText(STR.wizardTesting);
						if (saveButton) saveButton.disabled = true;
						try {
							const snapshot = await adapter.fetchQuota(credential);
							const id = crypto.randomUUID();
							// SecretStorage ID 只允许小写字母/数字/破折号（冒号非法），用连字符前缀。
							const secretId = `account-${id}`;
							this.app.secretStorage.setSecret(secretId, credential);
							this.plugin.settings.accounts.push({
								id,
								provider: adapter.id,
								alias: alias || adapter.label,
								secretId,
								enabled: true,
							});
							await this.plugin.saveSettings();
							new Notice(
								`${STR.testOk}：${snapshot.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(" · ")}`,
								8000,
							);
							this.close();
							this.onSaved();
						} catch (error) {
							new Notice(`${STR.fetchFailedPrefix}：${describeError(error)}`, 8000);
							this.testing = false;
							button.setButtonText(STR.wizardTestAndSave);
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
