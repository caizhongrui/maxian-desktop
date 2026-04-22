/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 动态工具注册系统
 * 参考 OpenCode 的工具注册机制实现
 *
 * 功能：
 * - 运行时动态注册/注销工具
 * - 工具分组管理
 * - 工具权限控制
 * - MCP 服务器工具集成
 * - 工具版本管理
 */

import { ToolResponse } from '../types/toolTypes.js';

/**
 * 工具定义接口
 */
export interface ToolDefinition {
	/** 工具名称（唯一标识） */
	name: string;
	/** 显示名称 */
	displayName: string;
	/** 工具描述 */
	description: string;
	/** 详细描述（用于 System Prompt） */
	longDescription?: string;
	/** 参数 Schema */
	inputSchema: ToolInputSchema;
	/** 工具分组 */
	group: ToolGroup;
	/** 是否总是可用 */
	alwaysAvailable?: boolean;
	/** 版本 */
	version?: string;
	/** 来源（内置/MCP/扩展） */
	source: ToolSource;
	/** 执行函数 */
	execute?: ToolExecuteFunction;
}

/**
 * 工具输入 Schema
 */
export interface ToolInputSchema {
	type: 'object';
	properties: Record<string, ToolParameterSchema>;
	required?: string[];
}

/**
 * 工具参数 Schema
 */
export interface ToolParameterSchema {
	type: 'string' | 'number' | 'boolean' | 'array' | 'object';
	description: string;
	default?: any;
	enum?: string[];
	items?: ToolParameterSchema;
	properties?: Record<string, ToolParameterSchema>;
	required?: string[];
}

/**
 * 工具分组
 */
export type ToolGroup = 'read' | 'edit' | 'command' | 'web' | 'lsp' | 'agent' | 'mcp' | 'custom';

/**
 * 工具来源
 */
export type ToolSource = 'builtin' | 'mcp' | 'extension' | 'custom';

/**
 * 工具执行函数类型
 */
export type ToolExecuteFunction = (params: Record<string, any>, context: ToolExecutionContext) => Promise<ToolResponse>;

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
	/** 工作区根目录 */
	workspaceRoot: string;
	/** 会话 ID */
	sessionId: string;
	/** 当前 Agent 名称 */
	agentName?: string;
	/** 用户配置 */
	userConfig?: Record<string, any>;
}

/**
 * 工具注册事件
 */
export interface ToolRegistryEvent {
	type: 'registered' | 'unregistered' | 'updated';
	toolName: string;
	source: ToolSource;
	timestamp: number;
}

/**
 * 工具注册表监听器
 */
export type ToolRegistryListener = (event: ToolRegistryEvent) => void;

/**
 * 工具注册表
 */
export class ToolRegistry {
	private tools: Map<string, ToolDefinition> = new Map();
	private listeners: Set<ToolRegistryListener> = new Set();
	private toolsByGroup: Map<ToolGroup, Set<string>> = new Map();
	private toolsBySource: Map<ToolSource, Set<string>> = new Map();

	constructor() {
		// 初始化分组映射
		const groups: ToolGroup[] = ['read', 'edit', 'command', 'web', 'lsp', 'agent', 'mcp', 'custom'];
		for (const group of groups) {
			this.toolsByGroup.set(group, new Set());
		}

		// 初始化来源映射
		const sources: ToolSource[] = ['builtin', 'mcp', 'extension', 'custom'];
		for (const source of sources) {
			this.toolsBySource.set(source, new Set());
		}
	}

