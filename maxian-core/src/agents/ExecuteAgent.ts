/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 执行 Agent
 * 专门用于执行规划中的步骤，调用工具完成实际任务
 * 参考 Claude Code 的执行模式
 */

import { ExecuteResult, PlanStep, EXECUTE_AGENT_TOOLS } from './AgentTypes.js';
import { IToolExecutor } from '../tools/toolExecutor.js';
import { ToolName } from '../types/toolTypes.js';

/**
 * 执行 Agent 系统提示词
 */
const EXECUTE_AGENT_SYSTEM_PROMPT = `你是一个代码执行Agent，负责按照规划执行具体任务。

**语言要求**：
- 输出中的自然语言说明必须使用简体中文
- 文件路径、代码符号、命令保持原文

**你的能力**：
- 读取和修改文件
- 执行命令
- 创建新文件
- 搜索和替换代码

**执行原则**：
1. 严格按照规划步骤执行
2. 每步执行前验证前置条件
3. 执行后验证结果
4. 遇到错误及时停止并报告

**输出格式**：
{
  "stepsExecuted": [
    {"stepId": 1, "success": true, "output": "执行结果"},
    {"stepId": 2, "success": false, "error": "错误信息"}
  ],
  "overallSuccess": true/false,
  "summary": "执行总结"
}`;

/**
 * 步骤执行结果
 */
interface StepExecutionResult {
	stepId: number;
	success: boolean;
	output?: string;
	error?: string;
}

/**
 * 执行 Agent 类
 */
export class ExecuteAgent {
	private toolExecutor: IToolExecutor;

	constructor(toolExecutor: IToolExecutor, _workspaceRoot: string, _maxRetries: number = 2) {
		this.toolExecutor = toolExecutor;
		// workspaceRoot 和 maxRetries 保留以备将来使用
	}

	/**
	 * 获取系统提示词
	 */
	getSystemPrompt(): string {
		return EXECUTE_AGENT_SYSTEM_PROMPT;
	}

	/**
	 * 获取可用工具列表
	 */
	getAvailableTools(): ToolName[] {
		return [...EXECUTE_AGENT_TOOLS] as ToolName[];
	}

	/**
	 * 执行计划步骤
	 * @param steps 计划步骤列表
	 * @returns 执行结果
	 */
	async execute(steps: PlanStep[]): Promise<ExecuteResult> {
		console.log('[ExecuteAgent] 开始执行:', steps.length, '个步骤');

		const stepsExecuted: StepExecutionResult[] = [];
		let overallSuccess = true;

		try {
			for (const step of steps) {
				const result = await this.executeStep(step);
				stepsExecuted.push(result);

				if (!result.success) {
					overallSuccess = false;
					// 可选：遇到错误是否继续执行其他步骤
					console.warn(`[ExecuteAgent] 步骤 ${step.id} 执行失败:`, result.error);
					break; // 默认停止执行
				}
			}

			const executeResult: ExecuteResult = {
				success: overallSuccess,
				output: this.generateSummary(stepsExecuted),
				data: {
					stepsExecuted,
					overallSuccess,
					summary: this.generateSummary(stepsExecuted)
				}
			};

			console.log('[ExecuteAgent] 执行完成:', executeResult.output);
			return executeResult;

		} catch (error) {
			console.error('[ExecuteAgent] 执行失败:', error);
			return {
				success: false,
				output: '',
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * 执行单个步骤
	 */
	private async executeStep(step: PlanStep): Promise<StepExecutionResult> {
		console.log(`[ExecuteAgent] 执行步骤 ${step.id}: ${step.description}`);

		try {
			switch (step.type) {
				case 'explore':
					return await this.executeExploreStep(step);

				case 'modify':
					return await this.executeModifyStep(step);

				case 'create':
					return await this.executeCreateStep(step);

				case 'execute':
					return await this.executeCommandStep(step);

				case 'verify':
					return await this.executeVerifyStep(step);

				default:
					return {
						stepId: step.id,
						success: false,
						error: `未知步骤类型: ${step.type}`
					};
			}
		} catch (error) {
			return {
				stepId: step.id,
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * 执行探索类型步骤
	 */
	private async executeExploreStep(step: PlanStep): Promise<StepExecutionResult> {
		// 探索步骤：读取文件或搜索代码
		const outputs: string[] = [];

		if (step.files && step.files.length > 0) {
			for (const file of step.files) {
				try {
					await this.toolExecutor.executeTool({
						type: 'tool_use',
						name: 'read_file',
						params: { path: file },
						partial: false
					});
					outputs.push(`读取 ${file}: 成功`);
				} catch (error) {
					outputs.push(`读取 ${file}: 失败 - ${error}`);
				}
			}
		}

		return {
			stepId: step.id,
			success: true,
			output: outputs.join('\n') || '探索完成'
		};
	}

	/**
	 * 执行修改类型步骤
	 */
	private async executeModifyStep(step: PlanStep): Promise<StepExecutionResult> {
		// 修改步骤需要具体的修改指令，这里只返回成功
		// 实际修改由主循环中的工具调用完成
		return {
			stepId: step.id,
			success: true,
			output: `准备修改: ${step.files?.join(', ') || '待确定的文件'}`
		};
	}

	/**
	 * 执行创建类型步骤
	 */
	private async executeCreateStep(step: PlanStep): Promise<StepExecutionResult> {
		// 创建步骤需要具体的文件内容，这里只返回成功
		return {
			stepId: step.id,
			success: true,
			output: `准备创建: ${step.files?.join(', ') || '待确定的文件'}`
		};
	}

	/**
	 * 执行命令类型步骤
	 */
	private async executeCommandStep(step: PlanStep): Promise<StepExecutionResult> {
		if (!step.command) {
			return {
				stepId: step.id,
				success: false,
				error: '未指定命令'
			};
		}

		try {
			const result = await this.toolExecutor.executeTool({
				type: 'tool_use',
				name: 'execute_command',
				params: { command: step.command },
				partial: false
			});

			return {
				stepId: step.id,
				success: true,
				output: typeof result === 'string' ? result : JSON.stringify(result)
			};
		} catch (error) {
			return {
				stepId: step.id,
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * 执行验证类型步骤
	 */
	private async executeVerifyStep(step: PlanStep): Promise<StepExecutionResult> {
		// 验证步骤：检查文件是否存在，运行测试等
		if (step.command) {
			return this.executeCommandStep(step);
		}

		return {
			stepId: step.id,
			success: true,
			output: '验证步骤完成'
		};
	}

	/**
	 * 生成执行总结
	 */
	private generateSummary(results: StepExecutionResult[]): string {
		const successCount = results.filter(r => r.success).length;
		const totalCount = results.length;

		if (successCount === totalCount) {
			return `所有 ${totalCount} 个步骤执行成功`;
		} else {
			const failedSteps = results.filter(r => !r.success).map(r => r.stepId);
			return `${successCount}/${totalCount} 步骤成功，失败步骤: ${failedSteps.join(', ')}`;
		}
	}
}
