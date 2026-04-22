/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfiguration } from '../interfaces/IConfiguration.js';
import { IApiHandler, ApiConfiguration } from './types.js';
import { QwenHandler } from './qwenHandler.js';
import { AiProxyHandler, AiProxyConfiguration } from './aiProxyHandler.js';

/**
 * API 工厂类
 * 负责创建和管理 API Handler 实例
 */
export class ApiFactory {
	constructor(
		private readonly configurationService: IConfiguration
	) { }

	/**
	 * 创建 API Handler 实例
	 * 优先使用 AI 代理服务（如果配置了 zhikai.auth.apiUrl），否则使用直接调用千问 API
	 * @param credentials 可选的认证凭证（用户名和密码），如果不提供则从配置读取
	 * @param mode 可选的模式，用于自动选择businessCode
	 */
	createHandler(credentials?: { username: string; password: string }, mode?: string): IApiHandler {
		// 检查是否配置了 AI 代理服务
		const apiUrl = this.configurationService.getValue<string>('zhikai.auth.apiUrl');

		// ⚠️ 安全修复：只使用传递的 credentials，不从配置文件读取密码
		// 原因：密码应该保存在 StorageService 中，不应该存储在明文配置文件中
		const username = credentials?.username;
		const password = credentials?.password;

		if (apiUrl && username && password) {
			// 使用 AI 代理服务（推荐方式）
			console.log('[ApiFactory] 使用 AI 代理服务:', apiUrl, '模式:', mode);

			// 根据模式映射businessCode
			let businessCode: string | undefined;
			let flashBusinessCode: string | undefined;
			if (mode) {
				businessCode = this.getBusinessCodeForMode(mode);
				flashBusinessCode = this.getFlashBusinessCodeForMode(mode);
			}

			const config: AiProxyConfiguration = {
				apiUrl,
				username: btoa(username), // Base64编码
				password: btoa(password), // Base64编码
				businessCode,       // 高质量模型（代码生成）
				flashBusinessCode,  // 快速模型（探索加速，未配置时自动回退到 businessCode）
			};

			// 如果没有businessCode，使用传统方式（向后兼容）
			if (!businessCode) {
				config.provider = this.configurationService.getValue<string>('zhikai.ai.provider') || 'qwen';
				config.model = this.configurationService.getValue<string>('zhikai.ai.model') || 'qwen-plus';
			}

			return new AiProxyHandler(config);
		} else {
			// 回退到直接调用千问 API（向后兼容）
			console.log('[ApiFactory] 使用千问 API 直连模式（已废弃，请配置 zhikai.auth.* 使用代理服务）');

			const apiKey = this.configurationService.getValue<string>('zhikai.ai.apiKey') || '';
			const model = this.configurationService.getValue<string>('zhikai.ai.model') || 'qwen-coder-turbo';
			const temperature = this.configurationService.getValue<number>('zhikai.ai.temperature') ?? 0.15;
			const maxTokens = this.configurationService.getValue<number>('zhikai.ai.maxTokens') ?? 1000;
			const timeout = this.configurationService.getValue<number>('zhikai.ai.timeout') ?? 30000;

			const config: ApiConfiguration = {
				apiKey,
				model,
				temperature,
				maxTokens,
				timeout
			};

			return new QwenHandler(config);
		}
	}

	/**
	 * 根据模式获取对应的businessCode（高质量模型，用于代码生成）
	 */
	private getBusinessCodeForMode(mode: string): string {
		const modeMap: Record<string, string> = {
			'code': 'IDE_CHAT_CODE',
			'architect': 'IDE_CHAT_ARCHITECT',
			'ask': 'IDE_CHAT_ASK',
			'debug': 'IDE_CHAT_DEBUG',
			'orchestrator': 'IDE_CHAT_ORCHESTRATOR',
			'figma': 'IDE_FIGMA_CODE',  // Figma 设计稿转代码，使用多模态模型
		};
		return modeMap[mode] || 'IDE_CHAT_CODE';  // 默认使用编码模式
	}

	/**
	 * 根据模式获取对应的 flash businessCode（快速模型，用于探索阶段）
	 * 未配置时返回 undefined，AiProxyHandler 会自动回退到 businessCode
	 */
	private getFlashBusinessCodeForMode(mode: string): string | undefined {
		// 目前只有 code/debug 模式有探索阶段，其他模式无需 flash
		const flashModeMap: Record<string, string> = {
			'code': 'IDE_CHAT_CODE_FAST',
			'debug': 'IDE_CHAT_DEBUG_FAST',
		};
		return flashModeMap[mode];
	}

	/**
	 * 验证配置是否有效
	 */
	validateConfiguration(): { valid: boolean; error?: string } {
		// 检查是否配置了 AI 代理服务
		const apiUrl = this.configurationService.getValue<string>('zhikai.auth.apiUrl');
		const username = this.configurationService.getValue<string>('zhikai.auth.username');

		// ⚠️ 安全修复：不检查密码，因为密码保存在 StorageService 中
		// 只要 apiUrl 和 username 存在，就认为配置有效（密码会在登录时验证）
		if (apiUrl && username) {
			// 代理服务配置完整
			return { valid: true };
		}

		// 回退检查千问 API 配置
		const apiKey = this.configurationService.getValue<string>('zhikai.ai.apiKey');

		if (!apiKey) {
			return {
				valid: false,
				error: '未配置 AI 服务。请在设置中配置 zhikai.auth.* (推荐) 或 zhikai.ai.apiKey (已废弃)'
			};
		}

		return { valid: true };
	}
}