	/**
	 * 注册工具
	 */
	register(definition: ToolDefinition): boolean {
		const existing = this.tools.get(definition.name);

		// 如果已存在，检查是否可以更新
		if (existing) {
			// 内置工具不能被覆盖
			if (existing.source === 'builtin' && definition.source !== 'builtin') {
				console.warn(`[ToolRegistry] 无法覆盖内置工具: ${definition.name}`);
				return false;
			}
		}

		// 注册工具
		this.tools.set(definition.name, definition);

		// 更新分组映射
		this.toolsByGroup.get(definition.group)?.add(definition.name);

		// 更新来源映射
		this.toolsBySource.get(definition.source)?.add(definition.name);

		// 触发事件
		this.emit({
			type: existing ? 'updated' : 'registered',
			toolName: definition.name,
			source: definition.source,
			timestamp: Date.now(),
		});

		console.log(`[ToolRegistry] 注册工具: ${definition.name} (${definition.source})`);
		return true;
	}

	/**
	 * 批量注册工具
	 */
	registerAll(definitions: ToolDefinition[]): { success: string[]; failed: string[] } {
		const success: string[] = [];
		const failed: string[] = [];

		for (const def of definitions) {
			if (this.register(def)) {
				success.push(def.name);
			} else {
				failed.push(def.name);
			}
		}

		return { success, failed };
	}

	/**
	 * 注销工具
	 */
	unregister(name: string): boolean {
		const tool = this.tools.get(name);
		if (!tool) {
			return false;
		}

		// 内置工具不能被注销
		if (tool.source === 'builtin') {
			console.warn(`[ToolRegistry] 无法注销内置工具: ${name}`);
			return false;
		}

		// 移除工具
		this.tools.delete(name);

		// 更新分组映射
		this.toolsByGroup.get(tool.group)?.delete(name);

		// 更新来源映射
		this.toolsBySource.get(tool.source)?.delete(name);

		// 触发事件
		this.emit({
			type: 'unregistered',
			toolName: name,
			source: tool.source,
			timestamp: Date.now(),
		});

		console.log(`[ToolRegistry] 注销工具: ${name}`);
		return true;
	}

	/**
	 * 获取工具定义
	 */
	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	/**
	 * 检查工具是否存在
	 */
	has(name: string): boolean {
		return this.tools.has(name);
	}

	/**
	 * 获取所有工具名称
	 */
	getAllNames(): string[] {
		return Array.from(this.tools.keys());
	}

	/**
	 * 获取所有工具定义
	 */
	getAll(): ToolDefinition[] {
		return Array.from(this.tools.values());
	}

	/**
	 * 按分组获取工具
	 */
	getByGroup(group: ToolGroup): ToolDefinition[] {
		const names = this.toolsByGroup.get(group);
		if (!names) return [];
		return Array.from(names).map(name => this.tools.get(name)!).filter(Boolean);
	}

	/**
	 * 按来源获取工具
	 */
	getBySource(source: ToolSource): ToolDefinition[] {
		const names = this.toolsBySource.get(source);
		if (!names) return [];
		return Array.from(names).map(name => this.tools.get(name)!).filter(Boolean);
	}

	/**
	 * 获取总是可用的工具
	 */
	getAlwaysAvailable(): ToolDefinition[] {
		return this.getAll().filter(tool => tool.alwaysAvailable);
	}

	/**
	 * 添加监听器
	 */
	addListener(listener: ToolRegistryListener): void {
		this.listeners.add(listener);
	}

	/**
	 * 移除监听器
	 */
	removeListener(listener: ToolRegistryListener): void {
		this.listeners.delete(listener);
	}

