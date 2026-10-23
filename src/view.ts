import { ItemView, Menu, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { sortAccountRows } from "./account-sort";
import { getAdapter } from "./adapters";
import { formatErrorCode, splitErrorSegments } from "./error-format";
import { formatPercent, formatResetCountdown } from "./format";
import { summarizeQuota } from "./quota-summary";
import { STR } from "./strings";
import { decryptSecret } from "./secret-crypto";
import { MobileUnlockModal, describeError } from "./settings";
import type { AccountRecord, QuotaSnapshot, SortDir, SortKey } from "./types";

export const VIEW_TYPE_QUOTA_PANEL = "ai-codingplan-check-panel";

function providerLabel(account: AccountRecord): string {
	return getAdapter(account.provider)?.label ?? account.provider;
}

/** 额度面板主页：固定左侧栏（EasySync 口径）。账号折叠列表——
 *  行 = 服务商名 + 灰别名 + 总用量%右锚（行背景即总进度条，口径见 quota-summary）；
 *  短窗口用尽时行尾只留时钟回退图标，末位总窗口满时照旧显示 100%；
 *  展开体 = 融合单行窗口（label | 高条内嵌% | 重置时间右）。
 *  页动作在内容顶部 nav-header 固定工具行（刷新全部/排序 Menu/全部展开收起/打开设置），
 *  列表在 .qk-scroll 内独立滚动（桌面侧栏 app.css 隐藏 .view-header，addAction 不可见）；
 *  排序复用核心资源管理器模式（按钮 + Menu 弹框勾选），共享快照缓存驱动额度/重置排序；
 *  排序选择持久化在 settings.sort（唯一状态源，本视图不另存副本）。 */
export class QuotaView extends ItemView {
	plugin: AiCodingplanCheckPlugin;
	/** 账号折叠态（重绘与单账号刷新后保持；默认收起）。 */
	private expanded = new Map<string, boolean>();
	/** 行元素索引（排序时移动 DOM 节点用，不重建不重取）。 */
	private rowEls = new Map<string, HTMLDetailsElement>();
	/** 查询失败或额度用尽待刷新的账号：排序时恒沉到列表底部（用户拍板）。 */
	private sinking = new Set<string>();
	/** 展开/收起按钮引用：列表建好后与每次点击后按 DOM 重刷图标（EasySync collapseToggleButtonEl 口径）。 */
	private collapseButtonEl: HTMLButtonElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: AiCodingplanCheckPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_QUOTA_PANEL;
	}

	getDisplayText(): string {
		return STR.panelTitle;
	}

	getIcon(): string {
		return "gauge";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("qk-view");
		this.renderPanel();
	}

	async onClose(): Promise<void> {}

	/** 全量重绘（入口/页头刷新用）；单账号刷新只重建其 details 内部，折叠态不丢。
	 *  布局同核心资源管理器：内容顶部 nav-header 固定工具行（不随滚动），列表在 .qk-scroll 内独立滚动
	 *  ——桌面端 app.css 对侧栏 .view-header 直接 display:none，页动作只能放内容内。 */
	private renderPanel(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.renderToolbar(contentEl);
		const page = contentEl.createDiv("qk-scroll").createDiv("qk-page");
		const accounts = this.plugin.settings.accounts.filter((account) => account.enabled);
		if (accounts.length === 0) {
			this.renderEmptyState(page);
			return;
		}
		const list = page.createDiv("qk-list");
		this.rowEls.clear();
		this.sinking.clear();
		for (const account of this.sortAccounts(accounts)) {
			// 一凭证多套餐（如方舟双订阅）→ fetchQuota 返回多份快照、展开体内分段渲染。
			const details = list.createEl("details", "qk-account qk-card");
			details.dataset.accountId = account.id;
			// 行元素索引：applySort 移动节点全靠它（缺失则排序静默失效，20260920 实测教训）。
			this.rowEls.set(account.id, details);
			details.toggleAttribute("open", this.expanded.get(account.id) ?? false);
			details.addEventListener("toggle", () => this.expanded.set(account.id, details.open));
			this.renderRow(details.createEl("summary", "qk-row"), account);
			const body = details.createDiv("qk-account-body");
			body.createDiv({ text: STR.loading, cls: "qk-card-loading" });
			void this.fetchAndRender(account, details, body);
		}
		// 列表建好后重刷展开/收起按钮：toolbar 创建时集合为空，会误判为"全部收起"。
		this.updateCollapseToggle();
	}

	/** 工具行（核心资源管理器同款：内容内 nav-header + nav-buttons-container，aria-label 报名）。
	 *  展开/收起按钮图标随态变化（EasySync 口径）：从 DOM 推导，不维护独立状态位。 */
	private renderToolbar(container: HTMLElement): void {
		const buttons = container.createDiv("nav-header").createDiv("nav-buttons-container");
		this.createNavButton(buttons, "refresh-cw", STR.refreshAll, () => this.renderPanel());
		this.createNavButton(buttons, "arrow-up-narrow-wide", STR.sortBy, (evt) => this.showSortMenu(evt));
		this.createNavButton(buttons, "settings", STR.openSettings, () => this.plugin.openPluginSettings());
		// 展开/收起固定最右（用户拍板）：设置按钮在其左侧。
		this.collapseButtonEl = this.createNavButton(buttons, "chevrons-up-down", STR.expandAll, () => {
			const items = Array.from(this.contentEl.querySelectorAll<HTMLDetailsElement>("details.qk-account"));
			const target = items.some((item) => !item.open);
			for (const item of items) item.open = target;
			this.updateCollapseToggle();
		});
	}

	/** 从 DOM 推导展开/收起按钮的图标与报名：有收起行 → 呈现"全部展开"，全开 → 呈现"全部收起"。 */
	private updateCollapseToggle(): void {
		if (!this.collapseButtonEl) return;
		const items = Array.from(this.contentEl.querySelectorAll<HTMLDetailsElement>("details.qk-account"));
		const shouldExpand = items.some((item) => !item.open);
		setIcon(this.collapseButtonEl, shouldExpand ? "chevrons-up-down" : "chevrons-down-up");
		this.collapseButtonEl.setAttribute("aria-label", shouldExpand ? STR.expandAll : STR.collapseAll);
	}

	private createNavButton(
		container: HTMLElement,
		icon: string,
		label: string,
		onClick: (evt: MouseEvent) => void,
	): HTMLButtonElement {
		const button = container.createEl("button", {
			cls: "clickable-icon nav-action-button",
			attr: { "aria-label": label, type: "button" },
		});
		setIcon(button, icon);
		button.addEventListener("click", (evt) => onClick(evt));
		return button;
	}

	/** 折叠行：chevron + 服务商名 + 灰别名 + 总%右锚；行背景 fill 层即总进度条（宽度取数后回填）。 */
	private renderRow(summary: HTMLElement, account: AccountRecord): void {
		const icon = summary.createDiv("qk-collapse-icon");
		setIcon(icon, "chevron-right");
		const text = summary.createDiv("qk-row-text");
		text.createDiv({ text: providerLabel(account), cls: "qk-card-provider" });
		text.createDiv({ text: account.alias, cls: "qk-card-alias" });
		summary.createDiv("qk-row-fill");
		summary.createDiv("qk-row-pct");
	}

	/** 排序：异常账号（查询失败 / 额度用尽待刷新）恒沉底；正常账号组内按套餐名或缓存快照排序。
	 *  返回新数组不改设置原序；沉底标记由渲染态维护，取数完成后随 applySort 生效。 */
	private sortAccounts(accounts: AccountRecord[]): AccountRecord[] {
		const { key, dir } = this.plugin.settings.sort;
		return sortAccountRows(accounts, {
			key,
			dir,
			sinking: (account) => this.sinking.has(account.id),
			labelOf: providerLabel,
			metricOf: (account) => this.sortMetric(account),
		});
	}

	private sortMetric(account: AccountRecord): number | null {
		const snapshots = this.plugin.quotaStore.get(account.id);
		if (!snapshots || snapshots.length === 0) return null;
		if (this.plugin.settings.sort.key === "usage") {
			// 余额型（§v1.2 裁决⑤）：total 为 null 时按"无数据恒排末尾"，不参与 0% 排序。
			return summarizeQuota(snapshots).total;
		}
		const resets = snapshots
			.flatMap((s) => s.windows.map((w) => w.resetsAt))
			.filter((t): t is number => t !== null);
		return resets.length > 0 ? Math.min(...resets) : null;
	}

	/** 按当前排序键重排行 DOM：移动既有节点，不重建、不重取，展开态与进行中的请求都不受影响。 */
	private applySort(): void {
		const list = this.contentEl.querySelector<HTMLElement>(".qk-list");
		if (!list) return;
		const ordered = this.sortAccounts(this.plugin.settings.accounts.filter((a) => a.enabled));
		for (const account of ordered) {
			const el = this.rowEls.get(account.id);
			if (el) list.appendChild(el);
		}
	}

	/** 排序菜单（核心资源管理器排序按钮同款：addAction 触发 Menu，勾选当前项，同组两个方向为一对）。
	 *  选中即写 settings 持久化（重启沿用），再重排既有行。 */
	private showSortMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const current = this.plugin.settings.sort;
		const add = (label: string, key: SortKey, dir: SortDir) =>
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setChecked(current.key === key && current.dir === dir)
					.onClick(() => {
						this.plugin.settings.sort = { key, dir };
						void this.plugin.saveSettings();
						this.applySort();
					}),
			);
		add(STR.sortProviderAsc, "provider", "asc");
		add(STR.sortProviderDesc, "provider", "desc");
		menu.addSeparator();
		add(STR.sortUsageDesc, "usage", "desc");
		add(STR.sortUsageAsc, "usage", "asc");
		menu.addSeparator();
		add(STR.sortResetAsc, "reset", "asc");
		add(STR.sortResetDesc, "reset", "desc");
		menu.showAtMouseEvent(evt);
	}

	private renderEmptyState(container: HTMLElement): void {
		const empty = container.createDiv("qk-empty");
		empty.createDiv({ text: STR.noAccounts, cls: "qk-empty-text" });
		const actions = empty.createDiv("qk-empty-actions");
		const addBtn = actions.createEl("button", { text: STR.addAccount });
		addBtn.addClass("mod-cta");
		addBtn.addEventListener("click", () => this.plugin.openAccountWizard(() => this.renderPanel()));
		const settingsBtn = actions.createEl("button", { text: STR.openSettings });
		settingsBtn.addEventListener("click", () => this.plugin.openPluginSettings());
	}

	private async fetchAndRender(account: AccountRecord, details: HTMLDetailsElement, body: HTMLElement): Promise<void> {
		let secret = this.app.secretStorage.getSecret(account.secretId);
		// 同步可能晚于插件启动：内存里没有副本时先从磁盘补读一次（只填空、不写盘），
		// 否则接收设备会把"尚未同步到"当成"没有可还原副本"而不弹口令框。
		if (!secret && !account.encSecret) {
			account.encSecret = await this.plugin.refreshAccountCopy(account.id);
		}
		// 移动端回退（用户拍板 20260920）：本地保险箱无值但 data.json 有密文副本 → 口令解锁；
		// 解出即写入本地 SecretStorage，本次会话与他账号免再输；口令不对/密文损坏走错误行可重试。
		if (!secret && account.encSecret) {
			const passphrase =
				this.plugin.sessionPassphrase ?? (await new MobileUnlockModal(this.app).awaitPassphrase());
			if (passphrase) {
				try {
					secret = await decryptSecret(account.encSecret, passphrase);
					this.app.secretStorage.setSecret(account.secretId, secret);
					this.plugin.sessionPassphrase = passphrase;
				} catch {
					this.renderErrorBody(body, `${account.alias}：${STR.decryptFailed}`, account);
					return;
				}
			}
		}
		if (!secret) {
			this.renderErrorBody(body, `${account.alias}：${STR.secretMissing}`, account);
			return;
		}
		// 发起加载前同步捕获代数号：加载期间账号被删除/重新启用或向导回写，返回结果即过期。
		const generation = this.plugin.quotaStore.generation(account.id);
		try {
			// 共享缓存（§v1.3）：面板取数、向导测通回写与账号删除/重新启用时的失效共用一份缓存，
			// 同账号并发请求复用。
			const snapshots = await this.plugin.quotaStore.load(account, secret);
			// 迟到响应守卫：过期结果直接丢弃，不渲染旧读数（缓存回写同样已被 store 挡住）。
			if (!this.plugin.quotaStore.isCurrentGeneration(account.id, generation)) {
				// 只回渲染当前缓存（如向导测通 put 的新快照），过期结果绝不使用；无缓存则保持原状。
				const current = this.plugin.quotaStore.get(account.id);
				if (current) {
					this.renderAccountBody(details, body, account, current);
					this.applySort();
				}
				return;
			}
			this.renderAccountBody(details, body, account, snapshots);
			this.applySort();
		} catch (error) {
			// 过期请求的错误同样不渲染：账号已删除/重新启用，或已有更新的数据。
			if (!this.plugin.quotaStore.isCurrentGeneration(account.id, generation)) {
				// 只回渲染当前缓存（如向导测通 put 的新快照），过期错误不显示；无缓存则保持原状。
				const current = this.plugin.quotaStore.get(account.id);
				if (current) {
					this.renderAccountBody(details, body, account, current);
					this.applySort();
				}
				return;
			}
			this.renderErrorBody(body, `${account.alias}：${STR.fetchFailedPrefix}（${describeError(error)}）`, account);
		}
	}

	/** 失败/凭证缺失时，折叠行只留一个图标（用户拍板），原因进 tooltip；填充条归零。 */
	private renderErrorBody(body: HTMLElement, message: string, account: AccountRecord): void {
		const details = body.closest<HTMLDetailsElement>("details.qk-account");
		const rowPct = details?.querySelector<HTMLElement>(".qk-row-pct");
		if (rowPct) {
			this.resetRowAnchor(rowPct);
			rowPct.addClass("qk-row-error");
			const icon = rowPct.createSpan({ cls: "qk-row-error-icon" });
			setIcon(icon, "triangle-alert");
			rowPct.setAttribute("aria-label", message);
			rowPct.setAttribute("title", message);
		}
		// 查询失败 / 凭证错误同样归入"不可用"：行外侧总量条整条灰化，不再留空条。
		const rowFill = details?.querySelector<HTMLElement>(".qk-row-fill");
		rowFill?.setCssStyles({ width: "100%" });
		rowFill?.classList.add("qk-row-fill-muted");
		body.empty();
		const line = body.createDiv("qk-error-line");
		const msg = line.createDiv("qk-error-message");
		// 行尾已有一个 triangle-alert 报错，展开体不再重复图标；机器细节单独标红。
		this.renderErrorMessage(msg, message);
		line.appendChild(
			this.createRefreshIcon(() => {
				body.empty();
				body.createDiv({ text: STR.loading, cls: "qk-card-loading" });
				void this.fetchAndRenderByCard(body, account);
			}),
		);
		this.sinking.add(account.id);
		this.applySort();
	}

	/** 错误正文整篇红色（用户拍板，与上个发布版一致）；HTTP/code/厂商原始响应另用等宽小字。 */
	private renderErrorMessage(container: HTMLElement, message: string): void {
		const text = container.createDiv("qk-card-error-text");
		for (const segment of splitErrorSegments(message)) {
			if (segment.code) {
				text.createSpan({ text: formatErrorCode(segment.text), cls: "qk-error-code" });
			} else {
				text.appendText(segment.text);
			}
		}
	}

	/** 从行内元素反查所属 details 后重取（错误态/单账号刷新共用路径）。 */
	private fetchAndRenderByCard(inner: HTMLElement, account: AccountRecord): void {
		const details = inner.closest<HTMLDetailsElement>("details.qk-account");
		if (!details) return;
		const body = details.querySelector<HTMLElement>(".qk-account-body");
		if (!body) return;
		// 仅错误态重试时清掉行尾警示；正常账号手动刷新保留当前读数，避免闪空。
		const rowPct = details.querySelector<HTMLElement>(".qk-row-pct");
		if (rowPct?.hasClass("qk-row-error")) this.resetRowAnchor(rowPct);
		body.empty();
		body.createDiv({ text: STR.loading, cls: "qk-card-loading" });
		void this.fetchAndRender(account, details, body);
	}

	private renderAccountBody(
		details: HTMLDetailsElement,
		body: HTMLElement,
		account: AccountRecord,
		snapshots: QuotaSnapshot[],
	): void {
		body.empty();
		if (snapshots.length === 0) {
			// 适配器正常返回空集（极少见）：给可见状态，不让行尾与展开体停在空白。
			this.renderErrorBody(body, `${account.alias}：${STR.meterNoData}`, account);
			return;
		}
		const summary = summarizeQuota(snapshots);
		// 额度用尽（总窗口 100% 或短窗口时钟态）：行外侧总量条改浅灰，并与查询失败一起沉底。
		const blocked = summary.totalBlocked || Boolean(summary.shortBlocked);
		if (blocked) this.sinking.add(account.id);
		else this.sinking.delete(account.id);
		// 折叠行信息减负（§v1.3）：末位总窗口满 → 100%；只有短窗口满 → 仅时钟图标；否则总额度/余额。
		const total = summary.totalBlocked ? 100 : (summary.total ?? 0);
		const rowFill = details.querySelector<HTMLElement>(".qk-row-fill");
		rowFill?.setCssStyles({ width: `${formatPercent(total)}%` });
		rowFill?.classList.toggle("qk-row-fill-muted", blocked);
		const rowPct = details.querySelector<HTMLElement>(".qk-row-pct");
		if (rowPct) {
			// 单账号刷新会重复进入本方法：先清空旧行尾内容与态位再重填，否则叠加或残留 tooltip。
			this.resetRowAnchor(rowPct);
			if (summary.totalBlocked) {
				// 月额/末位总窗口满：照旧显示 100%，不显示时钟图标。
				rowPct.createSpan({ text: "100", cls: "qk-pct-num" });
				rowPct.createSpan({ text: "%", cls: "qk-pct-unit" });
			} else if (summary.shortBlocked) {
				// 等待 5h/周刷新：只显示时钟回退图标，不报窗口与天数（tooltip 带原因）。
				// 用户指定 rotate-ccw-clock；Obsidian 1.12 内置图标表未收录该名，history 是同一 lucide 字形。
				rowPct.addClass("qk-row-blocked");
				const icon = rowPct.createSpan({ cls: "qk-row-blocked-icon" });
				setIcon(icon, "history");
				const tooltip = `${summary.shortBlocked.label}${STR.windowUsedUp}`;
				rowPct.setAttribute("aria-label", tooltip);
				rowPct.setAttribute("title", tooltip);
			} else if (summary.balance) {
				// 余额型（§v1.2）：无分母不画条（fill 恒 0），右锚槽位改显主币种金额。
				const amountSpan = rowPct.createSpan({ text: summary.balance });
				if (summary.balance.startsWith("-")) amountSpan.addClass("qk-neg");
			} else {
				rowPct.createSpan({ text: formatPercent(total), cls: "qk-pct-num" });
				rowPct.createSpan({ text: "%", cls: "qk-pct-unit" });
			}
		}

		const latest = snapshots[snapshots.length - 1];
		const meta = body.createDiv("qk-account-meta");
		meta.createDiv({ text: `${STR.capturedAt} ${new Date(latest.capturedAt).toLocaleTimeString()}`, cls: "qk-captured" });
		// 刷新以账号为单位：一凭证多套餐时展开体内有多段快照，需整体重取。
		meta.appendChild(this.createRefreshIcon(() => this.fetchAndRenderByCard(body, account)));

		for (const snapshot of snapshots) {
			if (snapshot.planName) body.createDiv({ text: snapshot.planName, cls: "qk-plan-title" });
			// 厂商名已由折叠行承担，块内只放真实 extras；无 extras 不渲染。
			// 单一容器自然双列（20260930 排版 v4 契约）：行 = 键 + 金额(+次要列) 不可拆段，
			// 行不拉伸、按内容宽打包——短对双列并排，长行（券/合计）自然独占，段放不下整段折行不拆词。
			if (snapshot.extras.length > 0) {
				const info = body.createDiv("qk-info");
				for (const extra of snapshot.extras) {
					const row = info.createDiv("qk-info-row");
					// 带次要列的行（代金券合计 / 券明细）独占一行、内容紧凑左排——宽窄一致，
					// 避免 space-between 三段在宽面板被拉开散排（20260930 排版 v4 宿主证据后定稿）。
					if (extra.detail) row.addClass("qk-has-detail");
					row.createDiv({ text: extra.label, cls: "qk-info-key" });
					const valueEl = row.createDiv({ text: extra.value, cls: "qk-info-value" });
					// 负金额红字（§v1.2 裁决③）：欠费 / 后付费负余额在键值行同样生效。
					if (extra.value.startsWith("-")) valueEl.addClass("qk-neg");
					// 次要数值列（§v1.2 真号反馈）：金额与日期 / 张数分列，不合并成一个字符串。
					if (extra.detail) row.createDiv({ text: extra.detail, cls: "qk-info-detail" });
				}
			}
			// 余额型快照无窗口（§v1.2）：不创建窗口条容器，展开体只留 extras 键值行。
			if (snapshot.windows.length === 0) continue;
			const windows = body.createDiv("qk-windows");
			for (const window of snapshot.windows) {
			const row = windows.createDiv("qk-window-row");
			row.createDiv({ text: window.label, cls: "qk-window-label" });
			const pct = formatPercent(window.usedPercent);
			// 中间列包一层容器查询单元：列宽足够时百分比叠加在条上，窄到放不下时退化为只显示百分比（CSS 切换）。
			const cell = row.createDiv("qk-bar-cell");
			const bar = cell.createDiv("qk-bar");
			const fill = bar.createDiv("qk-bar-fill");
			fill.setCssStyles({ width: `${pct}%` });
			// 三家 API 原生都是"已用"口径，统一主题浅色（用户拍板：填充做浅）；百分比嵌条居中，深色常驻（浅底白字不可读）。
			const pctEl = cell.createDiv("qk-pct");
				pctEl.createSpan({ text: pct, cls: "qk-pct-num" });
				pctEl.createSpan({ text: "%", cls: "qk-pct-unit" });
				const reset = formatResetCountdown(window.resetsAt, Date.now(), true);
				if (reset) row.createDiv({ text: reset, cls: "qk-window-reset" });
			}
		}
	}

	/** 折叠行行尾锚点复位：清内容、态位与 tooltip（受限/错误/正常三态互斥）。 */
	private resetRowAnchor(rowPct: HTMLElement): void {
		rowPct.empty();
		rowPct.removeClass("qk-row-blocked");
		rowPct.removeClass("qk-row-error");
		rowPct.removeAttribute("aria-label");
		rowPct.removeAttribute("title");
	}

	/** 单账号刷新图标（原生 clickable-icon + lucide，aria-label 与 tooltip 双报）。 */
	private createRefreshIcon(onRefresh: () => void): HTMLElement {
		const icon = createDiv("clickable-icon qk-refresh-icon");
		setIcon(icon, "refresh-cw");
		icon.setAttribute("aria-label", STR.refresh);
		setTooltip(icon, STR.refresh);
		icon.addEventListener("click", onRefresh);
		return icon;
	}
}
