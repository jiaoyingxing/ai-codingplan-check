import { App, Modal, Notice, PluginSettingTab, Setting, SettingGroup, TextComponent } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter, listAdapters } from "./adapters";
import { STR } from "./strings";
import type { AccountRecord, ProviderAdapter, ProviderId } from "./types";

export class QuotaSettingTab extends PluginSettingTab {
	plugin: AiCodingplanCheckPlugin;
	private accountGroup: SettingGroup | null = null;
	/** 凭证导出组：开关/更新副本后局部重绘只清 listEl 重建行，不叠组、不动整页。 */
	private syncGroup: SettingGroup | null = null;
	constructor(app: App, plugin: AiCodingplanCheckPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// SettingGroup（1.11.0+）：宽模块分组节奏；列表区局部重绘不整页重建。
		// 账号组无外侧标题（用户拍板 20260920）：首行内部标题即身份，避免顶部重复一层。
		this.accountGroup = new SettingGroup(containerEl);
		this.renderAccounts();
		this.renderMobileSync();
	}

	/** 凭证导出组（20260920 三次拍板：弃用「同步」一词）：独立模块带外侧标题；
	 *  行1 开关承载开/关（开→导出口令弹窗，取消回弹；关→清副本，可逆免确认）；
	 *  行2 口令行仅在开启后出现，承接换口令与补副本。 */
	private renderMobileSync(): void {
		if (!this.syncGroup || !this.syncGroup.listEl.isConnected) {
			this.syncGroup = new SettingGroup(this.containerEl);
		}
		const group = this.syncGroup;
		group.listEl.empty();
		group.setHeading(STR.exportHeading);
		const copiedCount = this.plugin.settings.accounts.filter((a) => a.encSecret).length;
		const enabled = copiedCount > 0;
		group.addSetting((setting) => {
			setting
				.setName(STR.exportCopyName)
				.setDesc(enabled ? STR.exportDescOn.replace("{n}", String(copiedCount)) : STR.exportDescOff)
				.addToggle((toggle) =>
					toggle.setValue(enabled).onChange((value) => {
						void (async () => {
							if (value) {
								const passphrase = await new SyncPassphraseModal(this.app).awaitPassphrase();
								if (!passphrase) {
									this.renderMobileSync();
									return;
								}
								try {
									await this.plugin.setMobileSyncPassphrase(passphrase);
									new Notice(STR.exportDone);
								} catch (error) {
									new Notice(`${STR.fetchFailedPrefix}：${describeError(error)}`, 8000);
								}
							} else {
								// 关闭可逆（重新输口令即恢复），无需确认。
								await this.plugin.setMobileSyncPassphrase(null);
								new Notice(STR.exportDisabled);
							}
							this.renderMobileSync();
						})();
					}),
				);
		});
		if (!enabled) return;
		let passphrase = "";
		group.addSetting((setting) => {
			setting
				.setName(STR.exportPassName)
				.setDesc(STR.exportPassDesc)
				.addText((text) => {
					text.inputEl.type = "password";
					text.setPlaceholder(STR.exportPlaceholder).onChange((value) => {
						passphrase = value.trim();
					});
				})
				.addButton((button) => {
					button.setButtonText(STR.exportUpdate).setCta();
					button.onClick(() => {
						void (async () => {
							if (passphrase.length < 8) {
								new Notice(STR.exportTooShort);
								return;
							}
							button.buttonEl.disabled = true;
							try {
								await this.plugin.setMobileSyncPassphrase(passphrase);
								new Notice(STR.exportUpdated);
								this.renderMobileSync();
							} catch (error) {
								new Notice(`${STR.fetchFailedPrefix}：${describeError(error)}`, 8000);
							} finally {
								button.buttonEl.disabled = false;
							}
						})();
					});
				});
		});
	}

