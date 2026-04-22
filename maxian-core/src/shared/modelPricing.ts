/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 模型定价配置
 * 价格单位：元/千tokens
 */

export interface ModelPricing {
	inputPrice: number;   // 输入token价格（元/千tokens）
	outputPrice: number;  // 输出token价格（元/千tokens）
}

/**
 * 各AI模型的定价表（2025年1月）
 * 数据来源：各AI服务商官网
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
	// ========== 千问系列 ==========
	'qwen-max': {
		inputPrice: 0.02,    // 0.02元/千tokens
		outputPrice: 0.06,   // 0.06元/千tokens
	},
	'qwen-max-latest': {
		inputPrice: 0.02,
		outputPrice: 0.06,
	},
	'qwen-plus': {
		inputPrice: 0.004,   // 0.004元/千tokens
		outputPrice: 0.012,  // 0.012元/千tokens
	},
	'qwen-plus-latest': {
		inputPrice: 0.004,
		outputPrice: 0.012,
	},
	'qwen-turbo': {
		inputPrice: 0.001,   // 0.001元/千tokens
		outputPrice: 0.002,  // 0.002元/千tokens
	},
	'qwen-turbo-latest': {
		inputPrice: 0.001,
		outputPrice: 0.002,
	},
	'qwen-long': {
		inputPrice: 0.0005,  // 0.0005元/千tokens
		outputPrice: 0.002,  // 0.002元/千tokens
	},
	'qwen-coder-turbo': {
		inputPrice: 0.001,
		outputPrice: 0.002,
	},
	'qwen-coder-turbo-latest': {
		inputPrice: 0.001,
		outputPrice: 0.002,
	},
	'qwen-coder-plus': {
		inputPrice: 0.004,
		outputPrice: 0.012,
	},
	'qwen-coder-plus-latest': {
		inputPrice: 0.004,
		outputPrice: 0.012,
	},

	// ========== OpenAI系列 ==========
	'gpt-4': {
		inputPrice: 0.21,    // $0.03/千tokens ≈ 0.21元/千tokens
		outputPrice: 0.42,   // $0.06/千tokens ≈ 0.42元/千tokens
	},
	'gpt-4-turbo': {
		inputPrice: 0.07,    // $0.01/千tokens ≈ 0.07元/千tokens
		outputPrice: 0.21,   // $0.03/千tokens ≈ 0.21元/千tokens
	},
	'gpt-4-turbo-preview': {
		inputPrice: 0.07,
		outputPrice: 0.21,
	},
	'gpt-3.5-turbo': {
		inputPrice: 0.0035,  // $0.0005/千tokens ≈ 0.0035元/千tokens
		outputPrice: 0.014,  // $0.002/千tokens ≈ 0.014元/千tokens
	},
	'gpt-3.5-turbo-16k': {
		inputPrice: 0.021,   // $0.003/千tokens ≈ 0.021元/千tokens
		outputPrice: 0.028,  // $0.004/千tokens ≈ 0.028元/千tokens
	},

	// ========== Claude系列 ==========
	'claude-3-opus': {
		inputPrice: 0.105,   // $0.015/千tokens ≈ 0.105元/千tokens
		outputPrice: 0.525,  // $0.075/千tokens ≈ 0.525元/千tokens
	},
	'claude-3-sonnet': {
		inputPrice: 0.021,   // $0.003/千tokens ≈ 0.021元/千tokens
		outputPrice: 0.105,  // $0.015/千tokens ≈ 0.105元/千tokens
	},
	'claude-3-haiku': {
		inputPrice: 0.0017,  // $0.00025/千tokens ≈ 0.0017元/千tokens
		outputPrice: 0.0087, // $0.00125/千tokens ≈ 0.0087元/千tokens
	},

	// ========== 默认兜底价格 ==========
	'default': {
		inputPrice: 0.004,   // 默认使用qwen-plus价格
		outputPrice: 0.012,
	},
};

/**
 * 计算API调用费用
 * @param model 模型名称
 * @param inputTokens 输入token数
 * @param outputTokens 输出token数
 * @returns 费用（元），保留6位小数
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
	// 获取模型定价，如果找不到则使用默认价格
	const pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];

	// 计算费用：(tokens / 1000) * price
	const inputCost = (inputTokens / 1000) * pricing.inputPrice;
	const outputCost = (outputTokens / 1000) * pricing.outputPrice;
	const totalCost = inputCost + outputCost;

	// 保留6位小数
	return Math.round(totalCost * 1000000) / 1000000;
}

/**
 * 格式化费用显示
 * @param cost 费用（元）
 * @returns 格式化后的费用字符串
 */
export function formatCost(cost: number): string {
	if (cost < 0.000001) {
		return '¥0.000000';
	} else if (cost < 0.01) {
		return `¥${cost.toFixed(6)}`;
	} else if (cost < 1) {
		return `¥${cost.toFixed(4)}`;
	} else {
		return `¥${cost.toFixed(2)}`;
	}
}
