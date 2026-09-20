import { ItemView, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter } from "./adapters";
import { formatPercent, formatResetCountdown } from "./format";
import { STR } from "./strings";
import { describeError } from "./settings";
import type { AccountRecord, QuotaSnapshot } from "./types";

export const VIEW_TYPE_QUOTA_PANEL = "ai-codingplan-check-panel";

/** 额度面板主页：固定左侧栏（EasySync 口径）。账号折叠列表——
 *  行 = 服务商名 + 灰别名 + 总用量%右锚（行背景即总进度条，取约束最紧窗口）；
 *  展开体 = 融合单行窗口（label | 高条内嵌% | 重置时间右）。
 *  页动作在内容顶部 nav-header（刷新全部/打开设置/全部展开收起），不用 view header 重复入口；
 *  分组顶部可切换/排序为后续计划（CURRENT_STATUS 下一步）。 */
export class QuotaView extends ItemView {
	plugin: AiCodingplanCheckPlugin;
	/** 账号折叠态（重绘与单账号刷新后保持；默认收起）。 */
	private expanded = new Map<string, boolean>();

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

	/** 全量重绘（入口/页头刷新用）；单账号刷新只重建其 details 内部，折叠态不丢。页面限宽居中，滚动权归 leaf。 */
	private renderPanel(): void {
		const { contentEl } = this;
		contentEl.empty();
		const page = contentEl.createDiv("qk-page");
		this.renderToolbar(page);
		const accounts = this.plugin.settings.accounts.filter((account) => account.enabled);
		if (accounts.length === 0) {
			this.renderEmptyState(page);
			return;
		}
		const list = page.createDiv("qk-list");
		for (const account of accounts) {
			// 一凭证多套餐（如方舟双订阅）→ fetchQuota 返回多份快照、展开体内分段渲染。
			const details = list.createEl("details", "qk-account qk-card");
			details.toggleAttribute("open", this.expanded.get(account.id) ?? false);
			details.addEventListener("toggle", () => this.expanded.set(account.id, details.open));
			this.renderRow(details.createEl("summary", "qk-row"), account);
			const body = details.createDiv("qk-account-body");
			body.createDiv({ text: STR.loading, cls: "qk-card-loading" });
			void this.fetchAndRender(account, details, body);
		}
	}

	/** 页头动作行（EasySync 口径：原生 nav-header + clickable-icon nav-action-button + aria-label）。 */
	private renderToolbar(container: HTMLElement): void {
		const buttons = container.createDiv("nav-header").createDiv("nav-buttons-container");
		this.createNavButton(buttons, "refresh-cw", STR.refreshAll, () => this.renderPanel());
		this.createNavButton(buttons, "settings", STR.openSettings, () => this.plugin.openPluginSettings());
		this.createNavButton(buttons, "chevrons-up-down", STR.expandAll, (btn) => {
			const items = Array.from(container.querySelectorAll<HTMLDetailsElement>("details.qk-account"));
			const target = items.some((item) => !item.open);
			for (const item of items) item.open = target;
			setIcon(btn, target ? "chevrons-down-up" : "chevrons-up-down");
			btn.setAttribute("aria-label", target ? STR.collapseAll : STR.expandAll);
		});
	}

	private createNavButton(
		container: HTMLElement,
		icon: string,
		label: string,
		onClick: (button: HTMLButtonElement) => void,
	): HTMLButtonElement {
		const button = container.createEl("button", {
			cls: "clickable-icon nav-action-button",
			attr: { "aria-label": label, type: "button" },
		});
		setIcon(button, icon);
		button.addEventListener("click", () => onClick(button));
		return button;
	}

	/** 折叠行：chevron + 服务商名 + 灰别名 + 总%右锚；行背景 fill 层即总进度条（宽度取数后回填）。 */
	private renderRow(summary: HTMLElement, account: AccountRecord): void {
		const icon = summary.createDiv("qk-collapse-icon");
		setIcon(icon, "chevron-right");
		const text = summary.createDiv("qk-row-text");
		text.createDiv({ text: getAdapter(account.provider)?.label ?? account.provider, cls: "qk-card-provider" });
		text.createDiv({ text: account.alias, cls: "qk-card-alias" });
		summary.createDiv("qk-row-fill");
		summary.createDiv("qk-row-pct");
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
		const secret = this.app.secretStorage.getSecret(account.secretId);
		if (!secret) {
			this.renderErrorBody(body, `${account.alias}：${STR.secretMissing}`, account);
			return;
		}
		try {
			const snapshots = await adapter.fetchQuota(secret);
			this.renderAccountBody(details, body, account, snapshots);
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
		// 行背景总进度条 + 行尾总%锚点。单套餐取约束最紧窗口（最大已用）；
		// 多套餐（火山同凭证多订阅）暂以「剩余额度最多」口径：取已用最少窗口（用户拍板，待分组方案定稿后重议）。
		const percents = snapshots.flatMap((s) => s.windows.map((w) => w.usedPercent));
		const total =
			snapshots.length > 1
				? Math.max(0, Math.min(...percents))
				: Math.min(Math.max(...percents), 100);
		const rowFill = details.querySelector<HTMLElement>(".qk-row-fill");
		rowFill?.setCssStyles({ width: `${total}%` });
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
				const bar = row.createDiv("qk-bar");
				const fill = bar.createDiv("qk-bar-fill");
				fill.setCssStyles({ width: `${pct}%` });
				// 三家 API 原生都是"已用"口径，统一主题色（用户拍板：不加分档色）；百分比嵌条居中（用户拍板融合）。
				const pctEl = bar.createDiv("qk-pct");
				pctEl.createSpan({ text: pct, cls: "qk-pct-num" });
				pctEl.createSpan({ text: "%", cls: "qk-pct-unit" });
				// 填充过半（≥60%）时文字整体落在主题色上，切换为反色保证可读。
				if (window.usedPercent >= 60) pctEl.addClass("qk-pct-on-fill");
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
