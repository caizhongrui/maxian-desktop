/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP (Model Context Protocol) HTTP 客户端
 * 实现 Streamable HTTP 传输协议 + 传统 SSE 传输协议
 * 参考: https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/
 *
 * 传输协议自动检测：
 * - URL 以 /sse 结尾 → 使用传统 SSE 传输（GET 建立流，POST 发消息）
 * - 其他 URL → 使用 Streamable HTTP 传输（POST 直接接收 JSON 或 SSE 流）
 */

import {
	McpServerConfig, McpTool, McpResource, McpResourceTemplate,
	McpToolCallResponse, McpResourceReadResponse,
	JsonRpcRequest, JsonRpcResponse,
	McpInitializeParams, McpInitializeResult
} from './McpTypes.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60000;  // SSE 连接超时更长

export class McpClient {
	private requestId = 0;
	private sessionId?: string;
	private initialized = false;

	// SSE 传输状态（仅 URL 以 /sse 结尾时使用）
	private sseMessageEndpoint?: string;
	private sseReader?: ReadableStreamDefaultReader<Uint8Array>;
	private ssePendingRequests = new Map<number | string, {
		resolve: (v: any) => void;
		reject: (e: Error) => void;
	}>();
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	private declare _sseReadingPromise: Promise<void> | undefined;

	constructor(private readonly config: McpServerConfig) { }

