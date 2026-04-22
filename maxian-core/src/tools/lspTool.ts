/*---------------------------------------------------------------------------------------------
 *  Maxian Core — LSP Tool (schema + 格式化)
 *
 *  对标 OpenCode `packages/opencode/src/tool/lsp.ts`
 *  工具执行真正由 server 侧的 LSP 管理器完成（需要运行时语言服务器进程），
 *  core 只定义输入/输出协议。
 *--------------------------------------------------------------------------------------------*/

export type LspOperation =
	| 'goToDefinition'
	| 'findReferences'
	| 'hover'
	| 'documentSymbol'
	| 'workspaceSymbol'
	| 'goToImplementation'
	| 'prepareCallHierarchy'
	| 'incomingCalls'
	| 'outgoingCalls'
	| 'diagnostics'
	| 'rename'
	| 'codeAction'
	| 'formatDocument'
	| 'organizeImports';

export interface ILspToolParams {
	operation: LspOperation;
	/** 文件路径（relative or absolute）—— 除 workspaceSymbol 外必需 */
	filePath?: string;
	/** 行号（1-based，编辑器显示值） */
	line?:     number;
	/** 列号/字符偏移（1-based） */
	character?: number;
	/** workspaceSymbol 查询字符串 */
	query?:    string;
	/** rename 新名字 */
	newName?:  string;
	/** codeAction 过滤：'quickfix' | 'refactor' | 'source' */
	codeActionKind?: string;
}

export interface ILspToolResult {
	operation:  string;
	title:      string;
	output:     string;
	/** 原始 LSP 结果（调试用，截断到避免爆炸） */
	metadata?:  any;
}

/** 简单格式化 LSP 结果为人类可读文本 */
export function formatLspResult(r: ILspToolResult): string {
	return `# LSP ${r.title}\n\n${r.output}`;
}
