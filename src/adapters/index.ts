import type { ProviderAdapter, ProviderId } from "../types";
import { commandCodeAdapter } from "./commandcode";
import { opencodeGoAdapter } from "./opencode-go";

// 适配器注册表：新厂商在此加一行，设置页与面板自动出现。

const REGISTRY: Record<ProviderId, ProviderAdapter> = {
	"opencode-go": opencodeGoAdapter,
	commandcode: commandCodeAdapter,
};

export function getAdapter(providerId: ProviderId): ProviderAdapter | undefined {
	return REGISTRY[providerId];
}

export function listAdapters(): ProviderAdapter[] {
	return Object.values(REGISTRY);
}
