import { App, Modal, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SettingGroup, TextComponent } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter, listAdapters } from "./adapters";
import { STR } from "./strings";
import type { AccountRecord, ProviderAdapter, ProviderId, QuotaSnapshot } from "./types";

export class QuotaSettingTab extends PluginSettingTab {
	plugin: AiCodingplanCheckPlugin;
	/** 服务商筛选（20261105 用户拍板）：临时视图态——只在设置页打开期间有效，
	 *  hide() 即清零、不入 data.json；选项=已有账号的套餐来源，默认「全部」。 */
	private providerFilter: ProviderId | "all" = "all";
	private accountGroup: SettingGroup | null = null;
	/** 凭证导出组：开关/更新副本后局部重绘只清 listEl 重建行，不叠组、不动整页。 */
	private syncGroup: SettingGroup | null = null;
	constructor(app: App, plugin: AiCodingplanCheckPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		// 设置窗左栏页签图标：宿主默认隐藏第三方插件行的图标元素，由 styles.css
		// 按 data-setting-id 只放开本插件那一行（做法与姊妹插件 EasySync / Resojot 同源）。
		this.icon = "gauge";
	}

	display(): void {
		const { containerEl } = this;
		// 回落轨每次进入设置页都重建；顺带清筛选兜底（hide 已清，双保险）。
		this.providerFilter = "all";
		containerEl.empty();
		// SettingGroup（1.11.0+）：宽模块分组节奏；列表区局部重绘不整页重建。
		// mod-list（宿主 1.13+ 官方列表样式）：窄开关（桌面 34×19）+ 紧凑行高与组内边距，
		// 与宿主「页面预览」等设置页同款；移动端仍按宿主规则放大。
		// 账号组无外侧标题（用户拍板 20260920）：首行内部标题即身份，避免顶部重复一层。
		this.accountGroup = new SettingGroup(containerEl).addClass("mod-list");
		this.renderAccounts();
		this.renderMobileSync();
	}

	/** 退出设置页（切走或关闭）即清筛选（20261105 拍板：不长期保持）；宿主在设置页不可见时调用。 */
	override hide(): void {
		super.hide();
		this.providerFilter = "all";
		// 声明式轨道宿主再进入时只重渲染已捕获的 settingItems，不重取定义——
		// hide 清了状态而定义没跟上，回来会停在筛选后的旧行（宿主 eval 实证）。
		// 就地 update() 重取，让下次进入直接是「全部」；回落轨由 display() 重建兜底。
		if (this.isDeclarativeTrack()) this.rerenderTrack();
	}

