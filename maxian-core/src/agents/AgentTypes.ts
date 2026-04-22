/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 类型定义
 * 参考 Claude Code 的子 Agent 系统设计
 */

/**
 * Agent 类型枚举
 */
export type AgentType = 'explore' | 'plan' | 'execute';

/**
 * Agent 执行结果
 */
export interface AgentResult {
	success: boolean;
	output: string;
	data?: any;
	error?: string;
	tokenUsage?: {
		input: number;
		output: number;
	};
}

/**
 * 探索结果
 */
export interface ExploreResult extends AgentResult {
	data?: {
		relevantFiles: Array<{
			path: string;
			description: string;
			relevance: 'high' | 'medium' | 'low';
		}>;
		codeStructure?: string;
		summary: string;
	};
}

/**
 * 规划步骤
 */
export interface PlanStep {
	id: number;
	description: string;
	type: 'explore' | 'modify' | 'create' | 'execute' | 'verify';
	files?: string[];
	command?: string;
}

/**
 * 规划结果
 */
export interface PlanResult extends AgentResult {
	data?: {
		taskAnalysis: string;
		steps: PlanStep[];
		keyFiles: string[];
		risks: string[];
	};
}

/**
 * 执行结果
 */
export interface ExecuteResult extends AgentResult {
	data?: {
		stepsExecuted: Array<{
			stepId: number;
			success: boolean;
			output?: string;
			error?: string;
		}>;
		overallSuccess: boolean;
		summary: string;
	};
}

/**
 * Agent 配置
 */
export interface AgentConfig {
	type: AgentType;
	maxIterations?: number;
	timeoutMs?: number;
	verbose?: boolean;
}

/**
 * 探索 Agent 的工具限制
 * 只能使用只读工具
 */
export const EXPLORE_AGENT_TOOLS = [
	'read_file',
	'search_files',
	'list_files',
	'list_code_definition_names',
	'codebase_search',
	'glob',
	'batch'  // 允许并行搜索/读取，避免逐轮单独调用
] as const;

/**
 * 规划 Agent 的工具限制
 * 只能使用只读工具 + ask_followup_question
 */
export const PLAN_AGENT_TOOLS = [
	...EXPLORE_AGENT_TOOLS,
	'ask_followup_question'
] as const;

/**
 * 执行 Agent 的工具（完整权限）
 */
export const EXECUTE_AGENT_TOOLS = [
	'read_file',
	'write_to_file',
	'edit',
	'multiedit',
	'apply_diff',
	'patch',
	'edit_file',
	'insert_content',
	'search_files',
	'list_files',
	'list_code_definition_names',
	'codebase_search',
	'glob',
	'lsp',
	'execute_command',
	'task',
	'ask_followup_question',
	'attempt_completion',
	'new_task',
	'todowrite',
	'update_todo_list'
] as const;

/**
 * 任务执行阶段
 */
export type TaskPhase = 'exploring' | 'planning' | 'executing' | 'verifying' | 'completed';

/**
 * 任务执行上下文
 */
export interface TaskContext {
	task: string;
	phase: TaskPhase;
	explorationResult?: ExploreResult;
	planResult?: PlanResult;
	executionLog: string[];
	currentStep?: number;
}