	/** 账号组局部重绘：添加/编辑/删除只重建本组列表，不动整页。 */
	private renderAccounts(): void {
		const group = this.accountGroup;
		if (!group) return;
		group.listEl.empty();
		// 首行内部标题保留（用户拍板 20260920）：外侧组标题已去，行名即区块身份。
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
			group.addSetting((setting) => {
				// 开关即状态显示，desc 只留厂商；控件顺序：编辑、删除、开关（用户拍板）。
				setting.setName(account.alias).setDesc(adapter?.label ?? account.provider);
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
				setting.addToggle((toggle) =>
					toggle.setValue(account.enabled).onChange((value) => {
						void (async () => {
							account.enabled = value;
							await this.plugin.saveSettings();
						})();
					}),
				);
			});
		}
	}
}

/** 带眼睛切换的密钥输入行：眼睛在输入框左侧（用户拍板），value 存真实值、掩码靠 type=password。 */
function addSecretField(setting: Setting, initialValue: string): { getValue: () => string } {
	let value = initialValue;
	let revealed = false;
	let text: TextComponent | null = null;
	setting.addExtraButton((button) =>
		button.setIcon("eye").setTooltip(STR.revealKey).onClick(() => {
			revealed = !revealed;
			if (text) text.inputEl.type = revealed ? "text" : "password";
			button.setIcon(revealed ? "eye-off" : "eye");
		}),
	);
	setting.addText((t) => {
		text = t;
		t.inputEl.type = "password";
		t.setValue(initialValue);
		t.onChange((v) => {
			value = v.trim();
		});
	});
	return { getValue: () => value };
}

