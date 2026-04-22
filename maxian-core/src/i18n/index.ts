/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Simplified i18n system for Maxian (Chinese only)
// Adapted from Kilocode's i18n system

/**
 * 翻译键值映射
 */
const translations: Record<string, string> = {
	// 工具相关
	'tools:toolRepetitionLimitReached': '工具 {toolName} 已连续调用{limit}次，可能陷入循环。请提供不同的指导或中止任务。',

	// 错误消息
	'error:apiRequestFailed': 'API请求失败: {error}',
	'error:toolExecutionFailed': '工具执行失败: {error}',
	'error:contextWindowExceeded': '上下文窗口超限',

	// 任务状态
	'task:processing': '正在处理...',
	'task:waiting': '等待用户输入...',
	'task:completed': '任务已完成',
	'task:aborted': '任务已中止',

	// 审批相关
	'approval:toolUseRequest': '请求使用工具: {toolName}',
	'approval:commandExecution': '请求执行命令: {command}',
	'approval:fileWrite': '请求写入文件: {path}',
};

/**
 * 翻译函数
 * 支持简单的参数替换
 *
 * @param key 翻译键
 * @param params 参数对象
 * @returns 翻译后的文本
 *
 * @example
 * t('tools:toolRepetitionLimitReached', { toolName: 'read_file', limit: 3 })
 * // 输出: "工具 read_file 已连续调用3次，可能陷入循环。请提供不同的指导或中止任务。"
 */
export function t(key: string, params?: Record<string, string | number>): string {
	let text = translations[key] || key;

	if (params) {
		Object.entries(params).forEach(([paramKey, value]) => {
			text = text.replace(`{${paramKey}}`, String(value));
		});
	}

	return text;
}

/**
 * 添加翻译
 * 用于扩展翻译表
 */
export function addTranslations(newTranslations: Record<string, string>): void {
	Object.assign(translations, newTranslations);
}
