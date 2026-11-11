// 多设备导出/导入的纯逻辑（与宿主无关，单测直测，20261105）：
// 设备角色（导出方/接收方）的升级识别、副本指纹与「变化才覆盖导入」判定、单导出方代次仲裁。
// 不读写 data.json / SecretStorage，也不接触凭证明文。

import type { DeviceRecord } from "./types";

/** 副本指纹取 SHA-256 前 8 字节（16 位 hex）：只用于判断副本是否变化，不可逆推明文。 */
const FINGERPRINT_BYTES = 8;

export async function fingerprintCopy(encSecret: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encSecret));
	const bytes = new Uint8Array(digest).slice(0, FINGERPRINT_BYTES);
	let text = "";
	for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
	return text;
}

export interface ImportDecision {
	/** 本机是否为导出方（导出方从不被副本覆盖）。 */
	isExporter: boolean;
	/** 本机 SecretStorage 里是否已有该账号明文。 */
	hasLocalSecret: boolean;
	/** 当前 data.json 里的副本指纹；无副本为 null。 */
	copyFingerprint: string | null;
	/** 本机上次导入该账号时记下的指纹；从未导入为 undefined。 */
	importedFingerprint: string | undefined;
}

/** 覆盖式导入判定（用户拍板 20261105）：
 *  1. 有副本且本机无明文 → 任何角色都还原（恢复路径）；
 *  2. 本机是接收方且副本指纹变化 → 覆盖本机旧凭证；
 *  3. 接收方副本未变 → 不打扰；
 *  4. 导出方有明文 → 永不覆盖（本机即副本来源）。 */
export function shouldImportCopy(decision: ImportDecision): boolean {
	if (!decision.copyFingerprint) return false;
	if (!decision.hasLocalSecret) return true;
	if (decision.isExporter) return false;
	return decision.copyFingerprint !== decision.importedFingerprint;
}

/** 升级迁移时自动识别本机角色：对全部有副本的账号都存有明文，且当前没有其他导出方
 *  → 认定为导出方（大概率是原导出设备）；否则按接收方处理。 */
export function initialExportEnabled(
	copiedCount: number,
	allLocalPlaintext: boolean,
	otherExporterExists: boolean,
): boolean {
	return copiedCount > 0 && allLocalPlaintext && !otherExporterExists;
}

/** 新的副本代次 = 现有最大代次 + 1；导出方每次全量重建副本时使用。 */
export function nextCopyGeneration(devices: DeviceRecord[]): number {
	let max = 0;
	for (const device of devices) {
		if (device.copyGeneration > max) max = device.copyGeneration;
	}
	return max + 1;
}

/** 多导出方仲裁：同一时间只保留一个当前导出方。
 *  无副本时谁都当不了导出方；存在更高代次的导出方时降级；
 *  代次相同（例如两台设备各自升级）按设备 ID 字典序稳定决胜，避免两边都自认导出方。 */
export function shouldDemoteExporter(
	own: DeviceRecord,
	others: DeviceRecord[],
	copiedCount: number,
): boolean {
	if (!own.exportEnabled) return false;
	if (copiedCount === 0) return true;
	return others.some(
		(device) =>
			device.exportEnabled &&
			(device.copyGeneration > own.copyGeneration ||
				(device.copyGeneration === own.copyGeneration && device.id < own.id)),
	);
}
