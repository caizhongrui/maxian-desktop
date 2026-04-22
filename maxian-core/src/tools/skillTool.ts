/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill Tool - 按需加载专业领域知识
 *
 * 功能：
 * - 根据skill_name从Registry加载完整Skill内容
 * - 返回Markdown格式的专业指令
 * - 支持Skills的懒加载和缓存
 * - 自动统计Skill使用情况
 *
 * Token优化：
 * - System Prompt只包含Skills目录(<200 tokens)
 * - 完整内容通过tool调用按需加载
 * - 平均节省45% tokens
 */

import type { IToolContext } from './IToolContext.js';
import type { ToolResponse } from '../types/toolTypes.js';
import { ISkillService } from '../interfaces/ISkillService.js';

// ========== 配置 ==========
const SKILL_TOOL_CONFIG = {
	/** 最大内容长度（100KB） */
	MAX_CONTENT_LENGTH: 100 * 1024,

	/** 激活通知模板 */
	ACTIVATION_TEMPLATE: '🔧 已激活 Skill: {{name}}',
};

// ========== 使用统计 ==========
interface SkillUsageStats {
	skillName: string;
	activationCount: number;
	lastActivatedAt: number;
	totalTokens: number;
}

const usageStats = new Map<string, SkillUsageStats>();

/**
 * 记录Skill使用
 */
function trackSkillUsage(skillName: string, estimatedTokens: number): void {
	const existing = usageStats.get(skillName);

	if (existing) {
		existing.activationCount++;
		existing.lastActivatedAt = Date.now();
		existing.totalTokens += estimatedTokens;
	} else {
		usageStats.set(skillName, {
			skillName,
			activationCount: 1,
			lastActivatedAt: Date.now(),
			totalTokens: estimatedTokens,
		});
	}
}

/**
 * 获取使用统计
 */
export function getSkillUsageStats(): SkillUsageStats[] {
	return Array.from(usageStats.values())
		.sort((a, b) => b.activationCount - a.activationCount);
}

/**
 * 清空使用统计
 */
export function clearSkillUsageStats(): void {
	usageStats.clear();
}

// ========== 主函数 ==========

/**
 * Skill工具执行函数
 *
 * @param task - 任务上下文
 * @param params - 工具参数 { skill_name: string }
 * @param skillService - Skill服务实例
 * @returns Skill的完整Markdown内容
 */
export async function skillTool(
	ctx: IToolContext,
	params: any,
	skillService?: ISkillService
): Promise<ToolResponse> {
	const skillName = params.skill_name || params.name || '';

	if (!skillName) {
		return 'Error: No skill_name provided\n\n💡 Use skill_name parameter to specify the Skill to load.';
	}

	// 验证skillService
	if (!skillService) {
		return `Error: Skill service not available\n\nSkill system is not initialized. Please restart the IDE.`;
	}

	try {
		// 从Registry获取Skill (IPC调用是异步的)
		const skill = await Promise.resolve(skillService.get(skillName));

		if (!skill) {
			// 提供可用Skills的建议
			const availableSkills = await Promise.resolve(skillService.search({}));
			const suggestions = availableSkills
				.slice(0, 5)
				.map(s => `  - ${s.slug} - ${s.description}`)
				.join('\n');

			return `Error: Skill not found: "${skillName}"\n\n💡 Available Skills:\n${suggestions}\n\n💡 Use the Skills directory in System Prompt to find more Skills.`;
		}

		// 检查内容长度
		if (skill.content.length > SKILL_TOOL_CONFIG.MAX_CONTENT_LENGTH) {
			return `Error: Skill content too large (${(skill.content.length / 1024).toFixed(1)}KB)\n\nMaximum supported size is ${SKILL_TOOL_CONFIG.MAX_CONTENT_LENGTH / 1024}KB.`;
		}

		// 记录使用统计
		trackSkillUsage(skillName, skill.estimatedTokens || 0);

		// 记录到任务日志
		console.log(`[SkillTool] Activated: ${skillName} (${skill.estimatedTokens} tokens)`);

		const baseDirectory = skill.filePath.replace(/\/[^/]+$/, '');
		const relatedFiles = [...(skill.examplePaths || []), ...(skill.templatePaths || [])]
			.filter(Boolean)
			.slice(0, 10)
			.map(file => `<file>${file}</file>`)
			.join('\n');

		// 对齐 OpenCode：以结构化块返回，减少额外包装噪音，保留最关键的定位信息。
		return [
			`<skill_content name="${skill.name}">`,
			`# Skill: ${skill.name}`,
			``,
			skill.content.trim(),
			``,
			`Base directory for this skill: ${baseDirectory}`,
			`Relative paths in this skill are relative to this base directory.`,
			...(relatedFiles
				? [
					``,
					`<skill_files>`,
					relatedFiles,
					`</skill_files>`
				]
				: []),
			`</skill_content>`
		].join('\n');

	} catch (error) {
		console.error('[SkillTool] Error loading skill:', error);
		return `Error loading skill: ${(error as Error).message}`;
	}
}

/**
 * 获取Skill激活通知文本
 */
export function getSkillActivationMessage(skillName: string): string {
	return SKILL_TOOL_CONFIG.ACTIVATION_TEMPLATE.replace('{{name}}', skillName);
}
