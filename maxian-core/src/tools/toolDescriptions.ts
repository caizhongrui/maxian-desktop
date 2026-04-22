/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具详细描述
 * 参考 OpenCode 的工具描述格式，包含：
 * - 详细的使用说明
 * - 具体示例
 * - 边界情况处理
 * - 性能提示
 * - 常见错误
 */

import { ToolName } from '../types/toolTypes.js';

/**
 * 工具描述接口
 */
export interface ToolDescription {
	/** 工具名称 */
	name: ToolName;
	/** 简短描述 */
	summary: string;
	/** 详细描述 */
	description: string;
	/** 参数说明 */
	parameters: ParameterDescription[];
	/** 使用示例 */
	examples: ToolExample[];
	/** 重要提示 */
	tips?: string[];
	/** 常见错误 */
	commonErrors?: ErrorHint[];
	/** 性能提示 */
	performanceTips?: string[];
	/** 相关工具 */
	relatedTools?: ToolName[];
}

/**
 * 参数描述
 */
export interface ParameterDescription {
	name: string;
	type: string;
	required: boolean;
	description: string;
	default?: string;
	examples?: string[];
}

/**
 * 工具示例
 */
export interface ToolExample {
	title: string;
	description: string;
	xml: string;
	result?: string;
}

/**
 * 错误提示
 */
export interface ErrorHint {
	error: string;
	cause: string;
	solution: string;
}

/**
 * 所有工具的详细描述
 */
