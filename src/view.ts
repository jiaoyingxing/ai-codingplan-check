import { ItemView, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter } from "./adapters";
import { formatPercent, formatResetCountdown } from "./format";
import { STR } from "./strings";
import { describeError } from "./settings";
import type { AccountRecord, ProviderId, QuotaSnapshot } from "./types";

export const VIEW_TYPE_QUOTA_PANEL = "ai-codingplan-check-panel";

/** 额度面板主页：右侧栏常驻视图，账号卡片流——卡头=服务商名+别名，窗口块=标题行+通栏进度条。
 *  分组标题已取消（用户拍板）；后续计划把分组做成顶部可切换/排序（本轮仅登记不实施）。 */
export class QuotaView extends ItemView {
	plugin: AiCodingplanCheckPlugin;

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
		this.addAction("refresh-cw", STR.refreshAll, () => this.renderPanel());
		this.renderPanel();
	}

	async onClose(): Promise<void> {}

	/** 全量重绘（入口/全部刷新用）；单卡刷新走卡内按钮，不重建整板。页面限宽居中，滚动权归 leaf。 */
	private renderPanel(): void {
		const { contentEl } = this;
		contentEl.empty();
		const page = contentEl.createDiv("qk-page");
		const accounts = this.plugin.settings.accounts.filter((account) => account.enabled);
		if (accounts.length === 0) {
			this.renderEmptyState(page);
			return;
		}
		const body = page.createDiv("qk-body");
		const byProvider = new Map<ProviderId, AccountRecord[]>();
		for (const account of accounts) {
			const group = byProvider.get(account.provider) ?? [];
			group.push(account);
			byProvider.set(account.provider, group);
		}
		for (const group of byProvider.values()) {
			for (const account of group) {
				// 一凭证多套餐（如方舟双订阅）→ fetchQuota 返回多张快照、渲染多张卡。
				const slot = body.createDiv("qk-account-slot");
				slot.createDiv({ text: STR.loading, cls: "qk-card-loading" });
				void this.fetchAndRender(account, slot);
			}
		}
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

	private async fetchAndRender(account: AccountRecord, slot: HTMLElement): Promise<void> {
		const adapter = getAdapter(account.provider);
		if (!adapter) return;
		const secret = this.app.secretStorage.getSecret(account.secretId);
		if (!secret) {
			this.renderErrorCard(slot, `${account.alias}：${STR.secretMissing}`, account);
			return;
		}
		try {
			const snapshots = await adapter.fetchQuota(secret);
			slot.empty();
			for (const snapshot of snapshots) {
				const card = slot.createDiv("qk-card");
				this.renderSnapshotCard(card, account, snapshot);
			}
		} catch (error) {
			this.renderErrorCard(slot, `${account.alias}：${STR.fetchFailedPrefix}（${describeError(error)}）`, account);
		}
	}

	private renderErrorCard(slot: HTMLElement, message: string, account: AccountRecord): void {
		slot.empty();
		const card = slot.createDiv("qk-card");
		card.addClass("qk-card-error");
		const head = card.createDiv("qk-card-head");
		head.createDiv({ text: message, cls: "qk-card-error-text" });
		head.createDiv("qk-card-actions").appendChild(
			this.createRefreshIcon(() => {
				slot.empty();
				slot.createDiv({ text: STR.loading, cls: "qk-card-loading" });
				void this.fetchAndRender(account, slot);
			}),
		);
	}

	private renderSnapshotCard(card: HTMLElement, account: AccountRecord, snapshot: QuotaSnapshot): void {
		card.empty();
		const captured = new Date(snapshot.capturedAt).toLocaleTimeString();

		const head = card.createDiv("qk-card-head");
		const title = head.createDiv("qk-card-title");
		// 取消分组（用户拍板）：服务商名升为卡片标题，别名降为小号灰色副文本。
		title.createDiv({ text: getAdapter(account.provider)?.label ?? account.provider, cls: "qk-card-provider" });
		title.createDiv({ text: account.alias, cls: "qk-card-alias" });
		if (snapshot.planName) title.createDiv({ text: snapshot.planName, cls: "qk-card-plan" });
		const actions = head.createDiv("qk-card-actions");
		actions.createDiv({ text: `${STR.capturedAt} ${captured}`, cls: "qk-captured" });
		// 刷新以账号槽位为单位：一凭证多套餐时槽内有多张卡，需整体重取。
		actions.appendChild(
			this.createRefreshIcon(() => {
				const slot = card.closest(".qk-account-slot") ?? card;
				slot.empty();
				slot.createDiv({ text: STR.loading, cls: "qk-card-loading" });
				void this.fetchAndRender(account, slot as HTMLElement);
			}),
		);

		const bodyEl = card.createDiv("qk-card-body");
		// 厂商名已由分组标题承担，左栏只放真实 extras；无 extras 不渲染左栏（进度条占满整行）。
		if (snapshot.extras.length > 0) {
			const info = bodyEl.createDiv("qk-info");
			for (const extra of snapshot.extras) {
				const row = info.createDiv("qk-info-row");
				row.createDiv({ text: extra.label, cls: "qk-info-key" });
				row.createDiv({ text: extra.value, cls: "qk-info-value" });
			}
		}

		const bars = bodyEl.createDiv("qk-bars");
		for (const window of snapshot.windows) {
			const block = bars.createDiv("qk-window");
			// 标题行：窗口名 + 重置时间（用户拍板：并入小标题后），百分比右缘锚点；进度条下移通栏左起。
			const headLine = block.createDiv("qk-window-head");
			headLine.createDiv({ text: window.label, cls: "qk-window-label" });
			const reset = formatResetCountdown(window.resetsAt);
			if (reset) headLine.createDiv({ text: reset, cls: "qk-window-reset" });
			// 百分比是行内主锚点（用户拍板）：数字加重放大、单位缩小变灰，右缘对齐成垂直刻度线。
			const pct = formatPercent(window.usedPercent);
			const pctCell = headLine.createDiv("qk-window-pct");
			pctCell.createSpan({ text: pct, cls: "qk-window-pct-num" });
			pctCell.createSpan({ text: "%", cls: "qk-window-pct-unit" });

			// 三家 API 原生都是"已用"口径：条越满用得越多，颜色统一主题色（用户拍板：不加分档色）。
			const bar = block.createDiv("qk-bar");
			const fill = bar.createDiv("qk-bar-fill");
			fill.setCssStyles({ width: `${pct}%` });		}
	}

	/** 刷新图标按钮（用户拍板：文字按钮→图标）：原生 clickable-icon + lucide refresh-cw，aria-label 与 tooltip 双报。 */
	private createRefreshIcon(onRefresh: () => void): HTMLElement {
		const icon = createDiv("clickable-icon qk-refresh-icon");
		setIcon(icon, "refresh-cw");
		icon.setAttribute("aria-label", STR.refresh);
		setTooltip(icon, STR.refresh);
		icon.addEventListener("click", onRefresh);
		return icon;
	}
}