	/**
	 * 声明式设置定义（Obsidian ≥1.13；d.ts：`getSettingDefinitions`／`update()`／
	 * `settingItems` 均 @since 1.13.0）。两组结构与 display() 回落逐行同构：
	 * 账号组（无外侧标题，同 20260920 拍板）＋凭证导出组；行文案全部取自
	 * src/strings.ts（本仓红线：用户可见文案只改 strings）。条件行（口令行）
	 * 随定义数组按当前状态出现/消失，状态变化经 update() 重估。
	 * 账号组带 cls: "mod-list"：与回落轨 addClass("mod-list") 同口径，走宿主
	 * 紧凑列表样式（桌面窄开关 + 窄行距；移动端由宿主规则自行放大）。
	 * 凭证导出组保持常规组样式（用户只要求账号列表收窄，20261107 拍板）。
	 */
	override getSettingDefinitions(): SettingDefinitionItem[] {
		const copiedCount = this.plugin.settings.accounts.filter((a) => a.encSecret).length;
		const exportEnabled = this.plugin.isExportDevice();
		const visible = this.visibleAccounts();
		// 声明式轨道宿主按 name 派生行键：同服务商多账号同名会触发 duplicate setting key，
		// 且设置页切走再回来时重绘残缺（宿主 eval 实证）。同名行补零宽空格区分——视觉零变化、
		// 搜索仍是子串匹配、trim 不吞（U+200B 属 Cf 不属空白）。回落轨无行键概念，用原名。
		// 计数按 label（= 被发出的 name）而非 provider id：将来两家适配器共用 label 时同样不撞键。
		const nameCounts = new Map<string, number>();
		const rowNameOf = (account: AccountRecord): string => {
			const label = getAdapter(account.provider)?.label ?? account.provider;
			const suffix = "\u200B".repeat(nameCounts.get(label) ?? 0);
			nameCounts.set(label, (nameCounts.get(label) ?? 0) + 1);
			return label + suffix;
		};
		return [
			{
				type: "group",
				cls: "mod-list",
				items: [
					{
						name: STR.accountsTitle,
						render: (setting) => this.configureAccountToolbar(setting),
					},
					...(visible.length === 0
						? [{ name: STR.accountEmpty }]
						: visible.map((account) => ({
							// 服务商为主行、别名为次要行（20261105 用户拍板，与旧口径互换）。
							name: rowNameOf(account),
							desc: account.alias,
							render: (setting: Setting) => this.configureAccountRow(setting, account),
						}))),
				],
			},
			{
				type: "group",
				heading: STR.exportHeading,
				items: [
					{
						name: STR.exportCopyName,
						desc: this.getExportToggleDesc(exportEnabled, copiedCount),
						render: (setting) => this.configureExportToggleRow(setting, exportEnabled),
					},
					...(exportEnabled
						? [{
							name: STR.exportPassName,
							desc: STR.exportPassDesc,
							render: (setting: Setting) => this.configureExportPassRow(setting),
						}]
						: []),
				],
			},
		];
	}

	/** 轨道判断：宿主把 getSettingDefinitions() 结果存 settingItems（@since 1.13.0，随 update() 填充）；<1.13 宿主无该字段。 */
	private isDeclarativeTrack(): boolean {
		const declarative = this as unknown as { settingItems?: unknown[] };
		return declarative.settingItems !== undefined && declarative.settingItems.length > 0;
	}

	/** 轨道感知重渲染：声明式轨道一律 update()（严禁手动 display()，会把回落形态灌进声明式 DOM）；
	 *  <1.13 回落 display()；经类型投影调更新方法（绕 obsidianmd/no-unsupported-api 静态版本缝）。 */
	private rerenderTrack(): void {
		if (this.isDeclarativeTrack()) {
			const updateTab = this as unknown as { update?: () => void };
			if (typeof updateTab.update === "function") {
				updateTab.update();
			}
			return;
		}
		this.display();
	}

	/** 声明式与回落轨的账号区刷新分叉：回落保持组内局部重绘（原实现），声明式走 update()。 */
	private refreshAccounts(): void {
		if (this.isDeclarativeTrack()) {
			this.rerenderTrack();
			return;
		}
		this.renderAccounts();
	}

	/** 同上：凭证导出组刷新分叉。 */
	private refreshMobileSync(): void {
		if (this.isDeclarativeTrack()) {
			this.rerenderTrack();
			return;
		}
		this.renderMobileSync();
	}

	/** 开关行动态 desc（定义数组与回落 builder 共用，零文案漂移）：
	 *  开关表达本机角色——开启 = 导出方；未开启且有其他设备导出的副本 = 只留一个「接收方」状态标签。 */
	private getExportToggleDesc(exportEnabled: boolean, copiedCount: number): string {
		if (exportEnabled) return STR.exportDescOn.replace("{n}", String(copiedCount));
		if (copiedCount > 0) return STR.exportDescReceive;
		return STR.exportDescOff;
	}

