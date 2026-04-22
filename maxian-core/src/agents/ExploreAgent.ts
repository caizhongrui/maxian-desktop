/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 探索 Agent
 * 专门用于快速探索代码库，理解项目结构和相关代码
 * 参考 Claude Code 的 Explore Agent 设计
 */

import { ExploreResult, EXPLORE_AGENT_TOOLS } from './AgentTypes.js';
import { IToolExecutor } from '../tools/toolExecutor.js';
import { ToolName } from '../types/toolTypes.js';

/**
 * 探索 Agent 系统提示词
 */
const EXPLORE_AGENT_SYSTEM_PROMPT = `你是一个专门用于快速探索代码库的Agent。

**语言要求**：
- 输出中的自然语言说明必须使用简体中文
- 文件路径、代码符号、命令保持原文

**你的能力**：
- 使用 glob 按文件名模式查找文件
- 使用 search_files 进行内容搜索
- 使用 read_file 阅读文件内容
- 使用 codebase_search 进行语义搜索
- 使用 list_files 查看目录结构
- 使用 list_code_definition_names 查看代码定义

**你的限制**：
- 不能修改任何文件
- 不能执行命令
- 不能创建文件

**探索策略**：
1. 从用户的问题中提取关键信息
2. 使用语义搜索找到相关代码
3. 阅读关键文件理解实现
4. 总结发现并返回结构化结果

**返回格式**（严格遵循JSON格式）：
{
  "relevantFiles": [
    {"path": "文件路径", "description": "文件作用描述", "relevance": "high/medium/low"}
  ],
  "codeStructure": "代码结构描述",
  "summary": "探索总结"
}`;

/**
 * 探索 Agent 类
 */
export class ExploreAgent {
	private toolExecutor: IToolExecutor;

	constructor(toolExecutor: IToolExecutor, _workspaceRoot: string, _maxIterations: number = 10) {
		this.toolExecutor = toolExecutor;
		// workspaceRoot 和 maxIterations 保留以备将来使用
	}

	/**
	 * 获取系统提示词
	 */
	getSystemPrompt(): string {
		return EXPLORE_AGENT_SYSTEM_PROMPT;
	}

	/**
	 * 获取可用工具列表
	 */
	getAvailableTools(): ToolName[] {
		return [...EXPLORE_AGENT_TOOLS] as ToolName[];
	}

