import type { ProviderAdapter, ProviderId } from "../types";
import { commandCodeAdapter } from "./commandcode";
import { glmAdapter } from "./glm";
import { kimiAdapter } from "./kimi";
import { miniMaxAdapter } from "./minimax";
import { opencodeGoAdapter } from "./opencode-go";
import { volcengineAdapter } from "./volcengine";

// 适配器注册表：新厂商在此加一行，设置页与面板自动出现。

const REGISTRY: Record<ProviderId, ProviderAdapter> = {
	"opencode-go": opencodeGoAdapter,
	commandcode: commandCodeAdapter,
	volcengine: volcengineAdapter,
	glm: glmAdapter,
	"kimi-for-coding": kimiAdapter,
	minimax: miniMaxAdapter,
};

export function getAdapter(providerId: ProviderId): ProviderAdapter | undefined {
	return REGISTRY[providerId];
}

export function listAdapters(): ProviderAdapter[] {
	return Object.values(REGISTRY);
}
