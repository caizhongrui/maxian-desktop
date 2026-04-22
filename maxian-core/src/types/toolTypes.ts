/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Tool Types
 *
 *  所有工具的类型定义 — 纯类型，无平台依赖。
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具响应：字符串或多模态块数组（文本 + 图像）。
 */
export type ToolResponse =
	| string
	| Array<{ type: 'text'; text: string } | { type: 'image'; source: string }>;

/**
 * 工具执行阶段状态（枚举值）。
 * 注意：这与 taskTypes 中的 `ToolProgressStatus`（UI 展示对象）不同，
 * 后者供 ClineMessage.progressStatus 使用。
 */
export type ToolProgressLevel = 'loading' | 'pending' | 'success' | 'error' | 'info';

/** @deprecated 使用 ToolProgressLevel 替代，避免与 taskTypes.ToolProgressStatus 冲突 */
export type ToolProgressStatus = ToolProgressLevel;

/** 所有工具参数名称 */
export const toolParamNames = [
	'command',
	'path',
	'content',
	'line_count',
	'regex',
	'file_pattern',
	'recursive',
	'action',
	'url',
	'coordinate',
	'text',
	'server_name',
	'tool_name',
	'arguments',
	'uri',
	'question',
	'result',
	'diff',
	'mode_slug',
	'reason',
	'line',
	'mode',
	'message',
	'cwd',
	'follow_up',
	'task',
	'size',
	'search',
	'replace',
	'use_regex',
	'ignore_case',
	'title',
	'description',
	'target_file',
	'instructions',
	'code_edit',
	'files',
	'query',
	'args',
	'start_line',
	'end_line',
	'todos',
	'prompt',
	'image',
	'tool_calls',
	'edits',
	'old_string',
	'new_string',
	'replace_all',
	'create_if_missing',
	'patches',
	'subagent_type',
	'task_id',
	'operation',
	'column',
	'skill_name',
	'requires_approval',
	'options',
	'base_branch',
	'focus',
	'test_framework',
	'output_path',
	'output_mode',
	'head_limit',
	'offset',
	'max_depth',
] as const;

export type ToolParamName = (typeof toolParamNames)[number];

/** 所有工具名称 */
export const toolNames = [
	'execute_command',
	'read_file',
	'write_to_file',
	'delete_file',
	'create_directory',
	'search_files',
	'list_files',
	'list_code_definition_names',
	'codebase_search',
	'insert_content',
	'apply_diff',
	'edit_file',
	'edit',
	'glob',
	'ask_followup_question',
	'attempt_completion',
	'new_task',
	'update_todo_list',
	'batch',
	'multiedit',
	'task',
	'patch',
	'lsp',
	'lsp_hover',
	'lsp_diagnostics',
	'lsp_definition',
	'lsp_references',
	'lsp_type_definition',
	'skill',
	'todowrite',
	'todoread',
	'todo_write',
	'pr_review',
	'generate_tests',
	'use_mcp_tool',
	'access_mcp_resource',
] as const;

export type ToolName = (typeof toolNames)[number];

/** 文本内容块 */
export interface TextContent {
	type: 'text';
	content: string;
	partial: boolean;
}

/** 工具使用 */
export interface ToolUse {
	type: 'tool_use';
	name: ToolName;
	params: Partial<Record<ToolParamName, string>>;
	partial: boolean;
	toolUseId?: string;
}

// 具体工具类型
export interface ExecuteCommandToolUse extends ToolUse {
	name: 'execute_command';
	params: Partial<Pick<Record<ToolParamName, string>, 'command' | 'cwd' | 'requires_approval'>>;
}

export interface ReadFileToolUse extends ToolUse {
	name: 'read_file';
	params: Partial<Pick<Record<ToolParamName, string>, 'args' | 'path' | 'start_line' | 'end_line'>>;
}

export interface WriteToFileToolUse extends ToolUse {
	name: 'write_to_file';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'content' | 'line_count'>>;
}

export interface InsertCodeBlockToolUse extends ToolUse {
	name: 'insert_content';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'line' | 'content'>>;
}

export interface CodebaseSearchToolUse extends ToolUse {
	name: 'codebase_search';
	params: Partial<Pick<Record<ToolParamName, string>, 'query' | 'path' | 'file_pattern' | 'output_mode' | 'head_limit' | 'offset'>>;
}

export interface SearchFilesToolUse extends ToolUse {
	name: 'search_files';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'regex' | 'file_pattern' | 'output_mode' | 'head_limit' | 'offset'>>;
}

export interface ListFilesToolUse extends ToolUse {
	name: 'list_files';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'recursive' | 'max_depth'>>;
}

export interface ListCodeDefinitionNamesToolUse extends ToolUse {
	name: 'list_code_definition_names';
	params: Partial<Pick<Record<ToolParamName, string>, 'path'>>;
}

