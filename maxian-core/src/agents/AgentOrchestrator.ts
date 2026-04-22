/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 编排器
 * 协调探索、规划、执行 Agent 的工作流程
 * 实现 探索 → 规划 → 执行 → 验证 循环
 */

import { ExploreAgent } from './ExploreAgent.js';
import { PlanAgent } from './PlanAgent.js';
import { ExecuteAgent } from './ExecuteAgent.js';
import { TaskContext, TaskPhase, ExploreResult, PlanResult, ExecuteResult } from './AgentTypes.js';
import { IToolExecutor } from '../tools/toolExecutor.js';

/**
 * Agent 编排器配置
 */
export interface OrchestratorConfig {
	enableExploration: boolean;
	enablePlanning: boolean;
	autoExecute: boolean;
	verbose: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: OrchestratorConfig = {
	enableExploration: true,
	enablePlanning: true,
	autoExecute: true,
	verbose: true
};

/**
 * Agent 编排器事件
 */
export interface OrchestratorEvents {
	onPhaseChange?: (phase: TaskPhase, context: TaskContext) => void;
	onExplorationComplete?: (result: ExploreResult) => void;
	onPlanningComplete?: (result: PlanResult) => void;
	onStepStart?: (stepId: number, description: string) => void;
	onStepComplete?: (stepId: number, success: boolean) => void;
}

/**
 * Agent 编排器类
 */
export class AgentOrchestrator {
	private exploreAgent: ExploreAgent;
	private planAgent: PlanAgent;
	private executeAgent: ExecuteAgent;
	private config: OrchestratorConfig;
	private events: OrchestratorEvents;

	constructor(
		toolExecutor: IToolExecutor,
		workspaceRoot: string,
		config: Partial<OrchestratorConfig> = {},
		events: OrchestratorEvents = {}
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.events = events;

		// 初始化子 Agent
		this.exploreAgent = new ExploreAgent(toolExecutor, workspaceRoot);
		this.planAgent = new PlanAgent(toolExecutor, workspaceRoot);
		this.executeAgent = new ExecuteAgent(toolExecutor, workspaceRoot);
	}

	/**
	 * 执行完整的任务流程
	 * 探索 → 规划 → 执行 → 验证
	 */
	async executeTask(task: string): Promise<TaskContext> {
		const context: TaskContext = {
			task,
			phase: 'exploring',
			executionLog: []
		};

		this.log(`开始执行任务: ${task}`);

		try {
			// 阶段 1: 探索
			if (this.config.enableExploration) {
				await this.explorePhase(context);
			}

			// 阶段 2: 规划
			if (this.config.enablePlanning) {
				await this.planPhase(context);
			}

			// 阶段 3: 执行（返回计划供 TaskService 执行）
			context.phase = 'executing';
			this.firePhaseChange(context);

			// 注意：实际执行由 TaskService 完成，这里只返回计划
			this.log('规划完成，等待执行');

		} catch (error) {
			this.log(`任务执行失败: ${error}`);
			context.executionLog.push(`错误: ${error instanceof Error ? error.message : String(error)}`);
		}

		return context;
	}

	/**
	 * 探索阶段
	 */
	private async explorePhase(context: TaskContext): Promise<void> {
		context.phase = 'exploring';
		this.firePhaseChange(context);
		this.log('开始探索阶段...');

		const result = await this.exploreAgent.explore(context.task);
		context.explorationResult = result;
		context.executionLog.push(`探索完成: ${result.output}`);

		if (this.events.onExplorationComplete) {
			this.events.onExplorationComplete(result);
		}

		this.log(`探索完成: 找到 ${result.data?.relevantFiles?.length || 0} 个相关文件`);
	}

	/**
	 * 规划阶段
	 */
	private async planPhase(context: TaskContext): Promise<void> {
		context.phase = 'planning';
		this.firePhaseChange(context);
		this.log('开始规划阶段...');

		const result = await this.planAgent.plan(context.task, context.explorationResult);
		context.planResult = result;
		context.executionLog.push(`规划完成: ${result.output}`);

		if (this.events.onPlanningComplete) {
			this.events.onPlanningComplete(result);
		}

		this.log(`规划完成: ${result.data?.steps?.length || 0} 个步骤`);
	}

	/**
	 * 仅执行探索
	 */
	async explore(task: string): Promise<ExploreResult> {
		this.log(`执行探索: ${task}`);
		return this.exploreAgent.explore(task);
	}

