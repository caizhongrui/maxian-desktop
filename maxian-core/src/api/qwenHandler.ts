/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	IApiHandler,
	ApiConfiguration,
	MessageParam,
	ToolDefinition,
	ApiStream,
	ModelInfo,
	ContentBlock,
	StreamChunk,
	TextStreamChunk,
	ToolUseStreamChunk,
	UsageStreamChunk,
	ErrorStreamChunk
} from './types.js';

/**
 * 千问 API 请求消息格式
 */
interface QwenMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string;
	tool_call_id?: string;  // 工具结果消息需要此字段
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: {
			name: string;
			arguments: string;
		};
	}>;
}

/**
 * 千问 API 工具定义格式
 */
interface QwenTool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: any;
	};
}

/**
 * 千问 API 请求参数
 */
interface QwenChatRequest {
	model: string;
	messages: QwenMessage[];
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	stream?: boolean;
	tools?: QwenTool[];
}

/**
 * 千问 API 响应（流式）
 */
interface QwenStreamChunk {
	id: string;
	choices: Array<{
		delta: {
			role?: string;
			content?: string;
			tool_calls?: Array<{
				index: number;
				id: string;
				type: 'function';
				function: {
					name: string;
					arguments: string;
				};
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

/**
 * 千问模型信息映射
 */
const QWEN_MODELS: Record<string, ModelInfo> = {
	'qwen-coder-turbo': {
		id: 'qwen-coder-turbo',
		name: 'Qwen Coder Turbo',
		maxTokens: 4096,
		supportsTools: true,
		supportsVision: false,
		supportsStreaming: true
	},
	'qwen3-coder-480b-a35b-instruct': {
		id: 'qwen3-coder-480b-a35b-instruct',
		name: 'Qwen3 Coder 480B',
		maxTokens: 8192,
		supportsTools: true,
		supportsVision: false,
		supportsStreaming: true
	},
	'qwen-max': {
		id: 'qwen-max',
		name: 'Qwen Max',
		maxTokens: 8192,
		supportsTools: true,
		supportsVision: true,
		supportsStreaming: true
	},
	'qwen-plus': {
		id: 'qwen-plus',
		name: 'Qwen Plus',
		maxTokens: 8192,
		supportsTools: true,
		supportsVision: false,
		supportsStreaming: true
	}
};

/**
 * 千问 API Handler
 * 实现与阿里云千问模型的对接
 */
export class QwenHandler implements IApiHandler {
	private config: ApiConfiguration;
	private apiEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
	private currentAbortController: AbortController | null = null;

	constructor(config: ApiConfiguration) {
		this.config = config;
		console.log('[Maxian] QwenHandler 初始化，模型:', config.model);
	}

	/**
	 * 中止当前请求
	 */
	async stopCurrentRequest(): Promise<boolean> {
		if (this.currentAbortController) {
			console.log('[Maxian] QwenHandler: 使用AbortController中止请求');
			this.currentAbortController.abort();
			this.currentAbortController = null;
			return true;
		}
		return false;
	}

	/**
	 * 获取模型信息
	 */
	getModel(): ModelInfo {
		const modelInfo = QWEN_MODELS[this.config.model];
		if (!modelInfo) {
			console.warn('[Maxian] 未知模型:', this.config.model, '使用默认配置');
			return {
				id: this.config.model,
				name: this.config.model,
				maxTokens: 4096,
				supportsTools: true,
				supportsVision: false,
				supportsStreaming: true
			};
		}
		return modelInfo;
	}

	/**
	 * 创建消息并返回流式响应
	 */
	async *createMessage(
		systemPrompt: string,
		messages: MessageParam[],
		tools?: ToolDefinition[]
	): ApiStream {
		try {
			// 转换消息格式
			const qwenMessages = this.convertMessages(systemPrompt, messages);

			// 转换工具定义
			const qwenTools = tools ? this.convertTools(tools) : undefined;

			// 构建请求参数
			const requestBody: QwenChatRequest = {
				model: this.config.model,
				messages: qwenMessages,
				temperature: this.config.temperature ?? 0.55,  // Qwen 最优温度（参考 OpenCode）
				top_p: 1,                                       // Qwen 专属配置（参考 OpenCode transform.ts）
				max_tokens: this.config.maxTokens ?? 8192,
				stream: true,
				...(qwenTools && qwenTools.length > 0 ? { tools: qwenTools } : {})
			};

			// 发送请求（使用 AbortController 支持用户中止）
			const controller = new AbortController();
			this.currentAbortController = controller;
			const response = await fetch(this.apiEndpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.config.apiKey}`
				},
				body: JSON.stringify(requestBody),
				signal: controller.signal
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('[Maxian] 千问 API 错误:', response.status, errorText);
				const errorChunk: ErrorStreamChunk = {
					type: 'error',
					error: `千问 API 错误 (${response.status}): ${errorText}`
				};
				yield errorChunk;
				return;
			}

			// 处理流式响应
			yield* this.processStream(response);

		} catch (error) {
			// AbortError 不作为错误处理
			if (error instanceof DOMException && error.name === 'AbortError') {
				console.log('[Maxian] QwenHandler: 请求被用户中止');
				return;
			}
			console.error('[Maxian] QwenHandler 错误:', error);
			const errorChunk: ErrorStreamChunk = {
				type: 'error',
				error: error instanceof Error ? error.message : String(error)
			};
			yield errorChunk;
		} finally {
			this.currentAbortController = null;
		}
	}

	/**
	 * 处理流式响应
	 */
	private async *processStream(response: Response): AsyncGenerator<StreamChunk> {
		const reader = response.body?.getReader();
		if (!reader) {
			console.error('[Maxian] 无法获取响应流');
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';

		// 用于累积工具调用的参数（包含id、name和arguments）
		const toolCallsMap = new Map<string, { id: string; name: string; arguments: string }>();

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

					if (data === '[DONE]') {
						continue;
					}

					try {
						const chunk: QwenStreamChunk = JSON.parse(data);

						// 处理文本内容
						const delta = chunk.choices[0]?.delta;
						if (delta?.content) {
							const textChunk: TextStreamChunk = {
								type: 'text',
								text: delta.content
							};
							yield textChunk;
						}

						// 处理思考链内容（reasoning_content，Qwen3 等模型在生成正式回复前先吐出思维链）
						if ((delta as any)?.reasoning_content) {
							yield {
								type: 'reasoning',
								text: (delta as any).reasoning_content
							};
						}

						// 处理工具调用
						if (delta?.tool_calls) {
							for (const toolCall of delta.tool_calls) {
								// 使用index作为key，因为后续chunks的id可能是空字符串
								const toolKey = `tool_${toolCall.index}`;
								const toolId = toolCall.id || toolKey; // 如果有真实id则使用，否则用临时key
								const toolName = toolCall.function?.name || '';
								const argsFragment = toolCall.function?.arguments || '';

								if (!toolCallsMap.has(toolKey)) {
									toolCallsMap.set(toolKey, {
										id: toolId,
										name: toolName,
										arguments: ''
									});
								}

								const existing = toolCallsMap.get(toolKey)!;
								// 更新id和name（第一个chunk会有这些信息）
								if (toolId && toolId !== toolKey) {
									existing.id = toolId;
								}
								if (toolName) {
									existing.name = toolName;
								}
								existing.arguments += argsFragment;

								// 实时 yield 进度 chunk，让 UI 显示工具参数正在生成中
								if (existing.name && argsFragment) {
									yield {
										type: 'tool_use',
										id: existing.id,
										name: existing.name,
										input: existing.arguments,
										isPartial: true,
									} as ToolUseStreamChunk;
								}
							}
						}

						// 在finish_reason为tool_calls时，输出所有累积的工具调用
						if (chunk.choices[0]?.finish_reason === 'tool_calls') {
							for (const [_, toolData] of toolCallsMap.entries()) {
								const toolUseChunk: ToolUseStreamChunk = {
									type: 'tool_use',
									id: toolData.id,
									name: toolData.name,
									input: sanitizeToolArguments(toolData.arguments)
								};
								yield toolUseChunk;
							}
							toolCallsMap.clear(); // 清空，准备处理下一轮
						}

						// 处理使用量
						if (chunk.usage) {
							const usageChunk: UsageStreamChunk = {
								type: 'usage',
								inputTokens: chunk.usage.prompt_tokens,
								outputTokens: chunk.usage.completion_tokens,
								totalTokens: chunk.usage.total_tokens
							};
							yield usageChunk;
						}

					} catch (parseError) {
						console.error('[Maxian] 解析响应块失败:', parseError, 'data:', data);
					}
				}
			}

		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * 转换消息格式：Maxian -> Qwen
	 */
	private convertMessages(systemPrompt: string, messages: MessageParam[]): QwenMessage[] {
		const qwenMessages: QwenMessage[] = [];

		// 添加系统提示词
		if (systemPrompt) {
			qwenMessages.push({
				role: 'system',
				content: systemPrompt
			});
		}

		// 转换消息
		for (const message of messages) {
			if (message.role === 'tool') {
				// 工具结果消息 - 必须保持tool角色并包含tool_call_id
				// OpenAI兼容API要求每个tool_call都有对应的tool消息响应
				if (typeof message.content === 'string') {
					// 简单字符串内容（旧格式），转为user消息
					qwenMessages.push({
						role: 'user',
						content: message.content
					});
				} else {
					// ContentBlock[] - 提取tool_result块
					const toolResults = message.content.filter(block => block.type === 'tool_result');

					if (toolResults.length > 0) {
						// 为每个工具结果创建单独的tool消息
						for (const block of toolResults) {
							const toolResult = block as any;
							qwenMessages.push({
								role: 'tool',
								tool_call_id: toolResult.tool_use_id,
								content: toolResult.content
							});
						}
					} else {
						// 没有tool_result块，提取文本内容
						const content = message.content.map(block => {
							if (block.type === 'text') {
								return block.text;
							}
							return '';
						}).filter(s => s).join('\n');

						if (content) {
							qwenMessages.push({
								role: 'user',
								content
							});
						}
					}
				}
			} else {
				// 处理 user 和 assistant 消息
				if (typeof message.content === 'string') {
					// 简单字符串内容
					qwenMessages.push({
						role: message.role as 'user' | 'assistant',
						content: message.content
					});
				} else {
					// ContentBlock[] - 需要分别提取文本和工具调用
					const textBlocks = message.content.filter(block => block.type === 'text');
					const toolUseBlocks = message.content.filter(block => block.type === 'tool_use');

					// 提取文本内容
					const textContent = textBlocks
						.map(block => (block as any).text)
						.join('\n');

					// 提取工具调用
					const toolCalls = toolUseBlocks.map(block => {
						const toolUse = block as any;
						return {
							id: toolUse.id,
							type: 'function' as const,
							function: {
								name: toolUse.name,
								arguments: JSON.stringify(toolUse.input)
							}
						};
					});

					// 构建消息
					const qwenMessage: QwenMessage = {
						role: message.role as 'user' | 'assistant'
					};

					// 添加文本内容（如果有）
					if (textContent) {
						qwenMessage.content = textContent;
					}

					// 添加工具调用（如果有）
					if (toolCalls.length > 0) {
						qwenMessage.tool_calls = toolCalls;
					}

					qwenMessages.push(qwenMessage);
				}
			}
		}

		return qwenMessages;
	}

	/**
	 * 转换工具定义：Maxian -> Qwen
	 */
	private convertTools(tools: ToolDefinition[]): QwenTool[] {
		return tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters
			}
		}));
	}

	/**
	 * 计算 token 数量（简单估算）
	 */
	async countTokens(content: ContentBlock[]): Promise<number> {
		// 简单估算：每个字符约 0.5 个 token（中文）或 0.25 个 token（英文）
		let totalChars = 0;

		for (const block of content) {
			if (block.type === 'text') {
				totalChars += block.text.length;
			} else if (block.type === 'tool_result') {
				totalChars += block.content.length;
			}
		}

		// 中英文混合，使用平均值
		return Math.ceil(totalChars * 0.4);
	}
}

/**
 * 安全解析工具参数字符串。先直接 JSON.parse；失败则依次尝试修复：
 *   1. 去除尾随逗号
 *   2. 未闭合字符串按最后一个 `"` 截断
 *   3. Python 风格 True/False/None → true/false/null
 *   4. 字符串内部未转义的换行符替换为 \n
 * 修复后再 parse 一次。
 *
 * 返回：
 *   - { ok: true, value }                        原文直接成功
 *   - { ok: true, value, repaired: true }        经修复后成功
 *   - { ok: false, error }                       全部失败
 *
 * 调用方应在 ok=false 时将 error 原文以 tool_result.is_error=true 返回给模型，
 * 让模型在下一轮自行重试，而不是抛异常或 silently 置空。
 */
export function safeParseToolArguments(
	raw: string,
	toolName: string,
): { ok: boolean; value?: any; error?: string; repaired?: boolean } {
	if (typeof raw !== 'string') {
		return { ok: true, value: raw };
	}
	// Step 0：空串当空对象
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { ok: true, value: {} };
	}
	// Step 1：直接 parse
	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch (firstErr) {
		// 进入修复流程
	}

	// Step 2：依次执行修复策略
	let repaired = trimmed;

	// 2a. 去除尾随逗号：`, }` / `, ]`
	repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

	// 2b. Python 风格布尔/None。只替换标识符位置（避免误伤字符串内容的粗暴替换，这里只做全局替换，
	//     实际风险可接受因为 Qwen 偶尔会直接吐 True/False/None 作为 JS 字面量）。
	repaired = repaired
		.replace(/\bTrue\b/g, 'true')
		.replace(/\bFalse\b/g, 'false')
		.replace(/\bNone\b/g, 'null');

	// 2c. 字符串内部未转义的换行符：仅在字符串内替换
	repaired = escapeUnescapedNewlinesInStrings(repaired);

	// 先尝试一次修复后 parse
	try {
		return { ok: true, value: JSON.parse(repaired), repaired: true };
	} catch {
		// 继续 2d
	}

	// 2d. 状态机方式计算括号深度，正确处理字符串内的引号和括号
	//     解决 SVG/HTML 等内容中包含大量 " 和 {} 导致简单正则计数失准的问题
	{
		// 首先尝试：关闭可能未闭合的字符串，再补齐括号
		// 状态机扫描：跟踪是否在字符串内部
		let inStr = false;
		let esc = false;
		const bracketStack: string[] = []; // 只记录字符串外的 { [
		let lastValidPos = -1; // 最后一个有效 JSON 结构字符的位置

		for (let i = 0; i < repaired.length; i++) {
			const c = repaired[i];
			if (esc) { esc = false; continue; }
			if (c === '\\' && inStr) { esc = true; continue; }
			if (c === '"') {
				inStr = !inStr;
				lastValidPos = i;
				continue;
			}
			if (inStr) { continue; } // 字符串内的一切都跳过
			if (c === '{' || c === '[') {
				bracketStack.push(c);
				lastValidPos = i;
			} else if (c === '}') {
				if (bracketStack.length > 0 && bracketStack[bracketStack.length - 1] === '{') {
					bracketStack.pop();
				}
				lastValidPos = i;
			} else if (c === ']') {
				if (bracketStack.length > 0 && bracketStack[bracketStack.length - 1] === '[') {
					bracketStack.pop();
				}
				lastValidPos = i;
			} else if (c === ':' || c === ',' || c === ' ' || c === '\n' || c === '\r' || c === '\t') {
				// JSON 结构字符，标记有效位置
				if (c === ':' || c === ',') { lastValidPos = i; }
			}
		}

		// 如果扫描结束时仍在字符串内，说明有未闭合的字符串
		let candidate = repaired;
		if (inStr) {
			// 关闭未闭合的字符串
			candidate += '"';
		}
		// 补齐未闭合的括号（从栈顶开始，按正确顺序关闭）
		for (let i = bracketStack.length - 1; i >= 0; i--) {
			candidate += bracketStack[i] === '[' ? ']' : '}';
		}

		try {
			return { ok: true, value: JSON.parse(candidate), repaired: true };
		} catch {
			// 尝试截断到 lastValidPos 再补齐
			if (lastValidPos > 0 && lastValidPos < repaired.length - 1) {
				let truncated = repaired.substring(0, lastValidPos + 1);
				// 重新扫描截断后的内容
				let inStr2 = false;
				let esc2 = false;
				const stack2: string[] = [];
				for (let i = 0; i < truncated.length; i++) {
					const c = truncated[i];
					if (esc2) { esc2 = false; continue; }
					if (c === '\\' && inStr2) { esc2 = true; continue; }
					if (c === '"') { inStr2 = !inStr2; continue; }
					if (inStr2) { continue; }
					if (c === '{' || c === '[') { stack2.push(c); }
					else if (c === '}' && stack2.length > 0 && stack2[stack2.length - 1] === '{') { stack2.pop(); }
					else if (c === ']' && stack2.length > 0 && stack2[stack2.length - 1] === '[') { stack2.pop(); }
				}
				if (inStr2) { truncated += '"'; }
				for (let i = stack2.length - 1; i >= 0; i--) {
					truncated += stack2[i] === '[' ? ']' : '}';
				}
				try {
					return { ok: true, value: JSON.parse(truncated), repaired: true };
				} catch {
					// fallthrough
				}
			}
		}
	}

	// 彻底失败
	const preview = trimmed.length > 300 ? trimmed.substring(0, 300) + '...' : trimmed;
	return {
		ok: false,
		error: `Failed to parse tool arguments for tool "${toolName}": JSON is malformed and could not be repaired. Preview: ${preview}`,
	};
}

/**
 * 在字符串字面量内部，将裸的换行符替换为 \n。
 * 状态机简单扫描，避免破坏已经正确转义的内容。
 */
function escapeUnescapedNewlinesInStrings(input: string): string {
	let out = '';
	let inString = false;
	let escape = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (escape) {
			out += ch;
			escape = false;
			continue;
		}
		if (ch === '\\') {
			out += ch;
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			out += ch;
			continue;
		}
		if (inString && (ch === '\n' || ch === '\r')) {
			out += ch === '\n' ? '\\n' : '\\r';
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * 清理 Qwen 流式 API 返回的工具参数字符串
 * Qwen API 有时会在完整 JSON 末尾多发一个 `}` 字符，导致 JSON.parse 失败
 */
function sanitizeToolArguments(args: string): string {
	const trimmed = args.trim();
	if (!trimmed.startsWith('{')) {
		return trimmed;
	}
	try {
		JSON.parse(trimmed);
		return trimmed;
	} catch {
		let depth = 0;
		let inString = false;
		let escape = false;
		for (let i = 0; i < trimmed.length; i++) {
			const c = trimmed[i];
			if (escape) { escape = false; continue; }
			if (c === '\\' && inString) { escape = true; continue; }
			if (c === '"') { inString = !inString; continue; }
			if (inString) { continue; }
			if (c === '{') { depth++; }
			else if (c === '}') {
				depth--;
				if (depth === 0) {
					console.warn(`[Maxian] sanitizeToolArguments: 截取合法JSON (${i + 1}/${trimmed.length})`);
					return trimmed.substring(0, i + 1);
				}
			}
		}
		return trimmed;
	}
}
