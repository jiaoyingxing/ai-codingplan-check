import type { AccountRecord, QuotaSnapshot } from "./types";

/** 插件级额度快照缓存（§v1.3）：面板取数、账号向导的测通回写共用，避免同一账号重复查询。
 *  取数函数由宿主注入（适配器查找留在 main），本类不依赖 obsidian，可直接单测。
 *  - 同账号并发加载复用同一个 Promise；
 *  - invalidate / put 用代数号挡住迟到的旧响应：缓存写入由本类判断，
 *    面板渲染由调用方按 generation / isCurrentGeneration 判断；
 *  - 账号删除与重新启用时由设置页触发失效。 */
export class QuotaStore {
	private readonly snapshots = new Map<string, QuotaSnapshot[]>();
	private readonly inflight = new Map<string, Promise<QuotaSnapshot[]>>();
	private readonly generations = new Map<string, number>();

	constructor(
		private readonly fetchQuota: (account: AccountRecord, secret: string) => Promise<QuotaSnapshot[]>,
		/** 成功且代数未变的读数回调（§v1.13 周期存档挂点）；抛错由调用方自行兜住，不影响查询结果。 */
		private readonly onLoad?: (account: AccountRecord, snapshots: QuotaSnapshot[]) => void,
	) {}

	get(accountId: string): QuotaSnapshot[] | undefined {
		return this.snapshots.get(accountId);
	}

	/** 当前代数号（只读）：调用方在发起加载前同步捕获，用于判断结果是否已过期。 */
	generation(accountId: string): number {
		return this.generations.get(accountId) ?? 0;
	}

	/** 捕获的代数号是否仍为当前代数（false 表示期间发生过 invalidate 或 put）。 */
	isCurrentGeneration(accountId: string, generation: number): boolean {
		return this.generation(accountId) === generation;
	}

	/** 直接写入成功快照（如添加/编辑账号时的测通结果），并让仍在飞行的旧请求失效。 */
	put(accountId: string, snapshots: QuotaSnapshot[]): void {
		this.bumpGeneration(accountId);
		// 丢掉仍在飞行的旧请求占位，避免后续 load 复用旧凭证的 Promise（代数号仍会挡住回写）。
		this.inflight.delete(accountId);
		this.snapshots.set(accountId, snapshots);
	}

	/** 凭证/账号变更：丢弃缓存并让迟到响应失效（不取消已发出的请求）。 */
	invalidate(accountId: string): void {
		this.bumpGeneration(accountId);
		this.snapshots.delete(accountId);
		this.inflight.delete(accountId);
	}

	load(account: AccountRecord, secret: string): Promise<QuotaSnapshot[]> {
		const running = this.inflight.get(account.id);
		if (running) return running;
		const generation = this.generation(account.id);
		const promise = (async () => {
			const snapshots = await this.fetchQuota(account, secret);
			// 失败照旧向上抛出；成功仅在代数未变时回写，避免旧凭证结果覆盖新缓存。
			if (this.isCurrentGeneration(account.id, generation)) {
				this.snapshots.set(account.id, snapshots);
				this.onLoad?.(account, snapshots);
			}
			return snapshots;
		})();
		this.inflight.set(account.id, promise);
		const settle = () => {
			if (this.inflight.get(account.id) === promise) this.inflight.delete(account.id);
		};
		promise.then(settle, settle);
		return promise;
	}

	private bumpGeneration(accountId: string): void {
		this.generations.set(accountId, this.generation(accountId) + 1);
	}
}
