/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 规划 Agent
 * 专门用于设计实现方案，分析任务并生成执行计划
 * 参考 Claude Code 的 Plan Agent 设计
 */

import { PlanResult, ExploreResult, PLAN_AGENT_TOOLS, PlanStep } from './AgentTypes.js';
import { IToolExecutor } from '../tools/toolExecutor.js';
import { ToolName } from '../types/toolTypes.js';

/**
 * 规划 Agent 系统提示词
 */
const PLAN_AGENT_SYSTEM_PROMPT = `你是一个软件架构师Agent，专门用于设计实现方案。

**语言要求**：
- 输出中的自然语言说明必须使用简体中文
- 文件路径、代码符号、命令保持原文

**你的任务**：
- 分析任务需求
- 设计实现方案
- 识别关键文件和修改点
- 考虑架构权衡

**输出格式**（严格遵循JSON格式）：
{
  "taskAnalysis": "任务分析描述",
  "steps": [
    {
      "id": 1,
      "description": "步骤描述",
      "type": "explore|modify|create|execute|verify",
      "files": ["相关文件"],
      "command": "需要执行的命令（可选）"
    }
  ],
  "keyFiles": ["关键文件列表"],
  "risks": ["潜在风险"]
}

**规划原则**：
- 最小化修改范围
- 复用现有代码模式
- 考虑测试策略
- 不估计时间，只关注步骤
- 每个步骤要具体可执行`;

/**
 * 规划 Agent 类
 */
export class PlanAgent {
	constructor(_toolExecutor: IToolExecutor, _workspaceRoot: string) {
		// 保留构造函数参数以备将来使用
	}

	/**
	 * 获取系统提示词
	 */
	getSystemPrompt(): string {
		return PLAN_AGENT_SYSTEM_PROMPT;
	}

	/**
	 * 获取可用工具列表
	 */
	getAvailableTools(): ToolName[] {
		return [...PLAN_AGENT_TOOLS] as ToolName[];
	}

