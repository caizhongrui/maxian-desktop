/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 错误处理服务
 * 提供智能重试策略、错误分类和用户友好的错误消息
 */

/**
 * 错误类型枚举
 */
export enum ErrorType {
	NETWORK = 'network',           // 网络错误
	API_RATE_LIMIT = 'rate_limit', // API 速率限制
	API_AUTH = 'auth',             // 认证错误
	API_SERVER = 'server',         // 服务器错误
	TOOL_EXECUTION = 'tool',       // 工具执行错误
	VALIDATION = 'validation',     // 验证错误
	TIMEOUT = 'timeout',           // 超时错误
	UNKNOWN = 'unknown'            // 未知错误
}

/**
 * 错误信息
 */
export interface ErrorInfo {
	type: ErrorType;
	message: string;
	originalError?: Error;
	retryable: boolean;
	userMessage: string;
	suggestedAction?: string;
}

/**
 * 重试配置
 */
export interface RetryConfig {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	jitterFactor: number;  // 抖动因子 (0-1)
}

/**
 * 默认重试配置
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 3,
	baseDelayMs: 1000,
	maxDelayMs: 60000,
	jitterFactor: 0.2
};

/**
 * 错误处理器类
 */
export class ErrorHandler {
	private retryConfig: RetryConfig;

	constructor(config: Partial<RetryConfig> = {}) {
		this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
	}

	/**
	 * 分类错误
	 */
	classifyError(error: unknown): ErrorInfo {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const lowerMessage = errorMessage.toLowerCase();

		// 网络错误
		if (lowerMessage.includes('network') ||
			lowerMessage.includes('econnrefused') ||
			lowerMessage.includes('enotfound') ||
			lowerMessage.includes('socket')) {
			return {
				type: ErrorType.NETWORK,
				message: errorMessage,
				originalError: error instanceof Error ? error : undefined,
				retryable: true,
				userMessage: '网络连接失败',
				suggestedAction: '请检查网络连接后重试'
			};
		}

		// API 速率限制
		if (lowerMessage.includes('rate limit') ||
			lowerMessage.includes('too many requests') ||
			lowerMessage.includes('429')) {
			return {
				type: ErrorType.API_RATE_LIMIT,
				message: errorMessage,
				originalError: error instanceof Error ? error : undefined,
				retryable: true,
				userMessage: 'API 请求过于频繁',
				suggestedAction: '请稍后再试'
			};
		}

		// 认证错误
		if (lowerMessage.includes('auth') ||
			lowerMessage.includes('unauthorized') ||
			lowerMessage.includes('401') ||
			lowerMessage.includes('403') ||
			lowerMessage.includes('api key')) {
			return {
				type: ErrorType.API_AUTH,
				message: errorMessage,
				originalError: error instanceof Error ? error : undefined,
				retryable: false,
				userMessage: 'API 认证失败',
				suggestedAction: '请检查 API 密钥配置'
			};
		}

		// 服务器错误
		if (lowerMessage.includes('500') ||
			lowerMessage.includes('502') ||
			lowerMessage.includes('503') ||
			lowerMessage.includes('504') ||
			lowerMessage.includes('server error')) {
			return {
				type: ErrorType.API_SERVER,
				message: errorMessage,
				originalError: error instanceof Error ? error : undefined,
				retryable: true,
				userMessage: 'API 服务器错误',
				suggestedAction: '服务器暂时不可用，请稍后重试'
			};
		}

		// 超时错误
		if (lowerMessage.includes('timeout') ||
			lowerMessage.includes('timed out') ||
			lowerMessage.includes('etimedout')) {
			return {
				type: ErrorType.TIMEOUT,
				message: errorMessage,
				originalError: error instanceof Error ? error : undefined,
				retryable: true,
				userMessage: '请求超时',
				suggestedAction: '请求处理时间过长，请重试'
			};
		}

		// 工具执行错误
		if (lowerMessage.includes('tool') ||
			lowerMessage.includes('file not found') ||
			lowerMessage.includes('permission denied')) {
			return {
				type: ErrorType.TOOL_EXECUTION,
				message: errorMessage,
				originalError: error instanceof Error ? error : undefined,
				retryable: false,
				userMessage: '工具执行失败',
				suggestedAction: '请检查文件路径和权限'
			};
		}

		// 验证错误
		if (lowerMessage.includes('invalid') ||
			lowerMessage.includes('validation') ||
			lowerMessage.includes('missing parameter')) {
			return {
				type: ErrorType.VALIDATION,
				message: errorMessage,
				originalError: error instanceof Error ? error : undefined,
				retryable: false,
				userMessage: '参数验证失败',
				suggestedAction: '请检查输入参数'
			};
		}

		// 未知错误
		return {
			type: ErrorType.UNKNOWN,
			message: errorMessage,
			originalError: error instanceof Error ? error : undefined,
			retryable: false,
			userMessage: '发生未知错误',
			suggestedAction: '请重试或联系支持'
		};
	}

