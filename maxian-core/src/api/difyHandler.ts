/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ApiStream,
	StreamChunk,
	TextStreamChunk,
	UsageStreamChunk,
	ErrorStreamChunk
} from './types.js';
import { CancellationToken } from '../types/cancellation.js';

/**
 * IRequestService 类型定义（避免循环依赖）
 */
interface IRequestService {
	request(options: any, token: CancellationToken): Promise<{
		res: { headers: any; statusCode?: number };
		stream: any;
	}>;
}

/**
 * Dify API 配置
 */
export interface DifyConfiguration {
	apiUrl: string;      // Dify API 地址，如 http://dify.boyocloud.com/v1
	apiKey: string;      // Dify API Key，如 app-Y42FsQ8Vho29AWjZCzBzgIil
	user?: string;       // 用户标识
	proxyBaseUrl?: string;  // 可选的代理服务地址，如 http://127.0.0.1:8088
	requestService?: IRequestService;  // 可选的请求服务（用于避免CORS）
}

/**
 * Dify Chat 请求参数
 */
interface DifyChatRequest {
	query: string;                    // 用户输入
	inputs?: Record<string, string>;  // 变量键值对
	response_mode: 'streaming' | 'blocking';
	user: string;                     // 用户标识
	conversation_id?: string;         // 会话ID（用于多轮对话）
}

/**
 * Dify SSE 事件类型
 */
interface DifyMessageEvent {
	event: 'message';
	task_id: string;
	id: string;
	answer: string;
	created_at: number;
}

interface DifyAgentMessageEvent {
	event: 'agent_message';
	task_id: string;
	id: string;
	answer: string;
	created_at: number;
}

interface DifyMessageEndEvent {
	event: 'message_end';
	task_id: string;
	id: string;
	conversation_id: string;
	metadata: {
		usage: {
			prompt_tokens: number;
			completion_tokens: number;
			total_tokens: number;
		};
	};
}

interface DifyErrorEvent {
	event: 'error';
	task_id: string;
	message: string;
	code: string;
}

type DifySSEEvent = DifyMessageEvent | DifyAgentMessageEvent | DifyMessageEndEvent | DifyErrorEvent;

/**
 * Dify API Handler
 * 专门用于调用 Dify 知识库应用的 Chat API
 */
export class DifyHandler {
	private config: DifyConfiguration;
	private conversationId: string | null = null;
	private currentTaskId: string | null = null;  // 当前任务ID（用于停止）
	private requestService: IRequestService | undefined;

	constructor(config: DifyConfiguration) {
		this.config = config;
		this.requestService = config.requestService;
		console.log('[Maxian] DifyHandler 初始化，API URL:', config.apiUrl, 'proxyBaseUrl:', config.proxyBaseUrl || '未配置', 'requestService:', this.requestService ? '已提供' : '未提供');
	}

	/**
	 * 发送消息并返回流式响应
	 * @param query 用户问题
	 * @param inputs 可选的输入变量
	 * @param abortSignal 可选的中止信号
	 */
	async *sendMessage(query: string, inputs?: Record<string, string>, abortSignal?: AbortSignal): ApiStream {
		try {
			// 构建请求参数
			const requestBody: DifyChatRequest = {
				query: query,
				inputs: inputs || {},
				response_mode: 'streaming',
				user: this.config.user || 'default-user',
				...(this.conversationId ? { conversation_id: this.conversationId } : {})
			};

			// 构建 API 端点（确保以 /chat-messages 结尾）
			const apiEndpoint = this.buildApiEndpoint();

			console.log('[Maxian] Dify 请求:', apiEndpoint, requestBody);

			// 根据是否有 proxyBaseUrl 或 requestService 选择不同的请求方式
			// 优先使用 proxy（如果配置了），因为 IRequestService 在渲染进程仍会遇到CORS
			if (this.config.proxyBaseUrl) {
				// 使用 fetch + proxy（最可靠的避免CORS方式）
				console.log('[Maxian] 使用fetch+proxy发送请求（避免CORS）');
				yield* this.sendWithFetch(apiEndpoint, requestBody, abortSignal);
			} else if (this.requestService) {
				// 使用 IRequestService（在主进程中可以避免CORS，但在渲染进程不行）
				console.log('[Maxian] 使用IRequestService发送请求（可能遇到CORS）');
				yield* this.sendWithRequestService(apiEndpoint, requestBody, abortSignal);
			} else {
				// 直接使用fetch（会遇到CORS）
				console.log('[Maxian] 直接使用fetch发送请求（会遇到CORS）');
				yield* this.sendWithFetch(apiEndpoint, requestBody, abortSignal);
			}

		} catch (error) {
			console.error('[Maxian] DifyHandler 错误:', error);
			const errorChunk: ErrorStreamChunk = {
				type: 'error',
				error: error instanceof Error ? error.message : String(error)
			};
			yield errorChunk;
		}
	}

