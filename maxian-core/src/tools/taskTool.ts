/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Task Tool (子 Agent spawn)
 *
 *  对标 OpenCode `packages/opencode/src/tool/task.ts`
 *  Agent 调用此工具派发一个独立上下文的"子 Agent"去完成特定任务，
 *  子任务完成后把结果文本回传给主 Agent，主 Agent 继续推进。
 *
 *  subagent_type：
 *    - explore: 只读，用于大量搜索/阅读代码但不改动（节省主 Agent 上下文）
 *    - build:   完整权限，独立执行一个子任务
 *    - review:  只读，用于代码审查/验证
 *
 *  工具本身只定义 schema，真正的 spawn 由 server 侧 agent loop 递归完成。
 *--------------------------------------------------------------------------------------------*/

export interface ITaskToolParams {
	/** 子任务描述（给子 Agent 的 prompt） */
	prompt:         string;
	/** 子 Agent 类型（explore / build / review） */
	subagent_type:  'explore' | 'build' | 'review';
	/** 简短描述（给用户展示的 label） */
	description?:   string;
}

export interface ITaskToolResult {
	/** 子 Agent 最终输出 */
	output:  string;
	/** 子任务所用 tokens（approx） */
	tokens?: number;
	/** 子任务是否成功完成 */
	success: boolean;
	/** 失败时的错误 */
	error?:  string;
}

export function formatTaskResult(r: ITaskToolResult, params: ITaskToolParams): string {
	const hdr = `# 子任务 [${params.subagent_type}] ${r.success ? '✓' : '✗'}\n` +
		(params.description ? `${params.description}\n` : '') +
		(r.tokens ? `用量 ${r.tokens} tokens\n` : '') +
		'---\n';
	if (!r.success) return hdr + `失败: ${r.error ?? '未知错误'}`;
	return hdr + r.output;
}
