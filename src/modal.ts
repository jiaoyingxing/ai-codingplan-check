import { App, Modal, Setting } from "obsidian";
import type AiCodingplanCheckPlugin from "./main";
import { getAdapter } from "./adapters";
import { STR } from "./strings";
import { describeError } from "./settings";
import type { AccountRecord, ProviderId, QuotaSnapshot } from "./types";

/** 主面板：按 provider 分组的账号卡片，左栏套餐信息、右栏三条窗口进度条。 */
export class QuotaModal extends Modal {
	plugin: AiCodingplanCheckPlugin;

	constructor(app: App, plugin: AiCodingplanCheckPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.modalEl.addClass("qk-modal");
		this.titleEl.setText(STR.panelTitle);
		this.contentEl.empty();

		const accounts = this.plugin.settings.accounts.filter((account) => account.enabled);
		if (accounts.length === 0) {
			new Setting(this.contentEl).setName(STR.noAccounts).addButton((button) =>
				button
					.setButtonText(STR.openSettings)
					.setCta()
					.onClick(() => {
						this.close();
						this.plugin.openPluginSettings();
					}),
			);
			return;
		}

		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setIcon("refresh-cw")
					.setTooltip(STR.refreshAll)
					.onClick(() => {
						this.renderAll(accounts);
					}),
			);

		const body = this.contentEl.createDiv("qk-body");
		this.renderAll(accounts, body);
	}

	private renderAll(accounts: AccountRecord[], body?: HTMLElement): void {
		const container = body ?? this.contentEl.querySelector<HTMLElement>(".qk-body");
		if (!container) return;
		container.empty();

		const byProvider = new Map<ProviderId, AccountRecord[]>();
		for (const account of accounts) {
			const group = byProvider.get(account.provider) ?? [];
			group.push(account);
			byProvider.set(account.provider, group);
		}

		for (const [provider, group] of byProvider) {
			const adapter = getAdapter(provider);
			container.createDiv({ text: adapter?.label ?? provider, cls: "qk-group-title" });
			for (const account of group) {
				const card = container.createDiv("qk-card");
				card.createDiv({ text: STR.loading, cls: "qk-card-loading" });
				void this.fetchAndRender(account, card);
			}
		}
	}

	private async fetchAndRender(account: AccountRecord, card: HTMLElement): Promise<void> {
		const adapter = getAdapter(account.provider);
		if (!adapter) return;
		const secret = this.app.secretStorage.getSecret(account.secretId);
		if (!secret) {
			this.renderErrorCard(card, `${account.alias}：${STR.secretMissing}`, account);
			return;
		}
		try {
			const snapshot = await adapter.fetchQuota(secret);
			this.renderSnapshotCard(card, account, snapshot);
		} catch (error) {
			this.renderErrorCard(card, `${account.alias}：${STR.fetchFailedPrefix}（${describeError(error)}）`, account);
		}
	}

	private renderErrorCard(card: HTMLElement, message: string, account: AccountRecord): void {
		card.empty();
		card.addClass("qk-card-error");
		const head = card.createDiv("qk-card-head");
		head.createDiv({ text: message, cls: "qk-card-error-text" });
		head.createDiv("qk-card-actions").createDiv().createEl("button", { text: STR.refresh }).addEventListener(
			"click",
			() => {
				card.removeClass("qk-card-error");
				card.empty();
				card.createDiv({ text: STR.loading, cls: "qk-card-loading" });
				void this.fetchAndRender(account, card);
			},
		);
	}

	private renderSnapshotCard(card: HTMLElement, account: AccountRecord, snapshot: QuotaSnapshot): void {
		const adapter = getAdapter(account.provider);
		card.empty();
		const captured = new Date(snapshot.capturedAt).toLocaleTimeString();

		const head = card.createDiv("qk-card-head");
		const title = head.createDiv("qk-card-title");
		title.createDiv({ text: account.alias, cls: "qk-card-alias" });
		if (snapshot.planName) title.createDiv({ text: snapshot.planName, cls: "qk-card-plan" });
		const actions = head.createDiv("qk-card-actions");
		actions.createDiv({ text: `${STR.capturedAt} ${captured}`, cls: "qk-captured" });
		actions.createDiv().createEl("button", { text: STR.refresh }).addEventListener("click", () => {
			card.empty();
			card.createDiv({ text: STR.loading, cls: "qk-card-loading" });
			void this.fetchAndRender(account, card);
		});

		const bodyEl = card.createDiv("qk-card-body");
		const info = bodyEl.createDiv("qk-info");
		info.createDiv("qk-info-row").createDiv({ text: adapter?.label ?? account.provider, cls: "qk-info-value" });
		for (const extra of snapshot.extras) {
			const row = info.createDiv("qk-info-row");
			row.createDiv({ text: extra.label, cls: "qk-info-key" });
			row.createDiv({ text: extra.value, cls: "qk-info-value" });
		}

		const bars = bodyEl.createDiv("qk-bars");
		for (const window of snapshot.windows) {
			const block = bars.createDiv("qk-window");
			const line = block.createDiv("qk-window-line");
			line.createDiv({ text: window.label, cls: "qk-window-label" });
			const bar = line.createDiv("qk-bar");
			const fill = bar.createDiv("qk-bar-fill");
			fill.style.width = `${Math.round(window.usedPercent)}%`;
			fill.addClass(severityClass(window.usedPercent));
			line.createDiv({ text: `${Math.round(window.usedPercent)}%`, cls: "qk-window-pct" });

			const reset = formatResetCountdown(window.resetsAt);
			if (reset) block.createDiv({ text: reset, cls: "qk-window-reset" });
			if (window.rateLimited) block.createDiv({ text: "已限速", cls: "qk-window-limited" });
		}
	}
}

/** 已用份额阈值：≥90% 红、≥70% 琥珀（对应剩余 ≤10% / ≤30%）。 */
export function severityClass(usedPercent: number): "qk-crit" | "qk-warn" | "qk-ok" {
	if (usedPercent >= 90) return "qk-crit";
	if (usedPercent >= 70) return "qk-warn";
	return "qk-ok";
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