	/**
	 * 触发事件
	 */
	private emit(event: ToolRegistryEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				console.error('[ToolRegistry] 监听器执行失败:', error);
			}
		}
	}

	/**
	 * 生成工具的 JSON Schema（用于 API）
	 */
	generateSchema(name: string): object | null {
		const tool = this.tools.get(name);
		if (!tool) return null;

		return {
			name: tool.name,
			description: tool.description,
			input_schema: tool.inputSchema,
		};
	}

	/**
	 * 生成所有工具的 Schema 列表
	 */
	generateAllSchemas(): object[] {
		return this.getAll().map(tool => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.inputSchema,
		}));
	}

	/**
	 * 生成工具的 System Prompt 部分
	 */
	generatePrompt(name: string): string {
		const tool = this.tools.get(name);
		if (!tool) return '';

		const lines: string[] = [
			`## ${tool.name}`,
			`Description: ${tool.description}`,
		];

		if (tool.longDescription) {
			lines.push('');
			lines.push(tool.longDescription);
		}

		lines.push('');
		lines.push('**Parameters:**');

		for (const [paramName, paramSchema] of Object.entries(tool.inputSchema.properties)) {
			const required = tool.inputSchema.required?.includes(paramName) ? '(required)' : '(optional)';
			const defaultVal = paramSchema.default !== undefined ? `, default: ${paramSchema.default}` : '';
			lines.push(`- ${paramName} ${required}: ${paramSchema.description}${defaultVal}`);
		}

		return lines.join('\n');
	}

	/**
	 * 生成所有工具的完整 System Prompt
	 */
	generateAllPrompts(): string {
		return this.getAll()
			.map(tool => this.generatePrompt(tool.name))
			.join('\n\n---\n\n');
	}

	/**
	 * 清空所有非内置工具
	 */
	clearNonBuiltin(): void {
		for (const [name, tool] of this.tools.entries()) {
			if (tool.source !== 'builtin') {
				this.unregister(name);
			}
		}
	}

	/**
	 * 获取统计信息
	 */
	getStats(): {
		total: number;
		byGroup: Record<ToolGroup, number>;
		bySource: Record<ToolSource, number>;
	} {
		const byGroup: Record<ToolGroup, number> = {} as any;
		const bySource: Record<ToolSource, number> = {} as any;

		for (const [group, names] of this.toolsByGroup.entries()) {
			byGroup[group] = names.size;
		}

		for (const [source, names] of this.toolsBySource.entries()) {
			bySource[source] = names.size;
		}

		return {
			total: this.tools.size,
			byGroup,
			bySource,
		};
	}
}

/**
 * 全局工具注册表实例
 */
export const globalToolRegistry = new ToolRegistry();

/**
 * 注册内置工具
 * 这个函数应该在应用启动时调用
 */
