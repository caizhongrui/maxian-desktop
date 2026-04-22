/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Question Tool
 *
 *  对标 OpenCode `packages/opencode/src/tool/question.ts`
 *  Agent 调用此工具后被挂起，等待用户回答；
 *  工具本身只定义参数 schema & 格式化，真正"阻塞等待"由 server 侧实现。
 *--------------------------------------------------------------------------------------------*/

export interface IQuestionToolParams {
	/** 问题内容 */
	question:  string;
	/** 可选的预设选项，用户可快速点击 */
	options?:  string[];
	/** 多选还是单选（默认单选） */
	multi?:    boolean;
}

export interface IQuestionToolResult {
	/** 用户的原始回答 */
	answer:   string;
	/** 若是选项：用户选中的项（可多个） */
	selected?: string[];
	/** 是否被取消 */
	cancelled: boolean;
}

export function formatQuestionResult(r: IQuestionToolResult): string {
	if (r.cancelled) return '[用户取消了提问，请不要重复询问同一问题，改为根据已有上下文自行决定]';
	if (r.selected && r.selected.length > 0) {
		return `用户选择：${r.selected.join(', ')}${r.answer ? `\n补充：${r.answer}` : ''}`;
	}
	return `用户回答：${r.answer}`;
}
