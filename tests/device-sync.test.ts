import { describe, expect, it } from "vitest";
import {
	fingerprintCopy,
	initialExportEnabled,
	nextCopyGeneration,
	shouldDemoteExporter,
	shouldImportCopy,
} from "../src/device-sync";
import type { DeviceRecord } from "../src/types";

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
	return {
		id: "device-a",
		exportEnabled: false,
		copyGeneration: 0,
		imported: {},
		updatedAt: 0,
		...overrides,
	};
}

describe("fingerprintCopy", () => {
	it("同一副本稳定、不同副本不同，输出 16 位十六进制", async () => {
		const first = await fingerprintCopy("cipher-a");
		expect(first).toBe(await fingerprintCopy("cipher-a"));
		expect(first).toMatch(/^[0-9a-f]{16}$/);
		expect(await fingerprintCopy("cipher-b")).not.toBe(first);
	});
});

describe("shouldImportCopy", () => {
	const base = {
		isExporter: false,
		hasLocalSecret: true,
		copyFingerprint: "fingerprint-a",
		importedFingerprint: "fingerprint-a",
	};

	it("没有副本时不导入", () => {
		expect(shouldImportCopy({ ...base, copyFingerprint: null })).toBe(false);
	});

	it("本机无明文时，导出方与接收方都从副本还原", () => {
		expect(shouldImportCopy({ ...base, hasLocalSecret: false })).toBe(true);
		expect(shouldImportCopy({ ...base, hasLocalSecret: false, isExporter: true })).toBe(true);
	});

	it("接收方副本指纹变化时覆盖本机旧凭证", () => {
		expect(shouldImportCopy({ ...base, importedFingerprint: "fingerprint-old" })).toBe(true);
		expect(shouldImportCopy({ ...base, importedFingerprint: undefined })).toBe(true);
	});

	it("接收方副本未变化时不打扰", () => {
		expect(shouldImportCopy(base)).toBe(false);
	});

	it("导出方有明文时永不覆盖", () => {
		expect(shouldImportCopy({ ...base, isExporter: true, importedFingerprint: "fingerprint-old" })).toBe(false);
	});
});

describe("initialExportEnabled", () => {
	it("全部有副本的账号都有本机明文且没有其他导出方 → 导出方", () => {
		expect(initialExportEnabled(3, true, false)).toBe(true);
	});

	it("无副本 / 只有部分明文 / 已有其他导出方 → 接收方", () => {
		expect(initialExportEnabled(0, true, false)).toBe(false);
		expect(initialExportEnabled(3, false, false)).toBe(false);
		expect(initialExportEnabled(3, true, true)).toBe(false);
	});
});

describe("nextCopyGeneration", () => {
	it("取现有最大代次 + 1（空列表为 1）", () => {
		expect(nextCopyGeneration([])).toBe(1);
		expect(nextCopyGeneration([device({ copyGeneration: 2 }), device({ id: "b", copyGeneration: 7 })])).toBe(8);
	});
});

describe("shouldDemoteExporter", () => {
	it("接收方不参与降级", () => {
		expect(shouldDemoteExporter(device(), [], 3)).toBe(false);
	});

	it("没有任何副本时导出方降为接收方", () => {
		expect(shouldDemoteExporter(device({ exportEnabled: true, copyGeneration: 3 }), [], 0)).toBe(true);
	});

	it("存在更高代次的导出方时降级", () => {
		const own = device({ exportEnabled: true, copyGeneration: 2 });
		const other = device({ id: "device-b", exportEnabled: true, copyGeneration: 3 });
		expect(shouldDemoteExporter(own, [other], 3)).toBe(true);
	});

	it("同代次按设备 ID 字典序稳定决胜", () => {
		const own = device({ id: "device-b", exportEnabled: true, copyGeneration: 2 });
		const lower = device({ id: "device-a", exportEnabled: true, copyGeneration: 2 });
		const higher = device({ id: "device-c", exportEnabled: true, copyGeneration: 2 });
		expect(shouldDemoteExporter(own, [lower], 3)).toBe(true);
		expect(shouldDemoteExporter(own, [higher], 3)).toBe(false);
	});

	it("其他导出方代次更低时保持导出方", () => {
		const own = device({ exportEnabled: true, copyGeneration: 5 });
		const other = device({ id: "device-b", exportEnabled: true, copyGeneration: 3 });
		expect(shouldDemoteExporter(own, [other], 3)).toBe(false);
	});
});
