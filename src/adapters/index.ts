import type { ProviderAdapter, ProviderId } from "../types";
import { commandCodeAdapter } from "./commandcode";
import { deepSeekAdapter } from "./deepseek";
import { glmAdapter } from "./glm";
import { kimiAdapter } from "./kimi";
import { mimoAdapter } from "./mimo";
import { miniMaxAdapter } from "./minimax";
import { moonshotAdapter } from "./moonshot";
import { opencodeGoAdapter } from "./opencode-go";
import { ppioAdapter } from "./ppio";
import { siliconFlowAdapter } from "./siliconflow";
import { siliconFlowCookieAdapter } from "./siliconflow-cookie";
import { stepFunAdapter } from "./stepfun";
import { volcengineAdapter } from "./volcengine";
import { volcengineConsoleAdapter } from "./volcengine-console";

// 适配器注册表：新厂商在此加一行，设置页与面板自动出现。

const REGISTRY: Record<ProviderId, ProviderAdapter> = {
	"opencode-go": opencodeGoAdapter,
	commandcode: commandCodeAdapter,
	volcengine: volcengineAdapter,
	"volcengine-console": volcengineConsoleAdapter,
	glm: glmAdapter,
	"kimi-for-coding": kimiAdapter,
	minimax: miniMaxAdapter,
	deepseek: deepSeekAdapter,
	siliconflow: siliconFlowAdapter,
	"siliconflow-cookie": siliconFlowCookieAdapter,
	moonshot: moonshotAdapter,
	stepfun: stepFunAdapter,
	ppio: ppioAdapter,
	mimo: mimoAdapter,
};

export function getAdapter(providerId: ProviderId): ProviderAdapter | undefined {
	return REGISTRY[providerId];
}

export function listAdapters(): ProviderAdapter[] {
	return Object.values(REGISTRY);
}