export interface AskFollowupQuestionToolUse extends ToolUse {
	name: 'ask_followup_question';
	params: Partial<Pick<Record<ToolParamName, string>, 'question' | 'follow_up' | 'options'>>;
}

export interface AttemptCompletionToolUse extends ToolUse {
	name: 'attempt_completion';
	params: Partial<Pick<Record<ToolParamName, string>, 'result'>>;
}

export interface NewTaskToolUse extends ToolUse {
	name: 'new_task';
	params: Partial<Pick<Record<ToolParamName, string>, 'mode' | 'message' | 'todos'>>;
}

export interface ApplyDiffToolUse extends ToolUse {
	name: 'apply_diff';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'diff' | 'start_line'>>;
}

export interface EditFileToolUse extends ToolUse {
	name: 'edit_file';
	params: Required<Pick<Record<ToolParamName, string>, 'target_file' | 'instructions' | 'code_edit'>>;
}

export interface GlobToolUse extends ToolUse {
	name: 'glob';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'file_pattern'>>;
}

export interface LspHoverToolUse extends ToolUse {
	name: 'lsp_hover';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'line' | 'column'>>;
}

export interface LspToolUse extends ToolUse {
	name: 'lsp';
	params: Partial<Pick<Record<ToolParamName, string>, 'operation' | 'path' | 'line' | 'column'>>;
}

export interface LspDiagnosticsToolUse extends ToolUse {
	name: 'lsp_diagnostics';
	params: Partial<Pick<Record<ToolParamName, string>, 'path'>>;
}

export interface LspDefinitionToolUse extends ToolUse {
	name: 'lsp_definition';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'line' | 'column'>>;
}

export interface LspReferencesToolUse extends ToolUse {
	name: 'lsp_references';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'line' | 'column'>>;
}

export interface LspTypeDefinitionToolUse extends ToolUse {
	name: 'lsp_type_definition';
	params: Partial<Pick<Record<ToolParamName, string>, 'path' | 'line' | 'column'>>;
}

export interface PrReviewToolUse extends ToolUse {
	name: 'pr_review';
	params: Partial<Pick<Record<ToolParamName, string>, 'base_branch' | 'focus'>>;
}

export interface GenerateTestsToolUse extends ToolUse {
	name: 'generate_tests';
	params: Partial<Pick<Record<ToolParamName, string>, 'target_file' | 'test_framework' | 'output_path'>>;
}

/** 工具显示名称 */
export const TOOL_DISPLAY_NAMES: Record<ToolName, string> = {
	execute_command: '执行命令',
	read_file: '读取文件',
	write_to_file: '写入文件',
	delete_file: '删除文件',
	create_directory: '创建目录',
	search_files: '搜索文件',
	list_files: '列出文件',
	list_code_definition_names: '列出代码定义',
	codebase_search: '代码库搜索',
	insert_content: '插入内容',
	apply_diff: '应用差异',
	edit_file: '编辑文件',
	edit: '编辑(容错)',
	glob: 'Glob模式匹配',
	ask_followup_question: '提问',
	attempt_completion: '完成任务',
	new_task: '创建新任务',
	update_todo_list: '更新待办列表',
	batch: '批量执行',
	multiedit: '多处编辑',
	task: '子任务委托',
	patch: '多文件补丁',
	lsp: 'LSP查询',
	lsp_hover: 'LSP悬停',
	lsp_diagnostics: 'LSP诊断',
	lsp_definition: 'LSP定义',
	lsp_references: 'LSP引用',
	lsp_type_definition: 'LSP类型定义',
	skill: '加载专业知识',
	todowrite: '写入待办列表',
	todoread: '读取待办列表',
	todo_write: '规划 TODO 列表',
	pr_review: 'PR代码审查',
	generate_tests: '生成测试代码',
	use_mcp_tool: '调用MCP工具',
	access_mcp_resource: '访问MCP资源',
} as const;

/** 工具分组 */
export type ToolGroup = 'read' | 'edit' | 'command' | 'lsp' | 'agent' | 'skills';

export type ToolGroupConfig = {
	tools: readonly string[];
	alwaysAvailable?: boolean;
};

export const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
	read: {
		tools: [
			'read_file',
			'search_files',
			'list_files',
			'list_code_definition_names',
			'codebase_search',
			'glob',
			'pr_review',
			'generate_tests',
		],
	},
	edit: {
		tools: [
			'apply_diff',
			'edit',
			'write_to_file',
			'delete_file',
			'create_directory',
			'multiedit',
			'patch',
		],
	},
	command: {
		tools: ['execute_command'],
	},
	lsp: {
		tools: ['lsp'],
	},
	agent: {
		tools: ['task', 'batch'],
	},
	skills: {
		tools: ['skill'],
		alwaysAvailable: true,
	},
};

/** 始终可用的工具 */
export const ALWAYS_AVAILABLE_TOOLS: ToolName[] = [
	'ask_followup_question',
	'attempt_completion',
	'new_task',
	'todowrite',
	'todo_write',
	'skill',
] as const;