/** 添加/编辑账号共享表单：编辑时别名预填、凭证回填钥匙串现值（密文）、provider 只读；
 *  双凭证厂商（AK/SK）显示两个密钥框；有变化才重新测通并覆写。 */
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
		let saveButton: HTMLButtonElement | null = null;
		const saveLabel = () => (this.testing ? STR.wizardTesting : editing ? STR.wizardSave : STR.wizardTestAndSave);

		const adapterOf = (): ProviderAdapter | undefined => (provider ? getAdapter(provider) : undefined);

		const providerSetting = new Setting(this.contentEl).setName(STR.wizardProvider);
		if (editing) {
			providerSetting.setDesc((provider ? getAdapter(provider)?.label : "") ?? "");
		} else {
			providerSetting.addDropdown((dropdown) => {
				for (const adapter of adapters) dropdown.addOption(adapter.id, adapter.label);
				dropdown.onChange((value) => {
					provider = value as ProviderId;
					refreshHint();
					refreshSecond();
				});
			});
		}

		new Setting(this.contentEl).setName(STR.wizardAlias).addText((text) => {
			text.setValue(alias).setPlaceholder(STR.wizardAliasPlaceholder).onChange((value) => {
				alias = value.trim();
			});
		});

		const credentialSetting = new Setting(this.contentEl).setName(STR.wizardCredential);
		// 编辑态回填钥匙串现值：单凭证原样回填；双凭证拆 JSON 回填两框。
		const storedSecret = editing ? (this.app.secretStorage.getSecret(this.account!.secretId) ?? "") : "";
		const adapterNow = adapterOf();
		const parts = editing && adapterNow?.splitCredential ? adapterNow.splitCredential(storedSecret) : [storedSecret];
		const cred1 = addSecretField(credentialSetting, parts[0] ?? "");
		const refreshHint = () => {
			const adapter = adapterOf();
			credentialSetting.setDesc(editing ? STR.credentialEditHint : adapter?.credentialHint ?? "");
		};
		refreshHint();

		let cred2: { getValue: () => string } | null = null;
		const credential2Setting = new Setting(this.contentEl);
		const refreshSecond = () => {
			const adapter = adapterOf();
			if (adapter?.credential2) {
				credential2Setting.setName(adapter.credential2.label).setDesc(
					editing ? STR.credentialEditHint : adapter.credential2.hint,
				);
				if (!cred2) cred2 = addSecretField(credential2Setting, parts[1] ?? "");
				credential2Setting.settingEl.show();
			} else {
				credential2Setting.settingEl.hide();
			}
		};
		refreshSecond();

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(STR.wizardCancel).onClick(() => this.close()))
			.addButton((button) => {
				saveButton = button.buttonEl;
				button.setButtonText(saveLabel()).setCta().onClick(async () => {
					if (this.testing) return;
					const adapter = adapterOf();
					if (!adapter) return;
					const secondValue = cred2 ? cred2.getValue() : "";
					const stored = adapter.joinCredential
						? adapter.joinCredential(cred1.getValue(), secondValue)
						: cred1.getValue();
					const keyChanged = stored !== storedSecret;
					if (keyChanged && !stored) {
						new Notice(`${STR.wizardCredential}不能为空`);
						return;
					}
					this.testing = true;
					button.setButtonText(saveLabel());
					if (saveButton) saveButton.disabled = true;
					try {
							let testSummary = "";
							if (keyChanged) {
								const snapshots = await adapter.fetchQuota(stored);
								testSummary = snapshots
									.map((s) => s.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(" · "))
									.join(" / ");
								if (editing && this.account) {
									this.app.secretStorage.setSecret(this.account.secretId, stored);
								} else {
									// id 只生成一次：secretId 与账号记录必须指向同一把钥匙。
									const id = crypto.randomUUID();
									this.account = {
										id,
										provider: adapter.id,
										alias: alias || adapter.label,
										secretId: `account-${id}`,
										enabled: true,
									};
									this.app.secretStorage.setSecret(this.account.secretId, stored);
								}
								// 凭证变化：口令已知则重加密副本；未知则失效化（口令不可找回是特性），提示到设置重建。
								if (this.account.encSecret !== undefined) {
									if (this.plugin.sessionPassphrase) {
										await this.plugin.refreshEncryptedSecret(this.account, stored);
									} else {
										delete this.account.encSecret;
										new Notice(STR.exportStale, 6000);
									}
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

/** 导入口令框：其他设备首次查看时输入导出口令，解密插件数据中的加密副本；取消/关闭返回 null。口令只在内存流转。 */
export class MobileUnlockModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;

	constructor(app: App) {
		super(app);
	}

	/** 打开并等待口令；确认返回口令，取消/关闭返回 null。 */
	awaitPassphrase(): Promise<string | null> {
		this.open();
		return new Promise<string | null>((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.titleEl.setText(STR.unlockTitle);
		let passphrase = "";
		const setting = new Setting(this.contentEl)
			.setName(STR.unlockName)
			.setDesc(STR.unlockDesc)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder(STR.exportPlaceholder);
				text.onChange((value) => {
					passphrase = value;
				});
			});
		setting.addButton((button) =>
			button.setButtonText(STR.unlockConfirm).setCta().onClick(() => this.submit(passphrase)),
		);
		setting.controlEl.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key === "Enter") this.submit(passphrase);
		});
	}

	private submit(value: string): void {
		this.resolve?.(value.trim() || null);
		this.resolve = null;
		this.close();
	}

	onClose(): void {
		this.resolve?.(null);
		this.resolve = null;
	}
}

/** 设置导出口令框：开关打开凭证导出时输入；确认返回口令（少于 8 位拦截在本框内），取消/关闭返回 null。口令只在内存流转。 */
export class SyncPassphraseModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;

	/** 打开并等待口令；确认返回口令，取消/关闭返回 null。 */
	awaitPassphrase(): Promise<string | null> {
		this.open();
		return new Promise<string | null>((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.titleEl.setText(STR.exportPassTitle);
		let passphrase = "";
		const submit = () => {
			const value = passphrase.trim();
			if (value.length < 8) {
				new Notice(STR.exportTooShort);
				return;
			}
			this.resolve?.(value);
			this.resolve = null;
			this.close();
		};
		const setting = new Setting(this.contentEl)
			.setName(STR.exportPassName)
			.setDesc(STR.exportPassModalDesc)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder(STR.exportPlaceholder);
				text.onChange((value) => {
					passphrase = value;
				});
			});
		setting.addButton((button) => button.setButtonText(STR.exportEnable).setCta().onClick(() => submit()));
		setting.controlEl.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key === "Enter") submit();
		});
	}

	onClose(): void {
		this.resolve?.(null);
		this.resolve = null;
	}
}