	/**
	 * 仅执行规划
	 */
	async plan(task: string, explorationResult?: ExploreResult): Promise<PlanResult> {
		this.log(`执行规划: ${task}`);
		return this.planAgent.plan(task, explorationResult);
	}

	/**
	 * 仅执行计划步骤
	 */
	async execute(planResult: PlanResult): Promise<ExecuteResult> {
		if (!planResult.data?.steps || planResult.data.steps.length === 0) {
			return {
				success: false,
				output: '没有可执行的步骤',
				error: '规划结果中没有步骤'
			};
		}
		this.log(`执行计划: ${planResult.data.steps.length} 个步骤`);
		return this.executeAgent.execute(planResult.data.steps);
	}

	/**
	 * 获取探索 Agent 的系统提示词
	 */
	getExploreSystemPrompt(): string {
		return this.exploreAgent.getSystemPrompt();
	}

	/**
	 * 获取规划 Agent 的系统提示词
	 */
	getPlanSystemPrompt(): string {
		return this.planAgent.getSystemPrompt();
	}

	/**
	 * 判断任务是否需要探索
	 * 简单任务可以跳过探索阶段
	 */
	shouldExplore(task: string): boolean {
		// 简单任务的关键词
		const simpleTaskKeywords = [
			'打印', 'print', 'console.log',
			'注释', 'comment',
			'格式化', 'format',
			'删除', 'remove', 'delete'
		];

		const taskLower = task.toLowerCase();
		for (const keyword of simpleTaskKeywords) {
			if (taskLower.includes(keyword) && task.length < 50) {
				return false;
			}
		}

		return true;
	}

	/**
	 * 判断任务是否需要规划
	 */
	shouldPlan(task: string): boolean {
		// 复杂任务的关键词
		const complexTaskKeywords = [
			'实现', 'implement', '开发', 'develop',
			'重构', 'refactor', '优化', 'optimize',
			'添加', 'add', '新增', 'create',
			'修改', 'modify', 'change', 'update'
		];

		const taskLower = task.toLowerCase();
		for (const keyword of complexTaskKeywords) {
			if (taskLower.includes(keyword)) {
				return true;
			}
		}

		// 任务描述较长通常意味着复杂任务
		return task.length > 100;
	}

	/**
	 * 生成增强的系统提示词
	 * 将探索和规划结果注入到系统提示词中
	 */
	generateEnhancedPrompt(basePrompt: string, context: TaskContext): string {
		let enhancedPrompt = basePrompt;

		// 添加探索结果
		if (context.explorationResult?.data) {
			const { relevantFiles, summary } = context.explorationResult.data;
			enhancedPrompt += `\n\n====\n\nCODEBASE EXPLORATION RESULTS\n\n`;
			enhancedPrompt += `**探索总结**: ${summary}\n\n`;

			if (relevantFiles && relevantFiles.length > 0) {
				enhancedPrompt += `**相关文件**:\n`;
				for (const file of relevantFiles) {
					enhancedPrompt += `- ${file.path} (${file.relevance}): ${file.description}\n`;
				}
			}
		}

		// 添加规划结果
		if (context.planResult?.data) {
			const { taskAnalysis, steps, keyFiles, risks } = context.planResult.data;
			enhancedPrompt += `\n\n====\n\nTASK PLAN\n\n`;
			enhancedPrompt += `**任务分析**: ${taskAnalysis}\n\n`;

			if (steps && steps.length > 0) {
				enhancedPrompt += `**执行步骤**:\n`;
				for (const step of steps) {
					enhancedPrompt += `${step.id}. [${step.type}] ${step.description}\n`;
					if (step.files && step.files.length > 0) {
						enhancedPrompt += `   文件: ${step.files.join(', ')}\n`;
					}
					if (step.command) {
						enhancedPrompt += `   命令: ${step.command}\n`;
					}
				}
			}

			if (keyFiles && keyFiles.length > 0) {
				enhancedPrompt += `\n**关键文件**: ${keyFiles.join(', ')}\n`;
			}

			if (risks && risks.length > 0) {
				enhancedPrompt += `\n**注意事项**:\n`;
				for (const risk of risks) {
					enhancedPrompt += `- ${risk}\n`;
				}
			}
		}

		return enhancedPrompt;
	}

	/**
	 * 触发阶段变化事件
	 */
	private firePhaseChange(context: TaskContext): void {
		if (this.events.onPhaseChange) {
			this.events.onPhaseChange(context.phase, context);
		}
	}

	/**
	 * 日志输出
	 */
	private log(message: string): void {
		if (this.config.verbose) {
			console.log(`[AgentOrchestrator] ${message}`);
		}
	}
}