	get name(): string {
		return this.config.name;
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * 检测是否使用传统 SSE 传输协议（URL 以 /sse 结尾）
	 */
	private get useSseTransport(): boolean {
		return this.config.url.endsWith('/sse');
	}

	/**
	 * 初始化连接：发送 initialize 请求，获取服务器能力
	 */
	async initialize(): Promise<McpInitializeResult> {
		// SSE 传输需要先建立持久连接
		if (this.useSseTransport) {
			await this.connectSse();
		}

		const params: McpInitializeParams = {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {
				roots: { listChanged: false },
			},
			clientInfo: {
				name: 'tianhe-zhikai-ide',
				version: '1.0.0',
			},
		};

		const result = await this.sendRequest<McpInitializeResult>('initialize', params);

		// 发送 initialized 通知
		await this.sendNotification('notifications/initialized', {});

		this.initialized = true;
		return result;
	}

	/**
	 * 建立传统 SSE 连接（GET 请求）
	 * 等待 endpoint 事件获取消息发送地址，然后在后台持续读取响应
	 */
	private async connectSse(): Promise<void> {
		const headers: Record<string, string> = {
			'Accept': 'text/event-stream',
			// 不发 Cache-Control，避免 CORS preflight 拦截
			...this.config.headers,
		};

		const response = await fetch(this.config.url, {
			method: 'GET',
			headers,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`SSE 连接失败 ${response.status}: ${errorText}`);
		}

		const reader = response.body!.getReader();
		this.sseReader = reader;

		// 等待 endpoint 事件（包含消息发送地址）
		await this.waitForSseEndpoint(reader);

		// 启动后台读取循环（持续接收响应）
		this._sseReadingPromise = this.sseReadingLoop(reader);
	}

	/**
	 * 等待 SSE 的 endpoint 事件，提取消息端点 URL
	 */
	private async waitForSseEndpoint(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = '';
		const timeoutMs = 10000;
		const startTime = Date.now();

		while (Date.now() - startTime < timeoutMs) {
			const { done, value } = await reader.read();
			if (done) throw new Error('SSE 连接在收到 endpoint 事件前关闭');

			buffer += decoder.decode(value, { stream: true });

			const events = buffer.split('\n\n');
			buffer = events.pop() || '';

			for (const eventText of events) {
				const { eventType, data } = this.parseSseEvent(eventText);
				if (eventType === 'endpoint' && data) {
					// data 是相对路径，如 /message?sessionId=xxx
					const baseUrl = new URL(this.config.url);
					this.sseMessageEndpoint = new URL(data, baseUrl.origin).toString();
					return;
				}
			}
		}

		throw new Error('SSE endpoint 事件超时');
	}

	/**
	 * SSE 后台读取循环：持续处理服务器推送的 JSON-RPC 响应
	 */
	private async sseReadingLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				const events = buffer.split('\n\n');
				buffer = events.pop() || '';

				for (const eventText of events) {
					const { eventType, data } = this.parseSseEvent(eventText);
					if ((eventType === 'message' || eventType === 'response') && data) {
						try {
							const jsonResponse: JsonRpcResponse = JSON.parse(data);
							if (jsonResponse.id !== null && jsonResponse.id !== undefined) {
								const pending = this.ssePendingRequests.get(jsonResponse.id);
								if (pending) {
									this.ssePendingRequests.delete(jsonResponse.id);
									if (jsonResponse.error) {
										pending.reject(new Error(`MCP 错误: [${jsonResponse.error.code}] ${jsonResponse.error.message}`));
									} else {
										pending.resolve(jsonResponse.result);
									}
								}
							}
						} catch {
							// 忽略解析失败
						}
					}
				}
			}
		} catch (e) {
			// 连接断开，拒绝所有待处理请求
			for (const [, pending] of this.ssePendingRequests) {
				pending.reject(new Error('SSE 连接断开'));
			}
			this.ssePendingRequests.clear();
		}
	}

	/**
	 * 解析单个 SSE 事件文本
	 */
	private parseSseEvent(eventText: string): { eventType: string; data: string } {
		const lines = eventText.split('\n');
		let eventType = 'message';
		let data = '';

		for (const line of lines) {
			if (line.startsWith('event:')) {
				eventType = line.slice(6).trim();
			} else if (line.startsWith('data:')) {
				data = line.slice(5).trim();
			}
		}

		return { eventType, data };
	}

	/**
	 * 列出所有工具
	 */
	async listTools(): Promise<McpTool[]> {
		const result = await this.sendRequest<{ tools: McpTool[] }>('tools/list', {});
		return result.tools || [];
	}

	/**
	 * 调用工具
	 */
	async callTool(toolName: string, args?: Record<string, unknown>): Promise<McpToolCallResponse> {
		const result = await this.sendRequest<McpToolCallResponse>('tools/call', {
			name: toolName,
			arguments: args || {},
		});
		return result;
	}

	/**
	 * 列出所有资源
	 */
	async listResources(): Promise<{ resources: McpResource[]; resourceTemplates: McpResourceTemplate[] }> {
		try {
			const result = await this.sendRequest<{ resources: McpResource[]; resourceTemplates?: McpResourceTemplate[] }>('resources/list', {});
			return {
				resources: result.resources || [],
				resourceTemplates: result.resourceTemplates || [],
			};
		} catch {
			return { resources: [], resourceTemplates: [] };
		}
	}

	/**
	 * 读取资源
	 */
	async readResource(uri: string): Promise<McpResourceReadResponse> {
		const result = await this.sendRequest<McpResourceReadResponse>('resources/read', { uri });
		return result;
	}

	/**
	 * 发送 JSON-RPC 请求（带响应）
	 * 根据传输类型选择不同的发送方式
	 */
	private async sendRequest<T>(method: string, params: any): Promise<T> {
		const id = ++this.requestId;

		if (this.useSseTransport) {
			return this.sendRequestViaSse<T>(id, method, params);
		} else {
			return this.sendRequestViaStreamableHttp<T>(id, method, params);
		}
	}

	/**
	 * 通过传统 SSE 传输发送请求
	 * POST 到 sseMessageEndpoint，通过 SSE 流接收响应
	 */
	private sendRequestViaSse<T>(id: number, method: string, params: any): Promise<T> {
		if (!this.sseMessageEndpoint) {
			return Promise.reject(new Error('SSE 消息端点未建立，请先调用 initialize()'));
		}

		const request: JsonRpcRequest = {
			jsonrpc: '2.0',
			method,
			params,
			id,
		};

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...this.config.headers,
		};

		return new Promise<T>((resolve, reject) => {
			// 注册待处理请求
			this.ssePendingRequests.set(id, { resolve, reject });

			// 设置超时
			const timeoutId = setTimeout(() => {
				this.ssePendingRequests.delete(id);
				reject(new Error(`请求超时: ${method}`));
			}, REQUEST_TIMEOUT_MS);

			// 发送 POST 请求（不等待响应，响应通过 SSE 流推送）
			fetch(this.sseMessageEndpoint!, {
				method: 'POST',
				headers,
				body: JSON.stringify(request),
			}).then(response => {
				if (!response.ok) {
					clearTimeout(timeoutId);
					this.ssePendingRequests.delete(id);
					response.text().then(text => {
						reject(new Error(`MCP HTTP error ${response.status}: ${text}`));
					});
				}
				// 注意：响应体通过 SSE 流接收，这里不读取响应体
			}).catch(e => {
				clearTimeout(timeoutId);
				this.ssePendingRequests.delete(id);
				reject(e);
			});

			// 在原始 Promise 上包装 clearTimeout
			const originalResolve = resolve;
			const originalReject = reject;
			this.ssePendingRequests.set(id, {
				resolve: (v) => { clearTimeout(timeoutId); originalResolve(v); },
				reject: (e) => { clearTimeout(timeoutId); originalReject(e); },
			});
		});
	}

	/**
	 * 通过 Streamable HTTP 发送请求（原有实现）
	 */
	private async sendRequestViaStreamableHttp<T>(id: number, method: string, params: any): Promise<T> {
		const request: JsonRpcRequest = {
			jsonrpc: '2.0',
			method,
			params,
			id,
		};

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			...this.config.headers,
		};

		if (this.sessionId) {
			headers['mcp-session-id'] = this.sessionId;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		try {
			const response = await fetch(this.config.url, {
				method: 'POST',
				headers,
				body: JSON.stringify(request),
				signal: controller.signal,
			});

			// 从响应头中提取 session ID
			const newSessionId = response.headers.get('mcp-session-id');
			if (newSessionId) {
				this.sessionId = newSessionId;
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`MCP HTTP error ${response.status}: ${errorText}`);
			}

			const contentType = response.headers.get('content-type') || '';

			if (contentType.includes('text/event-stream')) {
				// SSE 流式响应
				return await this.parseSSEResponse<T>(response, id);
			} else {
				// 普通 JSON 响应
				const jsonResponse: JsonRpcResponse = await response.json();
				return this.extractResult<T>(jsonResponse, method);
			}
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * 发送 JSON-RPC 通知（无响应）
	 */
	private async sendNotification(method: string, params: any): Promise<void> {
		const notification = {
			jsonrpc: '2.0',
			method,
			params,
		};

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			...this.config.headers,
		};

		if (this.useSseTransport) {
			// SSE 传输：POST 到消息端点
			if (this.sseMessageEndpoint) {
				try {
					await fetch(this.sseMessageEndpoint, {
						method: 'POST',
						headers,
						body: JSON.stringify(notification),
					});
				} catch {
					// 通知失败不影响主流程
				}
			}
		} else {
			// Streamable HTTP 传输
			if (this.sessionId) {
				headers['mcp-session-id'] = this.sessionId;
			}
			try {
				await fetch(this.config.url, {
					method: 'POST',
					headers,
					body: JSON.stringify(notification),
				});
			} catch {
				// 通知失败不影响主流程
			}
		}
	}

	/**
	 * 解析 SSE 流式响应（Streamable HTTP 专用），找到匹配 id 的消息
	 */
	private async parseSSEResponse<T>(response: Response, targetId: number | string): Promise<T> {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// 解析 SSE 事件（以 \n\n 分隔）
				const events = buffer.split('\n\n');
				buffer = events.pop() || '';

				for (const eventText of events) {
					const { eventType, data } = this.parseSseEvent(eventText);

					if (eventType === 'message' && data) {
						try {
							const jsonResponse: JsonRpcResponse = JSON.parse(data);
							if (jsonResponse.id === targetId) {
								return this.extractResult<T>(jsonResponse, '');
							}
						} catch {
							// 忽略解析失败的事件
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		throw new Error('SSE 流结束但未收到匹配的响应');
	}

	/**
	 * 从 JSON-RPC 响应中提取结果
	 */
	private extractResult<T>(response: JsonRpcResponse, method: string): T {
		if (response.error) {
			throw new Error(`MCP 错误 (${method}): [${response.error.code}] ${response.error.message}`);
		}
		return response.result as T;
	}

	/**
	 * 重置连接状态
	 */
	reset(): void {
		this.initialized = false;
		this.sessionId = undefined;
		this.requestId = 0;
		this.sseMessageEndpoint = undefined;
		if (this.sseReader) {
			try { this.sseReader.cancel(); } catch { /* ignore */ }
			this.sseReader = undefined;
		}
		this.ssePendingRequests.clear();
	}
}
