/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Behavior Reporter Abstraction
 *
 *  行为埋点上报接口。Core 只定义接口，具体上报逻辑由消费方实现（IDE/Desktop 各自决定）。
 *--------------------------------------------------------------------------------------------*/

export interface IBehaviorReporter {
	setToken(token: string): void;
	reportSessionStart(): void;
	reportSessionEnd(): void;
	reportTaskStart(taskId: string): void;
	reportTaskEnd(taskId: string, status: 'success' | 'failed' | 'aborted'): void;
	reportToolUse(toolName: string): void;
	reportFeatureView(featureCode: string): void;
	reportFeatureLeave(featureCode: string): void;
	reportAiCall(
		model: string,
		tokensIn: number,
		tokensOut: number,
		cost: number,
		latencyMs: number,
		success: boolean
	): void;
}

/** 空操作实现（用于无埋点或测试场景） */
export class NoopBehaviorReporter implements IBehaviorReporter {
	setToken(): void { }
	reportSessionStart(): void { }
	reportSessionEnd(): void { }
	reportTaskStart(): void { }
	reportTaskEnd(): void { }
	reportToolUse(): void { }
	reportFeatureView(): void { }
	reportFeatureLeave(): void { }
	reportAiCall(): void { }
}