	/**
	 * 使用 fetch 发送请求
	 */
	private async *sendWithFetch(apiEndpoint: string, requestBody: DifyChatRequest, abortSignal?: AbortSignal): ApiStream {
		let requestUrl: string;
		let requestHeaders: Record<string, string>;
		let requestBodyStr: string;

		// 如果配置了代理服务,使用代理
		if (this.config.proxyBaseUrl) {
			console.log('[Maxian] 使用代理服务发送请求:', this.config.proxyBaseUrl);

			// 使用代理端点（移除末尾斜杠避免双斜杠）
			const proxyBase = this.config.proxyBaseUrl.replace(/\/$/, '');
			requestUrl = `${proxyBase}/dify/proxy/stream?targetUrl=${encodeURIComponent(apiEndpoint)}&apiKey=${encodeURIComponent(this.config.apiKey)}`;

			// 代理请求只需要Content-Type
			requestHeaders = {
				'Content-Type': 'application/json'
			};

			requestBodyStr = JSON.stringify(requestBody);
		} else {
			// 直接请求Dify(会遇到CORS)
			console.log('[Maxian] 直接请求Dify API(可能遇到CORS)');
			requestUrl = apiEndpoint;
			requestHeaders = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.config.apiKey}`
			};
			requestBodyStr = JSON.stringify(requestBody);
		}

		const response = await fetch(requestUrl, {
			method: 'POST',
			headers: requestHeaders,
			body: requestBodyStr,
			signal: abortSignal
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error('[Maxian] Dify API 错误:', response.status, errorText);
			const errorChunk: ErrorStreamChunk = {
				type: 'error',
				error: `Dify API 错误 (${response.status}): ${errorText}`
			};
			yield errorChunk;
			return;
		}

		yield* this.processStream(response);
	}

	/**
	 * 使用 IRequestService 发送请求（避免CORS）
	 */
	private async *sendWithRequestService(apiEndpoint: string, requestBody: DifyChatRequest, abortSignal?: AbortSignal): ApiStream {
		const token = CancellationToken.None; // TODO: 从 abortSignal 转换为 CancellationToken

		const context = await this.requestService!.request({
			type: 'POST',
			url: apiEndpoint,
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.config.apiKey}`
			},
			data: JSON.stringify(requestBody)
		}, token);

		if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
			console.error('[Maxian] Dify API 错误:', context.res.statusCode);
			const errorChunk: ErrorStreamChunk = {
				type: 'error',
				error: `Dify API 错误 (${context.res.statusCode})`
			};
			yield errorChunk;
			return;
		}

		yield* this.processVSBufferStream(context.stream);
	}

	/**
	 * 构建 API 端点
	 */
	private buildApiEndpoint(): string {
		const baseUrl = this.config.apiUrl.replace(/\/$/, ''); // 移除末尾斜杠

		// 如果 URL 已经包含 /chat-messages，直接返回
		if (baseUrl.endsWith('/chat-messages')) {
			return baseUrl;
		}

		// 否则添加 /chat-messages
		return `${baseUrl}/chat-messages`;
	}

	/**
	 * 处理 VSBufferReadableStream (IRequestService 返回的流)
	 */
	private async *processVSBufferStream(stream: any): AsyncGenerator<StreamChunk> {
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			// VSBufferReadableStream 的读取方式
			for await (const chunk of stream) {
				// chunk 是 VSBuffer 类型
				const text = decoder.decode(chunk.buffer, { stream: true });
				buffer += text;

				// 按行分割处理SSE
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim() || !line.startsWith('data: ')) {
						continue;
					}

					const data = line.slice(6);

					try {
						const event: DifySSEEvent = JSON.parse(data);

						if (event.task_id) {
							this.currentTaskId = event.task_id;
						}

						if (event.event === 'message' || event.event === 'agent_message') {
							const textChunk: TextStreamChunk = {
								type: 'text',
								text: event.answer
							};
							yield textChunk;
						} else if (event.event === 'message_end') {
							this.conversationId = event.conversation_id;
							console.log('[Maxian] Dify 会话ID:', this.conversationId);

							if (event.metadata?.usage) {
								const usageChunk: UsageStreamChunk = {
									type: 'usage',
									inputTokens: event.metadata.usage.prompt_tokens,
									outputTokens: event.metadata.usage.completion_tokens,
									totalTokens: event.metadata.usage.total_tokens
								};
								yield usageChunk;
							}
						} else if (event.event === 'error') {
							console.error('[Maxian] Dify 错误:', event.message);
							const errorChunk: ErrorStreamChunk = {
								type: 'error',
								error: `Dify 错误: ${event.message} (${event.code})`
							};
							yield errorChunk;
						}
					} catch (parseError) {
						console.error('[Maxian] 解析 Dify 响应失败:', parseError, 'data:', data);
					}
				}
			}
		} catch (error) {
			console.error('[Maxian] 处理VSBuffer流失败:', error);
			throw error;
		}
	}

	/**
	 * 处理 SSE 流式响应 (fetch 返回的 Response)
	 */
	private async *processStream(response: Response): AsyncGenerator<StreamChunk> {
		const reader = response.body?.getReader();
		if (!reader) {
			console.error('[Maxian] 无法获取 Dify 响应流');
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					break;
				}

				// 解码数据
				buffer += decoder.decode(value, { stream: true });

				// 按行分割
				const lines = buffer.split('\n');
				buffer = lines.pop() || ''; // 保留最后一行（可能不完整）

				for (const line of lines) {
					if (!line.trim() || !line.startsWith('data: ')) {
						continue;
					}

					const data = line.slice(6); // 移除 "data: " 前缀

					try {
						const event: DifySSEEvent = JSON.parse(data);

						// 保存task_id（用于停止请求）
						if (event.task_id) {
							this.currentTaskId = event.task_id;
						}

						// 处理不同类型的事件
						if (event.event === 'message' || event.event === 'agent_message') {
							// 文本消息块（支持 message 和 agent_message）
							const textChunk: TextStreamChunk = {
								type: 'text',
								text: event.answer
							};
							yield textChunk;
						} else if (event.event === 'message_end') {
							// 消息结束，保存会话ID用于多轮对话
							this.conversationId = event.conversation_id;
							console.log('[Maxian] Dify 会话ID:', this.conversationId);

							// 输出使用量信息
							if (event.metadata?.usage) {
								const usageChunk: UsageStreamChunk = {
									type: 'usage',
									inputTokens: event.metadata.usage.prompt_tokens,
									outputTokens: event.metadata.usage.completion_tokens,
									totalTokens: event.metadata.usage.total_tokens
								};
								yield usageChunk;
							}
						} else if (event.event === 'error') {
							// 错误事件
							console.error('[Maxian] Dify 错误:', event.message);
							const errorChunk: ErrorStreamChunk = {
								type: 'error',
								error: `Dify 错误: ${event.message} (${event.code})`
							};
							yield errorChunk;
						}
						// 忽略其他事件类型（如 ping、agent_thought 等）

					} catch (parseError) {
						console.error('[Maxian] 解析 Dify 响应失败:', parseError, 'data:', data);
					}
				}
			}

		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * 获取当前会话ID
	 */
	getConversationId(): string | null {
		return this.conversationId;
	}

	/**
	 * 重置会话（开始新对话）
	 */
	resetConversation(): void {
		this.conversationId = null;
		console.log('[Maxian] Dify 会话已重置');
	}

	/**
	 * 停止当前任务（调用Dify停止API）
	 * @returns 是否成功调用停止API
	 */
	async stopCurrentTask(): Promise<boolean> {
		if (!this.currentTaskId) {
			console.warn('[Maxian] 无法停止：没有正在进行的任务ID');
			return false;
		}

		try {
			const baseUrl = this.config.apiUrl.replace(/\/$/, '');
			const stopUrl = `${baseUrl}/chat-messages/${this.currentTaskId}/stop`;

			console.log('[Maxian] 调用Dify停止API:', stopUrl);

			let requestUrl: string;
			let requestHeaders: Record<string, string>;
			const requestBody = JSON.stringify({
				user: this.config.user || 'default-user'
			});

			// 如果配置了代理服务,使用代理
			if (this.config.proxyBaseUrl) {
				const proxyBase = this.config.proxyBaseUrl.replace(/\/$/, '');
				requestUrl = `${proxyBase}/dify/proxy/stop?targetUrl=${encodeURIComponent(stopUrl)}&apiKey=${encodeURIComponent(this.config.apiKey)}`;
				requestHeaders = {
					'Content-Type': 'application/json'
				};
			} else {
				requestUrl = stopUrl;
				requestHeaders = {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.config.apiKey}`
				};
			}

			const response = await fetch(requestUrl, {
				method: 'POST',
				headers: requestHeaders,
				body: requestBody
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('[Maxian] Dify停止API错误:', response.status, errorText);
				return false;
			}

			const result = await response.json();
			console.log('[Maxian] Dify停止API响应:', result);

			// 清除task_id
			this.currentTaskId = null;
			return true;

		} catch (error) {
			console.error('[Maxian] 调用Dify停止API失败:', error);
			return false;
		}
	}
}
