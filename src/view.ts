import { ItemView, Menu, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter } from "./adapters";
import { formatPercent, formatResetCountdown } from "./format";
import { decryptSecret } from "./secret-crypto";
import { STR } from "./strings";
import { MobileUnlockModal, describeError } from "./settings";
import type { AccountRecord, QuotaSnapshot } from "./types";

export const VIEW_TYPE_QUOTA_PANEL = "ai-codingplan-check-panel";

type SortKey = "provider" | "usage" | "reset";
type SortDir = "asc" | "desc";
interface SortMode {
	key: SortKey;
	dir: SortDir;
}

function providerLabel(account: AccountRecord): string {
	return getAdapter(account.provider)?.label ?? account.provider;
}

/** 行总用量口径（总额度 = 账单周期窗口，三家窗口序均为 …→月度/本期，取末位窗口）：
 *  每个计划取其末位窗口已用；多套餐（火山同凭证多订阅）以剩余额度最多为准，
 *  取该值最小的计划（用户拍板并实证：火山 Agent 月窗 35%，而非 5h 窗 0% 或周窗 100%）。 */
function accountTotal(snapshots: QuotaSnapshot[]): number {
	const planPercents = snapshots
		.filter((s) => s.windows.length > 0)
		.map((s) => s.windows[s.windows.length - 1].usedPercent);
	if (planPercents.length === 0) return 0;
	return Math.max(0, Math.min(...planPercents, 100));
}

/** 额度面板主页：固定左侧栏（EasySync 口径）。账号折叠列表——
 *  行 = 服务商名 + 灰别名 + 总用量%右锚（行背景即总进度条，口径见 accountTotal）；
 *  展开体 = 融合单行窗口（label | 高条内嵌% | 重置时间右）。
 *  页动作在内容顶部 nav-header 固定工具行（刷新全部/排序 Menu/全部展开收起/打开设置），
 *  列表在 .qk-scroll 内独立滚动（桌面侧栏 app.css 隐藏 .view-header，addAction 不可见）；
 *  排序复用核心资源管理器模式（按钮 + Menu 弹框勾选），快照缓存驱动额度/重置排序。 */
export class QuotaView extends ItemView {
	plugin: AiCodingplanCheckPlugin;
	/** 账号折叠态（重绘与单账号刷新后保持；默认收起）。 */
	private expanded = new Map<string, boolean>();
	/** 已取回快照缓存（排序用；面板重绘不丢，单账号刷新覆盖）。 */
	private cache = new Map<string, QuotaSnapshot[]>();
	/** 行元素索引（排序时移动 DOM 节点用，不重建不重取）。 */
	private rowEls = new Map<string, HTMLDetailsElement>();
	/** 当前排序（会话内记忆，不持久化）。 */
	private sort: SortMode = { key: "provider", dir: "asc" };
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
		this.collapseButtonEl = this.createNavButton(buttons, "chevrons-up-down", STR.expandAll, () => {
			const items = Array.from(this.contentEl.querySelectorAll<HTMLDetailsElement>("details.qk-account"));
			const target = items.some((item) => !item.open);
			for (const item of items) item.open = target;
			this.updateCollapseToggle();
		});
		this.createNavButton(buttons, "settings", STR.openSettings, () => this.plugin.openPluginSettings());
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

	/** 排序：套餐名按本地化比较；额度/重置时间用缓存快照，无数据账号恒排末尾。返回新数组不改设置原序。 */
	private sortAccounts(accounts: AccountRecord[]): AccountRecord[] {
		const { key, dir } = this.sort;
		const sign = dir === "asc" ? 1 : -1;
		return [...accounts].sort((a, b) => {
			if (key === "provider") {
				return sign * providerLabel(a).localeCompare(providerLabel(b), "zh");
			}
			const va = this.sortMetric(a);
			const vb = this.sortMetric(b);
			if (va === null && vb === null) return 0;
			if (va === null) return 1;
			if (vb === null) return -1;
			return sign * (va - vb);
		});
	}

	private sortMetric(account: AccountRecord): number | null {
		const snapshots = this.cache.get(account.id);
		if (!snapshots || snapshots.length === 0) return null;
		if (this.sort.key === "usage") return accountTotal(snapshots);
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

	/** 排序菜单（核心资源管理器排序按钮同款：addAction 触发 Menu，勾选当前项，同组两个方向为一对）。 */
	private showSortMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const add = (label: string, key: SortKey, dir: SortDir) =>
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setChecked(this.sort.key === key && this.sort.dir === dir)
					.onClick(() => {
						this.sort = { key, dir };
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
		const adapter = getAdapter(account.provider);
		if (!adapter) return;
		let secret = this.app.secretStorage.getSecret(account.secretId);
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
		try {
			const snapshots = await adapter.fetchQuota(secret);
			this.cache.set(account.id, snapshots);
			this.renderAccountBody(details, body, account, snapshots);
			this.applySort();
		} catch (error) {
			this.renderErrorBody(body, `${account.alias}：${STR.fetchFailedPrefix}（${describeError(error)}）`, account);
		}
	}

	private renderErrorBody(body: HTMLElement, message: string, account: AccountRecord): void {
		body.empty();
		const line = body.createDiv("qk-error-line");
		line.createDiv({ text: message, cls: "qk-card-error-text" });
		line.appendChild(
			this.createRefreshIcon(() => {
				body.empty();
				body.createDiv({ text: STR.loading, cls: "qk-card-loading" });
				void this.fetchAndRenderByCard(body, account);
			}),
		);
	}

	/** 从行内元素反查所属 details 后重取（错误态/单账号刷新共用路径）。 */
	private fetchAndRenderByCard(inner: HTMLElement, account: AccountRecord): void {
		const details = inner.closest<HTMLDetailsElement>("details.qk-account");
		if (!details) return;
		const body = details.querySelector<HTMLElement>(".qk-account-body");
		if (!body) return;
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
		if (snapshots.length === 0) return;
		// 行背景总进度条 + 行尾总%锚点，口径见 accountTotal。
		const total = accountTotal(snapshots);
		const rowFill = details.querySelector<HTMLElement>(".qk-row-fill");
		rowFill?.setCssStyles({ width: `${formatPercent(total)}%` });
		const rowPct = details.querySelector<HTMLElement>(".qk-row-pct");
		if (rowPct) {
			// 单账号刷新会重复进入本方法：先清空旧行尾数字再重填，否则百分比叠加显示。
			rowPct.empty();
			rowPct.createSpan({ text: formatPercent(total), cls: "qk-pct-num" });
			rowPct.createSpan({ text: "%", cls: "qk-pct-unit" });
		}

		const latest = snapshots[snapshots.length - 1];
		const meta = body.createDiv("qk-account-meta");
		meta.createDiv({ text: `${STR.capturedAt} ${new Date(latest.capturedAt).toLocaleTimeString()}`, cls: "qk-captured" });
		// 刷新以账号为单位：一凭证多套餐时展开体内有多段快照，需整体重取。
		meta.appendChild(this.createRefreshIcon(() => this.fetchAndRenderByCard(body, account)));

		for (const snapshot of snapshots) {
			if (snapshot.planName) body.createDiv({ text: snapshot.planName, cls: "qk-plan-title" });
			// 厂商名已由折叠行承担，块内只放真实 extras；无 extras 不渲染。
			if (snapshot.extras.length > 0) {
				const info = body.createDiv("qk-info");
				for (const extra of snapshot.extras) {
					const row = info.createDiv("qk-info-row");
					row.createDiv({ text: extra.label, cls: "qk-info-key" });
					row.createDiv({ text: extra.value, cls: "qk-info-value" });
				}
			}
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