	/**
	 * 执行探索任务
	 * @param task 探索任务描述
	 * @returns 探索结果
	 */
	async explore(task: string): Promise<ExploreResult> {
		console.log('[ExploreAgent] 开始探索:', task);

		try {
			// 🎯 第零步：智能判断是否需要探索
			const needsExploration = this.shouldExplore(task);
			if (!needsExploration) {
				console.log('[ExploreAgent] 智能判断：任务无需探索代码库，跳过探索阶段');
				return {
					success: true,
					output: '此任务无需探索代码库，将直接执行。',
					data: {
						relevantFiles: [],
						summary: '根据任务类型判断，无需探索代码库（如：代码片段分析、知识问答等）。'
					}
				};
			}

			// 第一步：使用语义搜索找到相关代码
			const semanticResults = await this.semanticSearch(task);

			// 第二步：使用 glob 查找相关文件
			const fileResults = await this.findRelatedFiles(task);

			// 第三步：读取关键文件
			const keyFiles = [...new Set([...semanticResults, ...fileResults])].slice(0, 5);
			const fileContents = await this.readKeyFiles(keyFiles);

			// 第四步：生成探索总结
			const result = this.generateExploreResult(task, keyFiles, fileContents);

			console.log('[ExploreAgent] 探索完成:', result.data?.summary);
			return result;

		} catch (error) {
			console.error('[ExploreAgent] 探索失败:', error);
			return {
				success: false,
				output: '',
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * 智能判断是否需要探索代码库
	 *
	 * 参考 task-strategy Skill的判断逻辑：
	 * - 类型1：代码片段分析 → 无需探索
	 * - 类型2：项目功能开发 → 需要探索
	 * - 类型3：知识问答 → 无需探索
	 * - 类型4：项目分析 → 需要探索
	 * - 类型5：Bug修复 → 条件探索
	 */
	private shouldExplore(task: string): boolean {
		const taskLower = task.toLowerCase();

		// 🚫 类型1：代码片段分析（包含代码块，无项目上下文）
		const hasCodeBlock = /```[\s\S]*?```/g.test(task) || /\n\s{2,}[@a-zA-Z]/.test(task);
		const hasProjectContext = /文件|路径|项目|模块|类名|方法名|function|class\s+\w+/.test(taskLower);

		if (hasCodeBlock && !hasProjectContext) {
			console.log('[ExploreAgent] 判断：代码片段分析，无需探索');
			return false;
		}

		// 🚫 类型3：知识问答（询问概念、最佳实践）
		const isKnowledgeQuestion =
			/^(什么是|如何|为什么|有什么|怎么|如何.*最佳实践|.*和.*的区别)/.test(task) ||
			/(what is|how to|why|best practice|difference between)/i.test(task);

		const hasSpecificCode = /(审查|修改|创建|添加|实现|修复|优化).*代码/.test(task);

		if (isKnowledgeQuestion && !hasSpecificCode) {
			console.log('[ExploreAgent] 判断：知识问答，无需探索');
			return false;
		}

		// 🚫 明确的审查指令（如"审查这段代码"）+ 代码块
		const isReviewRequest = /(审查|检查|分析|解释)(这段|以下)代码/.test(task);
		if (isReviewRequest && hasCodeBlock) {
			console.log('[ExploreAgent] 判断：代码片段审查，无需探索');
			return false;
		}

		// ✅ 其他情况：需要探索
		console.log('[ExploreAgent] 判断：任务需要探索代码库');
		return true;
	}

	/**
	 * 语义搜索
	 */
	private async semanticSearch(query: string): Promise<string[]> {
		try {
			const result = await this.toolExecutor.executeTool({
				type: 'tool_use',
				name: 'codebase_search',
				params: { query },
				partial: false
			});

			// 解析搜索结果，提取文件路径
			if (typeof result === 'string') {
				const fileMatches = result.match(/([^\s]+\.(ts|js|tsx|jsx|py|java|go|rs|cpp|c|h))/g);
				return fileMatches || [];
			}
			return [];
		} catch (error) {
			console.warn('[ExploreAgent] 语义搜索失败:', error);
			return [];
		}
	}

	/**
	 * 查找相关文件
	 * 只使用英文关键词进行 glob 搜索，中文任务依赖语义搜索
	 */
	private async findRelatedFiles(task: string): Promise<string[]> {
		// 只提取英文关键词用于 glob 搜索
		const keywords = this.extractEnglishKeywords(task);
		const files: string[] = [];

		// 如果没有英文关键词，尝试使用通用的项目结构探索
		if (keywords.length === 0) {
			console.log('[ExploreAgent] 无英文关键词，使用默认目录探索');
			return await this.exploreProjectStructure();
		}

		for (const keyword of keywords.slice(0, 3)) {
			try {
				const result = await this.toolExecutor.executeTool({
					type: 'tool_use',
					name: 'glob',
					params: {
						path: '.',
						file_pattern: `**/*${keyword}*`
					},
					partial: false
				});

				if (typeof result === 'string' && result.trim() && !result.includes('未找到')) {
					const matchedFiles = result.split('\n').filter(f => f.trim() && !f.includes('未找到'));
					files.push(...matchedFiles.slice(0, 5));
				}
			} catch (error) {
				console.warn('[ExploreAgent] glob 搜索失败:', keyword, error);
			}
		}

		return [...new Set(files)];
	}

	/**
	 * 探索项目结构（当没有明确关键词时）
	 */
	private async exploreProjectStructure(): Promise<string[]> {
		const files: string[] = [];

		try {
			// 查找主要源码目录
			const result = await this.toolExecutor.executeTool({
				type: 'tool_use',
				name: 'list_files',
				params: { path: '.' },
				partial: false
			});

			if (typeof result === 'string') {
				// 识别源码目录
				const dirs = result.split('\n').filter(d => d.trim());
				const srcDirs = dirs.filter(d =>
					d.includes('src') || d.includes('lib') || d.includes('app') ||
					d.includes('main') || d.includes('core')
				);

				if (srcDirs.length > 0) {
					console.log('[ExploreAgent] 发现源码目录:', srcDirs.slice(0, 3).join(', '));
				}
			}
		} catch (error) {
			console.warn('[ExploreAgent] 项目结构探索失败:', error);
		}

		return files;
	}

	/**
	 * 只提取英文关键词（用于 glob 搜索）
	 * 中文词不适合用于文件名搜索
	 */
	private extractEnglishKeywords(task: string): string[] {
		// 只匹配英文标识符（至少2个字符）
		const englishWords = task.match(/[a-zA-Z_][a-zA-Z0-9_]{1,}/g) || [];

		// 过滤掉常见的停用词
		const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'by', 'with']);
		return englishWords.filter(w => !stopWords.has(w.toLowerCase()) && w.length >= 3);
	}

	/**
	 * 读取关键文件
	 */
	private async readKeyFiles(files: string[]): Promise<Map<string, string>> {
		const contents = new Map<string, string>();

		for (const file of files) {
			try {
				const result = await this.toolExecutor.executeTool({
					type: 'tool_use',
					name: 'read_file',
					params: { path: file },
					partial: false
				});

				if (typeof result === 'string') {
					// 只保留前200行，避免内容过长
					const lines = result.split('\n').slice(0, 200);
					contents.set(file, lines.join('\n'));
				}
			} catch (error) {
				console.warn('[ExploreAgent] 读取文件失败:', file, error);
			}
		}

		return contents;
	}


	/**
	 * 生成探索结果
	 */
	private generateExploreResult(task: string, files: string[], contents: Map<string, string>): ExploreResult {
		const relevantFiles = files.map((file, index) => ({
			path: file,
			description: this.guessFileDescription(file, contents.get(file)),
			relevance: (index < 2 ? 'high' : index < 4 ? 'medium' : 'low') as 'high' | 'medium' | 'low'
		}));

		const summary = files.length > 0
			? `找到 ${files.length} 个相关文件。主要涉及: ${relevantFiles.slice(0, 3).map(f => f.path).join(', ')}`
			: '未找到明显相关的文件，可能需要更具体的搜索条件。';

		return {
			success: files.length > 0,
			output: summary,
			data: {
				relevantFiles,
				summary
			}
		};
	}

	/**
	 * 根据文件路径和内容猜测文件描述
	 */
	private guessFileDescription(file: string, content?: string): string {
		const fileName = file.split('/').pop() || file;

		// 根据文件名猜测
		if (fileName.includes('test') || fileName.includes('spec')) {
			return '测试文件';
		}
		if (fileName.includes('config')) {
			return '配置文件';
		}
		if (fileName.includes('service') || fileName.includes('Service')) {
			return '服务层';
		}
		if (fileName.includes('controller') || fileName.includes('Controller')) {
			return '控制器';
		}
		if (fileName.includes('model') || fileName.includes('Model')) {
			return '数据模型';
		}
		if (fileName.includes('util') || fileName.includes('helper')) {
			return '工具函数';
		}
		if (fileName.includes('component') || fileName.includes('Component')) {
			return 'UI组件';
		}

		// 根据内容猜测
		if (content) {
			if (content.includes('export class')) {
				return '类定义';
			}
			if (content.includes('export function') || content.includes('export const')) {
				return '函数/常量导出';
			}
			if (content.includes('interface ') || content.includes('type ')) {
				return '类型定义';
			}
		}

		return '相关文件';
	}
}