export function registerBuiltinTools(): void {
	const builtinTools: ToolDefinition[] = [
		// 文件读取工具
		{
			name: 'read_file',
			displayName: '读取文件',
			description: '读取指定文件的内容',
			group: 'read',
			source: 'builtin',
			alwaysAvailable: false,
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '文件路径' },
					start_line: { type: 'number', description: '起始行号' },
					end_line: { type: 'number', description: '结束行号' },
				},
				required: ['path'],
			},
		},
		// 文件写入工具
		{
			name: 'write_to_file',
			displayName: '写入文件',
			description: '将内容写入指定文件',
			group: 'edit',
			source: 'builtin',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '文件路径' },
					content: { type: 'string', description: '文件内容' },
				},
				required: ['path', 'content'],
			},
		},
		// Edit 工具
		{
			name: 'edit',
			displayName: '编辑(容错)',
			description: '通过 old_string/new_string 进行字符串替换，支持容错匹配',
			group: 'edit',
			source: 'builtin',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '文件路径' },
					old_string: { type: 'string', description: '要替换的内容' },
					new_string: { type: 'string', description: '替换后的内容' },
					replace_all: { type: 'boolean', description: '是否全局替换', default: false },
				},
				required: ['path', 'new_string'],
			},
		},
		// 搜索工具
		{
			name: 'search_files',
			displayName: '搜索文件',
			description: '使用正则表达式搜索文件内容',
			group: 'read',
			source: 'builtin',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '搜索目录' },
					regex: { type: 'string', description: '正则表达式' },
					file_pattern: { type: 'string', description: '文件名模式' },
				},
				required: ['path', 'regex'],
			},
		},
		// 执行命令工具
		{
			name: 'execute_command',
			displayName: '执行命令',
			description: '在终端中执行命令',
			group: 'command',
			source: 'builtin',
			inputSchema: {
				type: 'object',
				properties: {
					command: { type: 'string', description: '要执行的命令' },
					cwd: { type: 'string', description: '工作目录' },
				},
				required: ['command'],
			},
		},
		// 批量执行工具
		{
			name: 'batch',
			displayName: '批量执行',
			description: '并行执行多个工具调用',
			group: 'agent',
			source: 'builtin',
			inputSchema: {
				type: 'object',
				properties: {
					tool_calls: { type: 'array', description: '工具调用数组' },
				},
				required: ['tool_calls'],
			},
		},
		// 多处编辑工具
		{
			name: 'multiedit',
			displayName: '多处编辑',
			description: '在单文件中执行多处编辑',
			group: 'edit',
			source: 'builtin',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '文件路径' },
					edits: {
						type: 'array',
						description: '编辑操作数组。同一文件的所有修改必须放在一个 edits 数组中一次提交',
						items: {
							type: 'object',
							description: '单个编辑操作',
							properties: {
								old_string: { type: 'string', description: '要替换的原始文本（必须精确匹配文件内容）' },
								new_string: { type: 'string', description: '替换后的新文本' },
								replace_all: { type: 'boolean', description: '是否替换所有匹配项（默认false）' },
							},
							required: ['old_string', 'new_string'],
						},
					},
				},
				required: ['path', 'edits'],
			},
		},
		// 控制工具
		{
			name: 'ask_followup_question',
			displayName: '提问',
			description: '向用户提出跟进问题',
			group: 'agent',
			source: 'builtin',
			alwaysAvailable: true,
			inputSchema: {
				type: 'object',
				properties: {
					question: { type: 'string', description: '问题内容' },
					options: {
						type: 'array',
						description: '2-4 个候选答案（支持字符串或 {label,description,value} 对象）',
						items: { type: 'string', description: '选项文本（运行时也兼容对象格式）' }
					}
				},
				required: ['question', 'options'],
			},
		},
		{
			name: 'attempt_completion',
			displayName: '完成任务',
			description: '标记任务完成并提供结果',
			group: 'agent',
			source: 'builtin',
			alwaysAvailable: true,
			inputSchema: {
				type: 'object',
				properties: {
					result: { type: 'string', description: '任务结果' },
				},
				required: ['result'],
			},
		},
	];

	const result = globalToolRegistry.registerAll(builtinTools);
	console.log(`[ToolRegistry] 注册内置工具完成: ${result.success.length} 成功, ${result.failed.length} 失败`);
}

/**
 * MCP 工具适配器
 * 用于将 MCP 服务器的工具转换为本地工具定义
 */
export function adaptMcpTool(
	serverName: string,
	mcpTool: {
		name: string;
		description?: string;
		inputSchema?: any;
	}
): ToolDefinition {
	return {
		name: `mcp_${serverName}_${mcpTool.name}`,
		displayName: `${mcpTool.name} (${serverName})`,
		description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
		group: 'mcp',
		source: 'mcp',
		inputSchema: mcpTool.inputSchema || {
			type: 'object',
			properties: {},
		},
	};
}

/**
 * 注册 MCP 服务器的所有工具
 */
export function registerMcpServerTools(
	serverName: string,
	tools: Array<{ name: string; description?: string; inputSchema?: any }>
): { success: string[]; failed: string[] } {
	const definitions = tools.map(tool => adaptMcpTool(serverName, tool));
	return globalToolRegistry.registerAll(definitions);
}

/**
 * 注销 MCP 服务器的所有工具
 */
export function unregisterMcpServerTools(serverName: string): number {
	const prefix = `mcp_${serverName}_`;
	const toRemove = globalToolRegistry.getAllNames().filter(name => name.startsWith(prefix));

	let count = 0;
	for (const name of toRemove) {
		if (globalToolRegistry.unregister(name)) {
			count++;
		}
	}

	return count;
}