	/**
	 * 从 API 响应中提取 retry-after 头（毫秒）
	 * 优先使用服务器指定的等待时间（对齐 Kilocode SessionRetry）
	 */
	extractRetryAfterMs(error: unknown): number | undefined {
		if (!error || typeof error !== 'object') return undefined;

		// 尝试从错误对象中找 response headers
		const err = error as any;
		const headers: Record<string, string> | undefined =
			err.response?.headers ||
			err.headers ||
			err.responseHeaders;

		if (!headers) return undefined;

		// 优先：retry-after-ms（毫秒精度）
		const retryAfterMs = headers['retry-after-ms'];
		if (retryAfterMs) {
			const ms = parseFloat(retryAfterMs);
			if (!isNaN(ms) && ms > 0) return ms;
		}

		// 次选：retry-after（秒 或 HTTP日期）
		const retryAfter = headers['retry-after'];
		if (retryAfter) {
			const seconds = parseFloat(retryAfter);
			if (!isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000);

			// HTTP 日期格式
			const date = Date.parse(retryAfter);
			if (!isNaN(date)) {
				const ms = date - Date.now();
				if (ms > 0) return Math.ceil(ms);
			}
		}

		return undefined;
	}

	/**
	 * 计算重试延迟（Header感知 + 指数退避 + 抖动）
	 * 如果服务器返回了 retry-after 头，优先使用服务器指定的等待时间
	 */
	calculateRetryDelay(attempt: number, error?: unknown): number {
		// 优先使用服务器指定的等待时间
		if (error !== undefined) {
			const serverDelay = this.extractRetryAfterMs(error);
			if (serverDelay !== undefined) {
				console.log(`[ErrorHandler] 使用服务器指定等待时间: ${serverDelay}ms`);
				return Math.min(serverDelay, this.retryConfig.maxDelayMs);
			}
		}

		// 指数退避（无服务器 header 时使用）
		const exponentialDelay = this.retryConfig.baseDelayMs * Math.pow(2, attempt);
		const cappedDelay = Math.min(exponentialDelay, this.retryConfig.maxDelayMs);

		// 添加抖动
		const jitter = cappedDelay * this.retryConfig.jitterFactor * Math.random();

		return Math.floor(cappedDelay + jitter);
	}

	/**
	 * 判断是否应该重试
	 */
	shouldRetry(error: unknown, attempt: number): boolean {
		if (attempt >= this.retryConfig.maxRetries) {
			return false;
		}

		const errorInfo = this.classifyError(error);
		return errorInfo.retryable;
	}

	/**
	 * 获取用户友好的错误消息
	 */
	getUserFriendlyMessage(error: unknown): string {
		const errorInfo = this.classifyError(error);
		let message = errorInfo.userMessage;

		if (errorInfo.suggestedAction) {
			message += `。${errorInfo.suggestedAction}`;
		}

		return message;
	}

	/**
	 * 包装异步函数，添加自动重试逻辑
	 */
	async withRetry<T>(
		fn: () => Promise<T>,
		onRetry?: (attempt: number, delay: number, error: unknown) => void
	): Promise<T> {
		let lastError: unknown;

		for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
			try {
				return await fn();
			} catch (error) {
				lastError = error;

				if (!this.shouldRetry(error, attempt)) {
					throw error;
				}

				const delay = this.calculateRetryDelay(attempt, error);
				console.log(`[ErrorHandler] 重试 ${attempt + 1}/${this.retryConfig.maxRetries}，延迟 ${delay}ms`);

				if (onRetry) {
					onRetry(attempt + 1, delay, error);
				}

				await this.sleep(delay);
			}
		}

		throw lastError;
	}

	/**
	 * Sleep 辅助函数
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * 格式化错误日志
	 */
	formatErrorLog(error: unknown, context?: string): string {
		const errorInfo = this.classifyError(error);
		const timestamp = new Date().toISOString();

		let log = `[${timestamp}] [${errorInfo.type.toUpperCase()}]`;

		if (context) {
			log += ` [${context}]`;
		}

		log += ` ${errorInfo.message}`;

		return log;
	}
}

/**
 * 全局错误处理器实例
 */
export const errorHandler = new ErrorHandler();