	/** 凭证导出组（20260920 三次拍板：弃用「同步」一词）：独立模块带外侧标题；
	 *  行1 开关承载开/关（开→导出口令弹窗，取消回弹；关→清副本，可逆免确认）；
	 *  行2 口令行仅在开启后出现，承接换口令与补副本。 */
	private renderMobileSync(): void {
		if (!this.syncGroup || !this.syncGroup.listEl.isConnected) {
			// 凭证导出组保持常规组样式（用户只要求账号列表收窄）。
			this.syncGroup = new SettingGroup(this.containerEl);
		}
		const group = this.syncGroup;
		group.listEl.empty();
		group.setHeading(STR.exportHeading);
		const copiedCount = this.plugin.settings.accounts.filter((a) => a.encSecret).length;
		const enabled = this.plugin.isExportDevice();
		group.addSetting((setting) => {
			setting
				.setName(STR.exportCopyName)
				.setDesc(this.getExportToggleDesc(enabled, copiedCount));
			this.configureExportToggleRow(setting, enabled);
		});
		if (!enabled) return;
		group.addSetting((setting) => {
			setting
				.setName(STR.exportPassName)
				.setDesc(STR.exportPassDesc);
			this.configureExportPassRow(setting);
		});
	}

	/** 导出开关行控件（两轨道共用）：开→导出口令弹窗，取消回弹；关→清副本，可逆免确认。 */
	private configureExportToggleRow(setting: Setting, enabled: boolean): void {
		setting.addToggle((toggle) =>
			toggle.setValue(enabled).onChange((value) => {
				void (async () => {
					if (value) {
						const passphrase = await new SyncPassphraseModal(this.app).awaitPassphrase();
						if (!passphrase) {
							this.refreshMobileSync();
							return;
						}
						try {
							await this.plugin.setMobileSyncPassphrase(passphrase);
							new Notice(STR.exportDone);
						} catch (error) {
							new Notice(`${STR.fetchFailedPrefix}：${describeError(error)}`, 8000);
						}
					} else {
						// 关闭可逆（重新输口令即恢复），无需确认；所有设备条目一并降为接收方。
						await this.plugin.setMobileSyncPassphrase(null);
						new Notice(STR.exportDisabled);
					}
					this.refreshMobileSync();
				})();
			}),
		);
	}

