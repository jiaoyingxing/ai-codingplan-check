import { ItemView, WorkspaceLeaf } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter } from "./adapters";
import { STR } from "./strings";
import { describeError } from "./settings";
import type { AccountRecord, ProviderId, QuotaSnapshot } from "./types";

export const VIEW_TYPE_QUOTA_PANEL = "ai-codingplan-check-panel";

/** 额度面板主页：右侧栏常驻视图，按 provider 分组的账号卡片（左信息右三进度条）。 */
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
		for (const [provider, group] of byProvider) {
			const adapter = getAdapter(provider);
			body.createDiv({ text: adapter?.label ?? provider, cls: "qk-group-title" });
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
		head.createDiv("qk-card-actions").createEl("button", { text: STR.refresh }).addEventListener("click", () => {
			slot.empty();
			slot.createDiv({ text: STR.loading, cls: "qk-card-loading" });
			void this.fetchAndRender(account, slot);
		});
	}

	private renderSnapshotCard(card: HTMLElement, account: AccountRecord, snapshot: QuotaSnapshot): void {
		card.empty();
		const captured = new Date(snapshot.capturedAt).toLocaleTimeString();

		const head = card.createDiv("qk-card-head");
		const title = head.createDiv("qk-card-title");
		title.createDiv({ text: account.alias, cls: "qk-card-alias" });
		if (snapshot.planName) title.createDiv({ text: snapshot.planName, cls: "qk-card-plan" });
		const actions = head.createDiv("qk-card-actions");
		actions.createDiv({ text: `${STR.capturedAt} ${captured}`, cls: "qk-captured" });
		// 刷新以账号槽位为单位：一凭证多套餐时槽内有多张卡，需整体重取。
		actions.createDiv().createEl("button", { text: STR.refresh }).addEventListener("click", () => {
			const slot = card.closest(".qk-account-slot") ?? card;
			slot.empty();
			slot.createDiv({ text: STR.loading, cls: "qk-card-loading" });
			void this.fetchAndRender(account, slot as HTMLElement);
		});

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
			const line = block.createDiv("qk-window-line");
			line.createDiv({ text: window.label, cls: "qk-window-label" });
			const bar = line.createDiv("qk-bar");
			const fill = bar.createDiv("qk-bar-fill");
			// 三家 API 原生都是"已用"口径：条越满用得越多，颜色统一主题色（用户拍板：不加分档色）。
			fill.style.width = `${Math.round(window.usedPercent)}%`;
			line.createDiv({ text: `${Math.round(window.usedPercent)}%`, cls: "qk-window-pct" });

			const reset = formatResetCountdown(window.resetsAt);
			if (reset) block.createDiv({ text: reset, cls: "qk-window-reset" });
			if (window.rateLimited) block.createDiv({ text: "已限速", cls: "qk-window-limited" });
		}
	}
}

/** 重置倒计时的人话格式：<1h → 分钟，<24h → 小时，否则天数。 */
export function formatResetCountdown(resetsAt: number | null, now = Date.now()): string {
	if (resetsAt === null) return "";
	const diff = resetsAt - now;
	if (diff <= 0) return "即将重置";
	const minutes = Math.floor(diff / 60000);
	if (minutes < 60) return `${minutes} 分钟后重置`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时后重置`;
	return `${Math.floor(hours / 24)} 天后重置`;
}