export const TOOL_DESCRIPTIONS: Record<string, ToolDescription> = {
	// ==================== 文件读取工具 ====================
	read_file: {
		name: 'read_file',
		summary: '读取文件内容',
		description: `读取指定路径的文件。可以读取此机器上的任何文件。

**重要：** 在使用任何编辑工具（edit、write_to_file、apply_diff）之前，必须先使用此工具读取文件当前内容。这是强制要求！

**支持的文件类型：**
- 普通文本文件（默认，最多读取 2000 行）
- 图片文件（PNG、JPG 等）— 以视觉方式呈现给 AI
- Jupyter Notebook（.ipynb）— 返回所有单元格及输出
- 目录无法读取，请使用 list_files 或 glob

**分段读取指导（对大文件至关重要）：**
- 若已知需要哪部分，请只读取该部分（使用 start_line/end_line），这对大文件非常重要
- 若不指定，默认从头读取最多 2000 行
- 超过 2000 行的大文件必须用 start_line/end_line 分段读取

**文件未变更时的行为：**
- 若该文件在本次对话中已被读取且内容未发生变化，工具将返回"文件未变更"提示
- 此时无需重新读取，直接使用上次读取结果即可`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '要读取的文件路径（相对于工作区根目录或绝对路径）',
				examples: ['src/index.ts', '/home/user/project/config.json'],
			},
			{
				name: 'start_line',
				type: 'number',
				required: false,
				description: '起始行号（从1开始）。已知需要某部分时务必指定，对大文件尤其重要',
				default: '1',
			},
			{
				name: 'end_line',
				type: 'number',
				required: false,
				description: '结束行号（包含）',
				default: '文件末尾（最多 2000 行）',
			},
		],
		examples: [
			{
				title: '读取整个文件',
				description: '读取 package.json 的完整内容',
				xml: `<read_file>
<path>package.json</path>
</read_file>`,
			},
			{
				title: '读取指定行范围',
				description: '只读取第 100-200 行（大文件分段读取）',
				xml: `<read_file>
<path>src/main.ts</path>
<start_line>100</start_line>
<end_line>200</end_line>
</read_file>`,
			},
		],
		tips: [
			'文件内容以 cat -n 格式返回，带行号，从第 1 行开始',
			'已知需要哪部分时只读取那部分，这对大文件至关重要',
			'读取后内容会被缓存：若文件未修改，再次读取会返回"文件未变更"提示',
			'返回"文件未变更"时，直接使用上一次的读取内容，无需重新读取',
		],
		commonErrors: [
			{
				error: '文件不存在',
				cause: '路径错误或文件已被删除',
				solution: '使用 list_files 或 glob 确认文件路径',
			},
			{
				error: '权限不足',
				cause: '文件没有读取权限',
				solution: '检查文件权限设置',
			},
		],
		performanceTips: [
			'超过 2000 行的大文件必须分段读取，使用 start_line/end_line',
			'用 search_files 定位具体行号后再分段读取，避免盲目读取整文件',
		],
		relatedTools: ['write_to_file', 'edit', 'search_files'],
	},

	// ==================== 文件写入工具 ====================
	write_to_file: {
		name: 'write_to_file',
		summary: '写入文件内容（仅限新建或完全重写）',
		description: `将内容写入指定文件。如果文件不存在会自动创建（包括必要的目录）。

**⚠️ 严格限制：**
- **仅用于创建新文件**，或确实需要完全重写的场景
- **绝对禁止用于修改已有文件的部分内容**——必须使用 edit 或 apply_diff
- 对已有文件使用此工具会丢失所有未包含的内容！

**正确用法：**
- ✅ 创建全新文件（文件不存在）
- ✅ 对文件进行彻底重构（超过80%内容需要改变）
- ❌ 修改函数实现 → 使用 edit
- ❌ 添加新方法 → 使用 edit 或 apply_diff
- ❌ 修改配置项 → 使用 edit
- ❌ 主动生成 README、说明文档、*.md → 除非用户明确要求`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '要写入的文件路径',
			},
			{
				name: 'content',
				type: 'string',
				required: true,
				description: '要写入的完整内容',
			},
		],
		examples: [
			{
				title: '创建新文件',
				description: '创建一个新的配置文件',
				xml: `<write_to_file>
<path>config/settings.json</path>
<content>{
  "debug": true,
  "logLevel": "info"
}</content>
</write_to_file>`,
			},
			{
				title: '重写整个文件',
				description: '注意：必须先用 read_file 读取',
				xml: `<write_to_file>
<path>src/constants.ts</path>
<content>export const VERSION = '2.0.0';
export const API_URL = 'https://api.example.com';
</content>
</write_to_file>`,
			},
		],
		tips: [
			'创建新文件时，目录会自动创建',
			'对于已存在的文件，必须先用 read_file 读取',
			'内容不要包含多余的空行或空格',
		],
		commonErrors: [
			{
				error: '文件已被外部修改',
				cause: '读取后文件被其他程序修改',
				solution: '重新读取文件后再写入',
			},
		],
		performanceTips: [
			'大文件写入可能较慢',
			'频繁写入同一文件会触发保护机制',
		],
		relatedTools: ['read_file', 'edit', 'apply_diff'],
	},

	// ==================== Delete 工具 ====================
	delete_file: {
		name: 'delete_file',
		summary: '删除文件或目录',
		description: `使用 VS Code 内置文件服务删除文件或目录。

**重要说明：**
- 必须使用此工具删除文件，不要用 execute_command 执行 rm 命令
- 使用 rm 命令删除的文件不会更新 VS Code 文件系统缓存，文件依然"存在"于编辑器中
- 此工具使用 VS Code IFileService 确保文件系统状态同步

**注意事项：**
- 删除操作不可逆，请谨慎使用
- 删除目录时需要将 recursive 设为 true`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '要删除的文件或目录路径（相对于工作区根目录或绝对路径）',
			},
			{
				name: 'recursive',
				type: 'boolean',
				required: false,
				description: '是否递归删除目录内容，默认 false。删除非空目录时必须设为 true',
				default: 'false',
			},
		],
		examples: [
			{
				title: '删除文件',
				description: '删除单个文件',
				xml: `<delete_file>
<path>src/old-module.ts</path>
</delete_file>`,
			},
			{
				title: '递归删除目录',
				description: '删除整个目录（非空目录需加 recursive）',
				xml: `<delete_file>
<path>src/deprecated/</path>
<recursive>true</recursive>
</delete_file>`,
			},
		],
		tips: [
			'删除操作不可撤销，确认路径正确后再执行',
			'删除目录时记得设置 recursive=true，否则非空目录会报错',
		],
		relatedTools: ['write_to_file', 'list_files'],
	},

	// ==================== Create Directory 工具 ====================
	create_directory: {
		name: 'create_directory',
		summary: '创建目录',
		description: `使用 VS Code 内置文件服务创建目录（支持递归创建多级目录）。

**重要说明：**
- 必须使用此工具创建目录，不要用 execute_command 执行 mkdir 命令
- 使用 mkdir 命令创建的目录不会更新 VS Code 文件系统缓存，目录在资源管理器中不可见
- 此工具使用 VS Code IFileService 确保文件系统状态同步
- 自动递归创建多级父目录（等同于 mkdir -p）`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '要创建的目录路径（相对于工作区根目录或绝对路径），支持多级路径',
			},
		],
		examples: [
			{
				title: '创建单级目录',
				description: '在工作区下创建目录',
				xml: `<create_directory>
<path>src/utils</path>
</create_directory>`,
			},
			{
				title: '创建多级目录',
				description: '递归创建不存在的父目录',
				xml: `<create_directory>
<path>src/main/java/com/example/service/impl</path>
</create_directory>`,
			},
		],
		tips: [
			'自动创建所有不存在的父目录，无需逐级创建',
			'如果目录已存在，会返回成功提示而非报错',
		],
		relatedTools: ['write_to_file', 'delete_file', 'list_files'],
	},

	// ==================== Edit 工具（核心） ====================
	edit: {
		name: 'edit',
		summary: '编辑文件内容（推荐）',
		description: `通过指定要替换的旧内容和新内容来编辑文件。这是最推荐的文件编辑方式。

**核心规则：**
- 使用前必须先 read_file 完整读取文件
- old_string 必须与文件中的内容精确匹配（包括空白和缩进）
- 如果 old_string 不存在，工具会失败
- 如果 old_string 命中多处且 replace_all=false，工具会失败
- 失败后不要按同样方式重试，应重新读取文件或补充更多上下文`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '要编辑的文件路径',
			},
			{
				name: 'old_string',
				type: 'string',
				required: true,
				description: '要被替换的原始内容（必须与文件中的内容匹配）',
			},
			{
				name: 'new_string',
				type: 'string',
				required: true,
				description: '替换后的新内容',
			},
			{
				name: 'replace_all',
				type: 'boolean',
				required: false,
				description: '是否替换所有匹配项',
				default: 'false',
			},
		],
		examples: [
			{
				title: '修改函数实现',
				description: '给函数添加参数验证',
				xml: `<edit>
<path>src/utils/math.ts</path>
<old_string>function add(a: number, b: number): number {
    return a + b;
}</old_string>
<new_string>function add(a: number, b: number): number {
    if (typeof a !== 'number' || typeof b !== 'number') {
        throw new Error('Parameters must be numbers');
    }
    return a + b;
}</new_string>
</edit>`,
			},
			{
				title: '全局替换',
				description: '替换所有 DEBUG = false',
				xml: `<edit>
<path>src/config.ts</path>
<old_string>DEBUG = false</old_string>
<new_string>DEBUG = true</new_string>
<replace_all>true</replace_all>
</edit>`,
			},
			{
				title: '添加导入语句',
				description: '在文件开头添加新的导入',
				xml: `<edit>
<path>src/index.ts</path>
<old_string>import { Component } from 'react';</old_string>
<new_string>import { Component, useState } from 'react';
import { useQuery } from 'react-query';</new_string>
</edit>`,
			},
		],
		tips: [
			'old_string 要尽量精确，包含足够的上下文以唯一定位',
			'如果匹配失败，先重新读取文件，不要继续沿用旧的 old_string',
			'变量重命名或同文件多处修改时优先使用 multiedit',
		],
		commonErrors: [
			{
				error: '未找到匹配内容',
				cause: 'old_string 与文件内容不匹配',
				solution: '使用 read_file 重新查看文件内容，确保 old_string 完全匹配',
			},
			{
				error: '多处匹配',
				cause: 'old_string 在文件中出现多次',
				solution: '添加更多上下文使匹配唯一，或使用 replace_all',
			},
		],
		performanceTips: [
			'edit 比 write_to_file 更高效，因为只传输变化部分',
			'对于多处修改，使用 multiedit 一次性完成',
		],
		relatedTools: ['read_file', 'multiedit', 'apply_diff'],
	},

	// ==================== 批量执行工具（参考OpenCode最佳实践）====================
	batch: {
		name: 'batch',
		summary: '并行执行多个工具（主要用于只读探索）',
		description: `并行执行多个独立工具调用，主要用于减少只读探索的往返次数。

**推荐用例**（以只读操作为主）：
- 读取多个文件（read_file × N）
- 多个搜索操作（search_files、glob、list_files、codebase_search）
- 搜索 + 读取组合
- LSP查询（统一使用 lsp，operation=...）

**性能提升**：在多文件探索阶段使用 batch，通常能减少无意义往返。

**重要规则**：
- 最多 **25** 个工具调用
- 所有调用并行执行，**不保证顺序**
- 部分失败**不影响**其他工具
- **不允许嵌套**batch调用
- 写操作默认不要放进 batch；逐步写入和验证更安全

**禁止在batch中使用的工具**：
- batch（禁止嵌套）
- ask_followup_question（需要用户输入，并行无意义）
- attempt_completion（任务完成信号）`,
		parameters: [
			{
				name: 'tool_calls',
				type: 'array',
				required: true,
				description: '要并行执行的工具调用数组（1-25个）',
				examples: ['[{"tool": "read_file", "params": {"path": "a.ts"}}, {"tool": "read_file", "params": {"path": "b.ts"}}]'],
			},
		],
		examples: [
			{
				title: '并行读取多个文件',
				description: '同时读取3个配置文件',
				xml: `<batch>
<tool_calls>[
  {"tool": "read_file", "params": {"path": "package.json"}},
  {"tool": "read_file", "params": {"path": "tsconfig.json"}},
  {"tool": "read_file", "params": {"path": ".eslintrc.json"}}
]</tool_calls>
</batch>`,
			},
			{
				title: '组合搜索操作',
				description: 'grep + glob + read 组合',
				xml: `<batch>
<tool_calls>[
  {"tool": "search_files", "params": {"path": "src", "regex": "TODO"}},
  {"tool": "glob", "params": {"pattern": "**/*.test.ts"}},
  {"tool": "read_file", "params": {"path": "README.md"}}
]</tool_calls>
</batch>`,
			},
		],
		tips: [
			'只并行执行独立操作，有依赖关系的操作要顺序执行',
			'优先把 batch 用在 read_file / search_files / glob / list_files 这类只读工具上',
			'每个工具调用的结果会分别返回',
		],
		performanceTips: [
			'并行读取5个文件比顺序读取快约5倍',
			'建议一次batch不超过25个操作',
		],
		relatedTools: ['read_file', 'search_files', 'glob', 'list_files'],
	},

	// ==================== 多处编辑工具 ====================
	multiedit: {
		name: 'multiedit',
		summary: '单文件多处编辑',
		description: `在单个文件中执行多处编辑操作。比多次调用 edit 更高效。

**使用场景：**
- 重命名变量（多处替换）
- 修改多个函数
- 添加多处日志
- 批量修复代码风格

**编辑按顺序执行，所有 old_string 都必须精确匹配；任一编辑失败，整个 multiedit 失败。**`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '要编辑的文件路径',
			},
			{
				name: 'edits',
				type: 'array',
				required: true,
				description: '编辑操作数组，每个包含 old_string 和 new_string',
			},
		],
		examples: [
			{
				title: '重命名变量',
				description: '将 userName 重命名为 currentUser',
				xml: `<multiedit>
<path>src/user.ts</path>
<edits>[
  {"old_string": "const userName", "new_string": "const currentUser"},
  {"old_string": "return userName", "new_string": "return currentUser"},
  {"old_string": "userName:", "new_string": "currentUser:"}
]</edits>
</multiedit>`,
			},
			{
				title: '添加错误处理',
				description: '给多个函数添加 try-catch',
				xml: `<multiedit>
<path>src/api.ts</path>
<edits>[
  {
    "old_string": "async function fetchUsers() {",
    "new_string": "async function fetchUsers() {\\n  try {"
  },
  {
    "old_string": "async function fetchOrders() {",
    "new_string": "async function fetchOrders() {\\n  try {"
  }
]</edits>
</multiedit>`,
			},
		],
		tips: [
			'编辑会从文件开头到结尾顺序执行',
			'后续编辑的位置会根据前面编辑的变化自动调整',
			'如果某个编辑失败，先重新读取文件，再缩小 old_string 范围或补更多上下文',
		],
		performanceTips: [
			'比多次调用 edit 快约 3 倍',
			'适合 3 处以上的修改',
		],
		relatedTools: ['edit', 'batch'],
	},

	// ==================== 搜索工具 ====================
	search_files: {
		name: 'search_files',
		summary: '正则搜索文件内容',
		description: `使用正则表达式在文件中搜索内容。

**功能：**
- 支持完整的正则表达式语法
- 可限制搜索的文件类型
- 支持递归搜索子目录

**重要：**
- 这个工具只负责搜索文件内容，不负责找文件名
- 如果你其实是在找路径或文件名，请用 glob 或 list_files
- 同类搜索连续两次没有推进时，立即换策略`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '搜索的目录路径',
			},
			{
				name: 'regex',
				type: 'string',
				required: true,
				description: '搜索的正则表达式',
			},
			{
				name: 'file_pattern',
				type: 'string',
				required: false,
				description: '文件名模式（glob格式）',
				examples: ['*.ts', '*.{js,jsx}'],
			},
			{
				name: 'output_mode',
				type: 'string',
				required: false,
				description: '输出模式：files_with_matches（默认，只返回文件路径，节省 Token）| content（返回匹配行内容）| count（只返回数量）',
				default: 'files_with_matches',
			},
			{
				name: 'head_limit',
				type: 'number',
				required: false,
				description: '最多返回结果数量（默认 250）',
				default: '250',
			},
			{
				name: 'offset',
				type: 'number',
				required: false,
				description: '跳过前 N 条结果（用于分页，默认 0）',
			},
		],
		examples: [
			{
				title: '搜索并获取匹配文件列表（默认，省 Token）',
				description: '只返回文件路径，适合先定位再读取',
				xml: `<search_files>
<path>src</path>
<regex>TODO:.*</regex>
</search_files>`,
			},
			{
				title: '搜索并返回匹配内容',
				description: '需要查看匹配行时用 content 模式',
				xml: `<search_files>
<path>.</path>
<regex>async function \\w+</regex>
<file_pattern>*.ts</file_pattern>
<output_mode>content</output_mode>
</search_files>`,
			},
		],
		tips: [
			'默认 output_mode=files_with_matches，只返回文件路径，比 content 模式节省 10-40x Token',
			'正则表达式使用 JavaScript 语法',
			'使用 file_pattern 限制搜索范围能显著提速',
			'不要用 search_files 查文件名；文件名问题一律改用 glob',
			'结果被截断时（超过 head_limit），请使用更精确的 regex 或 file_pattern 缩小范围，或增大 head_limit',
			'使用 offset 参数可以分页获取：第一页 offset=0，第二页 offset=250，以此类推',
		],
		relatedTools: ['codebase_search', 'glob'],
	},

	// ==================== 代码库搜索工具 ====================
	codebase_search: {
		name: 'codebase_search',
		summary: '自然语言代码搜索',
		description: `使用自然语言在代码库中做兜底搜索。实现上仍基于文本匹配，因此不要把它当成真正的向量语义引擎。

**适用场景：**
- 搜索特定功能的实现
- 查找相关的代码逻辑
- 理解代码结构

**不适用：**
- 已知精确关键词时，优先 search_files
- 已知文件路径时，直接 read_file
- 需要文件名搜索时，改用 glob`,
		parameters: [
			{
				name: 'query',
				type: 'string',
				required: true,
				description: '搜索查询（自然语言描述）',
				examples: ['用户认证逻辑', 'error handling', '数据库连接'],
			},
			{
				name: 'path',
				type: 'string',
				required: false,
				description: '限制搜索的目录',
			},
		],
		examples: [
			{
				title: '搜索认证代码',
				description: '查找用户登录相关代码',
				xml: `<codebase_search>
<query>用户登录验证</query>
<path>src</path>
</codebase_search>`,
			},
		],
		relatedTools: ['search_files', 'list_code_definition_names'],
	},

	// ==================== Glob 工具 ====================
	glob: {
		name: 'glob',
		summary: '按模式匹配文件',
		description: `使用 glob 模式匹配文件路径。

**常用模式：**
- \`*.ts\` - 当前目录所有 ts 文件
- \`**/*.ts\` - 递归所有 ts 文件
- \`src/**/*.{ts,tsx}\` - src 下所有 ts/tsx 文件
- \`!node_modules\` - 排除 node_modules

**重要：**
- 这个工具用于找文件名和路径，不用于搜文件内容
- 路径不确定时先用 glob，不要直接 read_file 试错`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: false,
				description: '搜索的基础目录',
				default: '工作区根目录',
			},
			{
				name: 'file_pattern',
				type: 'string',
				required: true,
				description: 'glob 模式',
			},
		],
		examples: [
			{
				title: '查找所有测试文件',
				description: '',
				xml: `<glob>
<file_pattern>**/*.test.ts</file_pattern>
</glob>`,
			},
			{
				title: '查找配置文件',
				description: '',
				xml: `<glob>
<file_pattern>**/*.config.{js,ts,json}</file_pattern>
</glob>`,
			},
		],
		tips: [
			'结果按修改时间降序排列，最近修改的文件优先',
			'结果被截断时请使用更精确的 path 或 pattern 缩小范围，例如 src/**/*.ts 而非 **/*.ts',
			'结合 search_files 使用：先用 glob 找文件，再用 search_files 搜内容',
			'当你是在找 pom.xml、package.json 这类文件名时，优先用 glob',
		],
		relatedTools: ['list_files', 'search_files'],
	},

	// ==================== 列出文件工具 ====================
	list_files: {
		name: 'list_files',
		summary: '列出目录内容',
		description: `列出指定目录下的文件和子目录。

**用于：**
- 了解项目结构
- 查找文件位置
- 确认目录是否存在`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '要列出的目录路径',
			},
			{
				name: 'recursive',
				type: 'boolean',
				required: false,
				description: '是否递归列出子目录',
				default: 'false',
			},
		],
		examples: [
			{
				title: '列出 src 目录',
				description: '',
				xml: `<list_files>
<path>src</path>
</list_files>`,
			},
			{
				title: '递归列出',
				description: '',
				xml: `<list_files>
<path>src/components</path>
<recursive>true</recursive>
</list_files>`,
			},
		],
		relatedTools: ['glob', 'search_files'],
	},

	// ==================== 执行命令工具 ====================
	execute_command: {
		name: 'execute_command',
		summary: '执行终端命令',
		description: `在终端中执行命令。

**⚠️ requires_approval 参数（重要！参考Cline）：**
- 当命令会产生副作用或影响系统状态时，必须设置 \`requires_approval: true\`
- \`true\`（需要用户确认）：安装/卸载依赖、删除文件、写入磁盘、网络请求、修改系统配置
- \`false\`（可直接执行）：读取文件、查看状态(git status)、运行测试、构建、grep/find等只读操作

**安全限制：**
- 危险命令可能被直接拒绝（rm -rf、mkfs等）
- 长时间运行的命令有超时限制
- 交互式命令不支持

**支持的命令类型：**
- 构建命令：npm run build, yarn build
- 测试命令：npm test, jest
- Git 命令：git status, git diff
- 文件操作：ls, mkdir, cp, mv`,
		parameters: [
			{
				name: 'command',
				type: 'string',
				required: true,
				description: '要执行的命令',
			},
			{
				name: 'requires_approval',
				type: 'boolean',
				required: true,
				description: '命令是否需要用户确认才能执行。有副作用的操作设 true（安装包、删除文件、网络操作等），只读操作设 false（git status、读取文件、运行测试等）',
				examples: ['true', 'false'],
			},
			{
				name: 'cwd',
				type: 'string',
				required: false,
				description: '命令执行的工作目录',
				default: '工作区根目录',
			},
		],
		examples: [
			{
				title: '运行测试（不需要确认）',
				description: '只读操作，直接执行',
				xml: `<execute_command>
<command>npm test</command>
<requires_approval>false</requires_approval>
</execute_command>`,
			},
			{
				title: '安装依赖（需要确认）',
				description: '会修改 node_modules 和 package-lock.json，需要用户同意',
				xml: `<execute_command>
<command>npm install lodash</command>
<requires_approval>true</requires_approval>
</execute_command>`,
			},
			{
				title: '检查 Git 状态（不需要确认）',
				description: '只读操作',
				xml: `<execute_command>
<command>git status</command>
<requires_approval>false</requires_approval>
</execute_command>`,
			},
			{
				title: '删除文件（需要确认）',
				description: '破坏性操作，必须用户确认',
				xml: `<execute_command>
<command>rm -rf dist/</command>
<requires_approval>true</requires_approval>
</execute_command>`,
			},
		],
		tips: [
			'requires_approval 是必填参数，每次调用都必须明确声明',
			'疑惑时设为 true，宁可多问也不要执行用户不知情的危险操作',
			'命令会在工作区根目录执行，可用 cwd 参数更改',
			'命令输出会自动截断过长内容',
		],
		commonErrors: [
			{
				error: '命令被拒绝',
				cause: '命令被安全策略阻止',
				solution: '使用替代命令或请求用户手动执行',
			},
			{
				error: '命令超时',
				cause: '命令执行时间过长',
				solution: '分解为多个小命令或检查是否有死循环',
			},
		],
		relatedTools: [],
	},

	// ==================== apply_diff 工具 ====================
	apply_diff: {
		name: 'apply_diff',
		summary: '应用SEARCH/REPLACE格式补丁（非首选，优先用edit/multiedit）',
		description: `⚠️ 非首选工具：普通文件修改请使用 edit（单处）或 multiedit（多处），不要使用 apply_diff。

**仅限特殊场景使用：**
- 需要 :start_line: 行号精确控制时
- 外部提供了 patch 格式内容时

**格式（SEARCH/REPLACE块）：**
每个块必须包含完整的三个标记，缺一不可：
<<<<<<< SEARCH
[原始内容]
=======
[替换内容]
>>>>>>> REPLACE`,
		parameters: [
			{
				name: 'path',
				type: 'string',
				required: true,
				description: '要应用补丁的文件路径',
			},
			{
				name: 'diff',
				type: 'string',
				required: true,
				description: '统一 diff 格式的补丁内容',
			},
		],
		examples: [
			{
				title: '应用补丁',
				description: '修改特定行',
				xml: `<apply_diff>
<path>src/config.ts</path>
<diff>@@ -10,3 +10,4 @@
 export const API_URL = 'https://api.example.com';
-export const DEBUG = false;
+export const DEBUG = true;
+export const LOG_LEVEL = 'info';
</diff>
</apply_diff>`,
			},
		],
		tips: [
			'diff 格式必须正确，包括 @@ 行号标记',
			'对于简单修改，edit 工具更容易使用',
		],
		relatedTools: ['edit', 'multiedit'],
	},

	// ==================== 提问工具 ====================
	ask_followup_question: {
		name: 'ask_followup_question',
		summary: '向用户提问（含备选答案）',
		description: `当需要用户提供更多信息时使用此工具。

**使用时机：**
- 需求不明确，有多种实现方案
- 需要用户做出选择
- 需要确认重要/破坏性操作

**重要：** 必须提供 options 参数，给出 2-4 个建议答案，方便用户快速选择。
能用工具解决的问题不要问用户，只在真正需要人工决策时使用。`,
		parameters: [
			{
				name: 'question',
				type: 'string',
				required: true,
				description: '要向用户提出的问题，表述清晰完整',
			},
			{
				name: 'options',
				type: 'array (JSON)',
				required: true,
				description: '建议答案数组（2-4个选项），推荐对象格式：[{label,description,value}]；也兼容字符串数组',
				examples: [
					'[{"label":"JWT（推荐）","description":"无状态，服务端易扩展","value":"JWT"},{"label":"Session","description":"传统会话方案","value":"Session"}]',
					'["确认删除", "取消操作"]'
				],
			},
		],
		examples: [
			{
				title: '询问技术方案',
				description: '提供具体的选项让用户快速选择',
				xml: `<ask_followup_question>
<question>这个 API 需要身份验证，请选择认证方式：</question>
<options>[{"label":"JWT Token（推荐）","description":"无状态，服务端易扩展","value":"JWT"},{"label":"Session Cookie","description":"传统会话方式","value":"Session"},{"label":"API Key","description":"接入简单","value":"ApiKey"}]</options>
</ask_followup_question>`,
			},
			{
				title: '确认破坏性操作',
				description: '删除操作前必须用户确认',
				xml: `<ask_followup_question>
<question>确认删除 dist/ 目录？该目录包含构建产物，可以重新构建。</question>
<options>["确认删除", "取消操作"]</options>
</ask_followup_question>`,
			},
		],
		tips: [
			'options 必须是 JSON 数组格式',
			'选项应该具体、可操作，不要模糊',
			'危险操作的选项应包含"取消"选项',
		],
		relatedTools: ['attempt_completion'],
	},

	// ==================== 完成任务工具 ====================
	attempt_completion: {
		name: 'attempt_completion',
		summary: '完成当前任务',
		description: `当任务完成时调用此工具，提供任务结果摘要。

**调用前必须确认（参考Cursor/Gemini CLI）：**
1. ✅ 所有工具调用已成功完成，无失败或挂起的操作
2. ✅ 用户要求的核心结果已经实现，且没有引入新的阻塞性错误
3. ✅ 如果任务涉及功能实现，尽可能运行了相关测试或做了与任务价值匹配的验证
4. ✅ 结果描述准确反映了完成的工作

**禁止：**
- ❌ 省略 result，或依赖系统从最近文本里猜测完成内容
- ❌ result 末尾不能以问题结尾（"...对吗？"、"...需要调整吗？"）
- ❌ 不确认代码无误就报告完成
- ❌ 把“下一步计划 / 改用其他策略 / 等待子任务结果 / 还要继续调查”这种中间态文本当成完成结果`,
		parameters: [
			{
				name: 'result',
				type: 'string',
				required: true,
				description: '任务完成的结果描述',
			},
		],
		examples: [
			{
				title: '完成代码修改',
				description: '',
				xml: `<attempt_completion>
<result>已完成用户登录功能的实现：
1. 添加了 LoginForm 组件
2. 实现了 useAuth hook
3. 配置了路由保护
4. 添加了相关测试</result>
</attempt_completion>`,
			},
		],
		relatedTools: ['ask_followup_question'],
	},

	// ==================== Skill工具 ====================
	skill: {
		name: 'skill',
		summary: '按需加载专业领域知识',
		description: `从Skills仓库加载完整的专业领域知识和最佳实践。

**Skills系统优势：**
- Token优化：System Prompt仅包含Skills目录(<200 tokens)
- 按需加载：通过tool调用加载完整内容(平均节省45% tokens)
- 专业性强：涵盖代码质量、测试、安全、性能等多个领域

**使用时机：**
- 需要专业领域的详细指导时
- 需要明确的最佳实践、检查清单或流程时
- 解决特定类型问题时(如性能优化、安全审查)

**不建议使用：**
- 已经明确知道要改哪些文件、只差直接读改时
- 只是为了“更保险”而额外加一步
- 同一任务里重复加载多个相近Skill

**Available Skills** (check System Prompt for complete list):
- code-review: 代码审查清单和质量标准
- git-workflow: Git安全操作和工作流程
- debugging: 系统化调试方法
- testing: TDD和测试最佳实践
- refactoring: 重构模式和代码异味
- security: OWASP Top 10防护
- performance: 性能优化策略
- documentation: 文档编写规范
- architecture: 架构模式和设计原则
- api-design: RESTful API设计规范`,
		parameters: [
			{
				name: 'skill_name',
				type: 'string',
				required: true,
				description: 'Skill的slug名称(如 "code-review", "testing")',
				examples: ['code-review', 'testing', 'security', 'performance'],
			},
		],
		examples: [
			{
				title: '加载代码审查Skill',
				description: '在进行代码审查前加载专业指导',
				xml: `<skill>
<skill_name>code-review</skill_name>
</skill>`,
			},
			{
				title: '加载测试Skill',
				description: '学习TDD流程和测试最佳实践',
				xml: `<skill>
<skill_name>testing</skill_name>
</skill>`,
			},
			{
				title: '加载安全Skill',
				description: '审查代码安全问题',
				xml: `<skill>
<skill_name>security</skill_name>
</skill>`,
			},
		],
		tips: [
			'查看System Prompt中的Skills目录获取完整Skill列表',
			'每个Skill包含详细的指导、示例和检查清单',
			'Skill加载后会显示估算的token消耗',
			'已激活的Skill会被记录并显示统计信息',
		],
		performanceTips: [
			'只加载当前任务需要的Skills',
			'避免重复加载相同的Skill',
			'优先选择token消耗较少的Skill',
			'简单任务不调用Skill通常更快',
		],
		relatedTools: [],
	},

	// ==================== 子 Agent 工具 ====================
	task: {
		name: 'task',
		summary: '将子任务委托给专门的子 Agent 执行',
		description: `将复杂子任务委托给专门的子 Agent 独立执行。子 Agent 拥有：
- 独立的对话历史（不污染主 Agent 上下文）
- 受限的工具集（根据类型限定）
- 自动完成机制（无需用户干预）

子 Agent 类型：
- explore：只读代码库探索专家（适合分析架构、查找文件）
- plan：只读规划分析专家（适合任务分解、制定步骤）
- execute/build：完整权限实现专家（适合代码编写、测试）

何时使用：
1. 需要并行分析多个独立模块
2. 有可以独立完成的子任务（不依赖主 Agent 中间结果）
3. 想节省主 Agent 上下文窗口（探索性工作外包）
4. 不适合已经缩小到少数明确文件的直接修改任务

重要限制：
- 子 Agent 不能再调用 task 工具（防止无限递归）
- 子 Agent 结果通过最终结论文本或 attempt_completion 返回给主 Agent
- 禁止把“完整结构 / 所有文件 / 整个模块 / 完整返回每个文件”这类宽泛调查直接交给 explore；先在主线程收敛到少量候选文件，再决定是否委托`,
		parameters: [
			{
				name: 'subagent_type',
				type: 'string',
				required: true,
				description: '子 Agent 类型：explore | plan | execute | build'
			},
			{
				name: 'prompt',
				type: 'string',
				required: true,
				description: '给子 Agent 的完整任务说明，需包含足够的上下文'
			},
			{
				name: 'description',
				type: 'string',
				required: false,
				description: '5-10字的任务摘要，用于 UI 显示'
			}
		],
		examples: [
			{
				title: '独立模块调查',
				description: '仅在主线程已缩小范围后，让 explore Agent 调查独立问题',
				xml: `<task>
<subagent_type>explore</subagent_type>
<description>确认短信配置入口</description>
<prompt>基于已确认的 boyo-sms 模块，调查短信配置入口和装配路径。只回答：
1) 哪个配置类负责装配短信实现
2) 哪个 properties 类提供配置
3) 如需继续修改，下一步最该读哪 1-2 个文件
不要做整个模块的完整普查。</prompt>
</task>`
			},
			{
				title: '并行处理独立子任务',
				description: '只在任务彼此独立时并行委托',
				xml: `<batch>
<tool_calls>[
  {"tool":"task","params":{"subagent_type":"explore","prompt":"调查登录模块验证码入口，只返回关键文件"}},
  {"tool":"task","params":{"subagent_type":"plan","prompt":"分解短信登录改造步骤并指出风险点"}}
]</tool_calls>
</batch>`
			}
		],
		tips: [
			'只有在子任务彼此独立时，才用 batch 并行启动多个 task',
			'explore Agent 适合跨模块、独立的代码库调查，不是默认入口',
			'不要让 explore 去做“把整个模块所有文件都读一遍”的宽泛普查',
			'给子 Agent 的 prompt 要详细，包含足够上下文',
			'子 Agent 的对话历史独立，不会污染主 Agent 上下文'
		],
		relatedTools: ['batch'],
	},

	// ==================== 待办列表工具 ====================
	todowrite: {
		name: 'todowrite',
		summary: '创建或更新任务待办列表',
		description: `管理当前任务的待办列表。这是复杂任务的**必要工具**。

**何时必须使用**：
1. 接收到包含 3 个以上步骤的复杂任务时 → 立即创建待办列表
2. 开始执行某个子任务前 → 将其状态改为 in_progress
3. 完成某个子任务后 → 将其状态改为 completed
4. 发现新的子任务时 → 添加到列表

**最佳实践**（参考 OpenCode）：
- 每次更新都要发送完整列表（不只是变更项）
- status 字段必须实时更新，反映真实进度
- priority 帮助用户理解任务重要性
- 完成所有任务前不要调用 attempt_completion`,
		parameters: [
			{
				name: 'todos',
				type: 'string (JSON array)',
				required: true,
				description: 'JSON 格式的待办事项数组。每项：{"content":"任务内容","status":"pending|in_progress|completed","priority":"high|medium|low"}'
			}
		],
		examples: [
			{
				title: '创建初始任务列表',
				description: '接收复杂任务后立即创建列表',
				xml: `<todowrite>
<todos>[
  {"content":"分析现有代码架构","status":"in_progress","priority":"high"},
  {"content":"设计新功能接口","status":"pending","priority":"high"},
  {"content":"实现核心逻辑","status":"pending","priority":"high"},
  {"content":"编写单元测试","status":"pending","priority":"medium"},
  {"content":"更新文档","status":"pending","priority":"low"}
]</todos>
</todowrite>`
			},
			{
				title: '更新任务进度',
				description: '完成第一项后推进下一项',
				xml: `<todowrite>
<todos>[
  {"content":"分析现有代码架构","status":"completed","priority":"high"},
  {"content":"设计新功能接口","status":"in_progress","priority":"high"},
  {"content":"实现核心逻辑","status":"pending","priority":"high"},
  {"content":"编写单元测试","status":"pending","priority":"medium"},
  {"content":"更新文档","status":"pending","priority":"low"}
]</todos>
</todowrite>`
			}
		],
		tips: [
			'每次更新都发送完整列表，确保 UI 显示准确',
			'同时只将一项设为 in_progress（避免并行混乱）',
			'用 todoread 检查当前进度'
		],
		relatedTools: ['todoread', 'update_todo_list'],
	},

	todoread: {
		name: 'todoread',
		summary: '读取当前 Session 的待办列表',
		description: `读取并显示当前 Session 的完整待办列表。

使用场景：
- 长对话中忘记了任务进度
- 在继续工作前确认剩余任务
- 向用户展示整体进度

如果列表为空，返回提示信息。`,
		parameters: [],
		examples: [
			{
				title: '查看当前进度',
				description: '读取当前 Session 的待办列表',
				xml: `<todoread>
</todoread>`
			}
		],
		tips: ['先用 todowrite 创建列表，再用 todoread 读取'],
		relatedTools: ['todowrite'],
	},
};