	/**
	 * 生成执行计划
	 * @param task 任务描述
	 * @param explorationResult 探索结果（可选）
	 * @returns 规划结果
	 */
	async plan(task: string, explorationResult?: ExploreResult): Promise<PlanResult> {
		console.log('[PlanAgent] 开始规划:', task);

		try {
			// 分析任务类型
			const taskType = this.analyzeTaskType(task);

			// 根据探索结果和任务类型生成计划
			const steps = this.generateSteps(task, taskType, explorationResult);

			// 识别关键文件
			const keyFiles = this.identifyKeyFiles(task, explorationResult);

			// 识别潜在风险
			const risks = this.identifyRisks(task, taskType);

			const result: PlanResult = {
				success: true,
				output: `已生成包含 ${steps.length} 个步骤的执行计划`,
				data: {
					taskAnalysis: this.generateTaskAnalysis(task, taskType),
					steps,
					keyFiles,
					risks
				}
			};

			console.log('[PlanAgent] 规划完成:', result.data?.steps.length, '个步骤');
			return result;

		} catch (error) {
			console.error('[PlanAgent] 规划失败:', error);
			return {
				success: false,
				output: '',
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * 分析任务类型
	 */
	private analyzeTaskType(task: string): TaskType {
		const taskLower = task.toLowerCase();

		if (taskLower.includes('修复') || taskLower.includes('fix') || taskLower.includes('bug')) {
			return 'bugfix';
		}
		if (taskLower.includes('添加') || taskLower.includes('新增') || taskLower.includes('实现') || taskLower.includes('add') || taskLower.includes('implement')) {
			return 'feature';
		}
		if (taskLower.includes('重构') || taskLower.includes('优化') || taskLower.includes('refactor') || taskLower.includes('improve')) {
			return 'refactor';
		}
		if (taskLower.includes('测试') || taskLower.includes('test')) {
			return 'test';
		}
		if (taskLower.includes('文档') || taskLower.includes('doc') || taskLower.includes('readme')) {
			return 'docs';
		}

		return 'feature'; // 默认为新功能
	}

	/**
	 * 生成任务分析
	 */
	private generateTaskAnalysis(task: string, taskType: TaskType): string {
		const typeDescriptions: Record<TaskType, string> = {
			'bugfix': '这是一个 Bug 修复任务，需要找到问题根因并修复',
			'feature': '这是一个新功能开发任务，需要设计并实现新功能',
			'refactor': '这是一个重构/优化任务，需要改进现有代码结构或性能',
			'test': '这是一个测试相关任务，需要编写或修改测试用例',
			'docs': '这是一个文档相关任务，需要编写或更新文档'
		};

		return `${typeDescriptions[taskType]}。任务目标：${task}`;
	}

	/**
	 * 生成执行步骤
	 */
	private generateSteps(task: string, taskType: TaskType, explorationResult?: ExploreResult): PlanStep[] {
		const steps: PlanStep[] = [];
		let stepId = 1;

		// 所有任务都从探索开始（如果没有探索结果）
		if (!explorationResult || !explorationResult.success) {
			steps.push({
				id: stepId++,
				description: '探索代码库，找到相关代码',
				type: 'explore',
				files: []
			});
		}

		// 根据任务类型生成特定步骤
		switch (taskType) {
			case 'bugfix':
				steps.push(
					{ id: stepId++, description: '定位问题代码', type: 'explore', files: [] },
					{ id: stepId++, description: '分析问题原因', type: 'explore', files: [] },
					{ id: stepId++, description: '修复问题', type: 'modify', files: [] },
					{ id: stepId++, description: '验证修复', type: 'verify', files: [] }
				);
				break;

			case 'feature':
				steps.push(
					{ id: stepId++, description: '了解现有实现模式', type: 'explore', files: [] },
					{ id: stepId++, description: '创建或修改相关文件', type: 'modify', files: [] },
					{ id: stepId++, description: '添加必要的测试', type: 'create', files: [] },
					{ id: stepId++, description: '验证功能正常', type: 'verify', files: [] }
				);
				break;

			case 'refactor':
				steps.push(
					{ id: stepId++, description: '理解当前实现', type: 'explore', files: [] },
					{ id: stepId++, description: '设计改进方案', type: 'explore', files: [] },
					{ id: stepId++, description: '逐步重构代码', type: 'modify', files: [] },
					{ id: stepId++, description: '确保测试通过', type: 'execute', command: 'npm test', files: [] }
				);
				break;

			case 'test':
				steps.push(
					{ id: stepId++, description: '了解需要测试的功能', type: 'explore', files: [] },
					{ id: stepId++, description: '编写测试用例', type: 'create', files: [] },
					{ id: stepId++, description: '运行测试', type: 'execute', command: 'npm test', files: [] }
				);
				break;

			case 'docs':
				steps.push(
					{ id: stepId++, description: '了解需要文档化的功能', type: 'explore', files: [] },
					{ id: stepId++, description: '编写或更新文档', type: 'modify', files: [] }
				);
				break;
		}

		// 如果有探索结果，补充文件信息
		if (explorationResult?.data?.relevantFiles) {
			const relevantPaths = explorationResult.data.relevantFiles.map(f => f.path);
			for (const step of steps) {
				if (step.type === 'modify' || step.type === 'explore') {
					step.files = relevantPaths.slice(0, 3);
				}
			}
		}

		return steps;
	}

	/**
	 * 识别关键文件
	 */
	private identifyKeyFiles(task: string, explorationResult?: ExploreResult): string[] {
		if (explorationResult?.data?.relevantFiles) {
			return explorationResult.data.relevantFiles
				.filter(f => f.relevance === 'high')
				.map(f => f.path);
		}
		return [];
	}

	/**
	 * 识别潜在风险
	 */
	private identifyRisks(task: string, taskType: TaskType): string[] {
		const risks: string[] = [];

		// 通用风险
		risks.push('修改前确保理解现有代码逻辑');

		// 根据任务类型添加特定风险
		switch (taskType) {
			case 'bugfix':
				risks.push('修复可能影响其他功能，需要充分测试');
				break;
			case 'feature':
				risks.push('新功能需要与现有代码风格保持一致');
				risks.push('考虑边界情况和错误处理');
				break;
			case 'refactor':
				risks.push('重构过程中保持功能不变');
				risks.push('分步重构，每步验证');
				break;
		}

		return risks;
	}
}

/**
 * 任务类型
 */
type TaskType = 'bugfix' | 'feature' | 'refactor' | 'test' | 'docs';
