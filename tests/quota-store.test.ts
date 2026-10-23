import { describe, expect, it, vi } from "vitest";
import { QuotaStore } from "../src/quota-store";
import type { AccountRecord, QuotaSnapshot } from "../src/types";

const ACCOUNT: AccountRecord = {
	id: "acc-1",
	provider: "deepseek",
	alias: "主号",
	secretId: "account-acc-1",
	enabled: true,
};

const SNAPSHOTS: QuotaSnapshot[] = [
	{ windows: [{ key: "monthly", label: "近一月", usedPercent: 30, resetsAt: null, rateLimited: false }], extras: [], capturedAt: 1 },
];

describe("QuotaStore", () => {
	it("加载成功后缓存快照", async () => {
		const fetcher = vi.fn(async () => SNAPSHOTS);
		const store = new QuotaStore(fetcher);
		await expect(store.load(ACCOUNT, "sk-1")).resolves.toBe(SNAPSHOTS);
		expect(store.get(ACCOUNT.id)).toBe(SNAPSHOTS);
		expect(fetcher).toHaveBeenCalledWith(ACCOUNT, "sk-1");
	});

	it("同账号并发加载复用同一个 Promise，只发一次请求", async () => {
		let resolve!: (value: QuotaSnapshot[]) => void;
		const fetcher = vi.fn(
			() => new Promise<QuotaSnapshot[]>((done) => {
				resolve = done;
			}),
		);
		const store = new QuotaStore(fetcher);
		const first = store.load(ACCOUNT, "sk-1");
		const second = store.load(ACCOUNT, "sk-1");
		expect(second).toBe(first);
		expect(fetcher).toHaveBeenCalledTimes(1);
		resolve(SNAPSHOTS);
		await expect(first).resolves.toBe(SNAPSHOTS);
	});

	it("失败向上抛出且不写缓存，重新加载可恢复", async () => {
		const fetcher = vi
			.fn<() => Promise<QuotaSnapshot[]>>()
			.mockRejectedValueOnce(new Error("HTTP 401"))
			.mockResolvedValueOnce(SNAPSHOTS);
		const store = new QuotaStore(fetcher);
		await expect(store.load(ACCOUNT, "bad")).rejects.toThrow("HTTP 401");
		expect(store.get(ACCOUNT.id)).toBeUndefined();
		await expect(store.load(ACCOUNT, "good")).resolves.toBe(SNAPSHOTS);
		expect(store.get(ACCOUNT.id)).toBe(SNAPSHOTS);
	});

	it("invalidate 清缓存，并挡住迟到的旧响应回写", async () => {
		let resolve!: (value: QuotaSnapshot[]) => void;
		const store = new QuotaStore(
			() =>
				new Promise<QuotaSnapshot[]>((done) => {
					resolve = done;
				}),
		);
		const generation = store.generation(ACCOUNT.id);
		const pending = store.load(ACCOUNT, "old");
		store.invalidate(ACCOUNT.id);
		resolve(SNAPSHOTS);
		await expect(pending).resolves.toBe(SNAPSHOTS);
		expect(store.get(ACCOUNT.id)).toBeUndefined();
		// 面板侧同一判据：捕获的代数号已过期，迟到的成功结果不应渲染。
		expect(store.isCurrentGeneration(ACCOUNT.id, generation)).toBe(false);
	});

	it("put 直接写入快照", () => {
		const store = new QuotaStore(async () => SNAPSHOTS);
		store.put(ACCOUNT.id, SNAPSHOTS);
		expect(store.get(ACCOUNT.id)).toBe(SNAPSHOTS);
	});

	it("invalidate 后旧 generation 失效", () => {
		const store = new QuotaStore(async () => SNAPSHOTS);
		const generation = store.generation(ACCOUNT.id);
		expect(store.isCurrentGeneration(ACCOUNT.id, generation)).toBe(true);
		store.invalidate(ACCOUNT.id);
		expect(store.generation(ACCOUNT.id)).toBe(generation + 1);
		expect(store.isCurrentGeneration(ACCOUNT.id, generation)).toBe(false);
	});

	it("put 后旧 generation 失效", () => {
		const store = new QuotaStore(async () => SNAPSHOTS);
		const generation = store.generation(ACCOUNT.id);
		store.put(ACCOUNT.id, SNAPSHOTS);
		expect(store.isCurrentGeneration(ACCOUNT.id, generation)).toBe(false);
		expect(store.isCurrentGeneration(ACCOUNT.id, store.generation(ACCOUNT.id))).toBe(true);
	});

	it("新 load 的 generation 完成后仍为当前", async () => {
		let resolve!: (value: QuotaSnapshot[]) => void;
		const store = new QuotaStore(
			() =>
				new Promise<QuotaSnapshot[]>((done) => {
					resolve = done;
				}),
		);
		const generation = store.generation(ACCOUNT.id);
		const pending = store.load(ACCOUNT, "sk-1");
		expect(store.generation(ACCOUNT.id)).toBe(generation);
		resolve(SNAPSHOTS);
		await expect(pending).resolves.toBe(SNAPSHOTS);
		expect(store.isCurrentGeneration(ACCOUNT.id, generation)).toBe(true);
		expect(store.get(ACCOUNT.id)).toBe(SNAPSHOTS);
	});
});
