/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Plan Exit Tool
 *
 *  对标 OpenCode `packages/opencode/src/tool/plan.ts`
 *  Plan 模式下 AI 规划完毕后调用此工具请求切换到 Build 模式。
 *  服务端拦截此工具调用，挂起 Agent 循环并向用户展示"开始执行"确认对话框。
 *--------------------------------------------------------------------------------------------*/

export interface IPlanExitParams {
	/** 计划摘要（用于给用户确认） */
	summary:   string;
	/** 详细步骤 Markdown（可选） */
	steps?:    string;
}

export interface IPlanExitResult {
	/** 用户是否同意切换到 build 模式 */
	approved:  boolean;
	/** 用户是否拒绝并给出反馈 */
	feedback?: string;
}

export function formatPlanExitResult(r: IPlanExitResult): string {
	if (r.approved) return '[用户已同意，现在切换到 Build（Code）模式执行计划]';
	return `[用户拒绝当前计划${r.feedback ? `: ${r.feedback}` : ''}，请根据反馈重新规划]`;
}