/**
 * 获取工具的详细描述
 */
export function getToolDescription(toolName: ToolName): ToolDescription | undefined {
	return TOOL_DESCRIPTIONS[toolName];
}

/**
 * 生成工具的 System Prompt 部分
 */
export function generateToolPrompt(toolName: ToolName): string {
	const desc = TOOL_DESCRIPTIONS[toolName];
	if (!desc) {
		return '';
	}

	const lines: string[] = [
		`## ${toolName}`,
		`Description: ${desc.summary}`,
		'',
		desc.description,
		'',
		'**Parameters:**',
	];

	for (const param of desc.parameters) {
		const required = param.required ? '(required)' : '(optional)';
		const defaultVal = param.default ? `, default: ${param.default}` : '';
		lines.push(`- ${param.name} ${required}: ${param.description}${defaultVal}`);
	}

	if (desc.examples.length > 0) {
		lines.push('');
		lines.push('**Examples:**');
		for (const example of desc.examples) {
			lines.push(`\n${example.title}:`);
			if (example.description) {
				lines.push(example.description);
			}
			lines.push('```xml');
			lines.push(example.xml);
			lines.push('```');
		}
	}

	if (desc.tips && desc.tips.length > 0) {
		lines.push('');
		lines.push('**Tips:**');
		for (const tip of desc.tips) {
			lines.push(`- ${tip}`);
		}
	}

	return lines.join('\n');
}

/**
 * 生成所有工具的完整 System Prompt
 */
export function generateAllToolsPrompt(): string {
	const toolPrompts: string[] = [];

	for (const toolName of Object.keys(TOOL_DESCRIPTIONS) as ToolName[]) {
		toolPrompts.push(generateToolPrompt(toolName));
	}

	return toolPrompts.join('\n\n---\n\n');
}