	/** 口令行控件（两轨道共用；仅开启后出现）：换口令与补副本。 */
	private configureExportPassRow(setting: Setting): void {
		let passphrase = "";
		setting.addText((text) => {
			text.inputEl.type = "password";
			text.setPlaceholder(STR.exportPlaceholder).onChange((value) => {
				passphrase = value.trim();
			});
		});
		setting.addButton((button) => {
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
						this.refreshMobileSync();
					} catch (error) {
						new Notice(`${STR.fetchFailedPrefix}：${describeError(error)}`, 8000);
					} finally {
						button.buttonEl.disabled = false;
					}
				})();
			});
		});
	}

	/** 账号组局部重绘：添加/编辑/删除只重建本组列表，不动整页。 */
	private renderAccounts(): void {
		const group = this.accountGroup;
		if (!group) return;
		group.listEl.empty();
		// 首行内部标题=性质描述（用户拍板 20260920：「已接入账号」），控件自述动作，零重复。
		group.addSetting((setting) => {
			setting.setName(STR.accountsTitle);
			this.configureAccountToolbar(setting);
		});
		const accounts = this.visibleAccounts();
		if (accounts.length === 0) {
			group.addSetting((setting) => {
				setting.setName(STR.accountEmpty);
			});
			return;
		}
		for (const account of accounts) {
			const adapter = getAdapter(account.provider);
			group.addSetting((setting) => {
				// 服务商为主行、别名为次要行（20261105 用户拍板）；开关即状态显示。
				setting.setName(adapter?.label ?? account.provider).setDesc(account.alias);
				this.configureAccountRow(setting, account);
			});
		}
	}

	/** 当前筛选下的可见账号：筛选的来源已不在账号里（如已被删光）时自动回「全部」。 */
	private visibleAccounts(): AccountRecord[] {
		const accounts = this.plugin.settings.accounts;
		if (this.providerFilter !== "all" && !accounts.some((a) => a.provider === this.providerFilter)) {
			this.providerFilter = "all";
		}
		return this.providerFilter === "all"
			? accounts
			: accounts.filter((a) => a.provider === this.providerFilter);
	}

	/** 首行控件（两轨共用）：筛选下拉在「添加账号」左侧（20261105 用户拍板）。
	 *  无账号时不渲染下拉；选项随已有账号的套餐来源即时重建，值还原当前筛选。
	 *  qk-account-toolbar 标记类：账号组虽走 mod-list 紧凑列表样式，但顶部按钮栏
	 *  必须维持常规组行的内边距与对齐（用户 20261107 拍板），由 styles.css 还原。 */
	private configureAccountToolbar(setting: Setting): void {
		setting.settingEl.addClass("qk-account-toolbar");
		const providers = [...new Set(this.plugin.settings.accounts.map((a) => a.provider))];
		if (providers.length > 0) {
			setting.addDropdown((dropdown) => {
				dropdown.addOption("all", STR.filterAll);
				for (const id of providers) dropdown.addOption(id, getAdapter(id)?.label ?? id);
				dropdown.setValue(this.providerFilter).onChange((value) => {
					this.providerFilter = value as ProviderId | "all";
					this.refreshAccounts();
				});
				dropdown.selectEl.setAttribute("aria-label", STR.filterTooltip);
			});
		}
		setting.addButton((button) =>
			button.setButtonText(STR.addAccount).setCta().onClick(() => {
				this.plugin.openAccountWizard(() => this.refreshAccounts());
			}),
		);
	}

	/** 账号行控件（两轨道共用；编辑、删除、开关顺序为用户拍板）。 */
	private configureAccountRow(setting: Setting, account: AccountRecord): void {
		setting.addExtraButton((button) =>
			button.setIcon("pencil").setTooltip(STR.edit).onClick(() => {
				new AccountModal(this.app, this.plugin, () => this.refreshAccounts(), account).open();
			}),
		);
		setting.addExtraButton((button) =>
			button.setIcon("trash").setTooltip(STR.delete).onClick(() => {
				void (async () => {
					this.plugin.settings.accounts = this.plugin.settings.accounts.filter((a) => a.id !== account.id);
					this.plugin.quotaStore.invalidate(account.id);
					// SecretStorage 公开 API 只有 set/get/list，无删除；以空串覆写即视为清除。
					this.app.secretStorage.setSecret(account.secretId, "");
					await this.plugin.saveSettings();
					this.refreshAccounts();
				})();
			}),
		);
		setting.addToggle((toggle) =>
			toggle.setValue(account.enabled).onChange((value) => {
				void (async () => {
					account.enabled = value;
					// 重新启用时丢掉旧快照，避免面板继续显示停用前的读数。
					if (value) this.plugin.quotaStore.invalidate(account.id);
					await this.plugin.saveSettings();
					this.refreshAccounts();
				})();
			}),
		);
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
					// 新建账号必须填凭证；编辑账号仅在新凭证被清空时拦截（原凭证保持不变）。
					if (editing ? keyChanged && !stored : !stored.trim()) {
						new Notice(STR.wizardCredentialEmpty);
						return;
					}
					this.testing = true;
					button.setButtonText(saveLabel());
					if (saveButton) saveButton.disabled = true;
					let testedSnapshots: QuotaSnapshot[] | null = null;
					try {
						let testSummary = "";
							if (keyChanged) {
								const snapshots = await adapter.fetchQuota(stored);
								testedSnapshots = snapshots;
								testSummary = snapshots
									.map((s) => s.coreBalance ?? s.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(" · ")) // 余额型（§v1.2）：测通摘要显核心余额
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
								// 凭证变化：导出方且本会话口令已知则重加密副本；未知则失效化并提示重建。
								// 接收方只改本机凭证，不碰导出方的共享副本，也不额外提示。
								if (this.account.encSecret !== undefined) {
									const updated = await this.plugin.refreshEncryptedSecret(this.account, stored);
									if (!updated && this.plugin.isExportDevice()) {
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
						// 测通结果直接回写共享缓存（§v1.3）：面板再次渲染时直接取到读数，无需重新查询一次。
						if (testedSnapshots) this.plugin.quotaStore.put(record.id, testedSnapshots);
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
