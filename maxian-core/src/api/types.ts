/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * API 类型定义
 * 参考 Kilocode 的 API 架构，为千问模型定制
 */

/**
 * 消息角色
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 文本内容块
 */
export interface TextContentBlock {
	type: 'text';
	text: string;
}

/**
 * 图片内容块
 */
export interface ImageContentBlock {
	type: 'image';
	source: {
		type: 'base64' | 'url';
		data: string;
		media_type?: string;
	};
}

/**
 * 工具使用内容块
 */
export interface ToolUseContentBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, any>;
}

/**
 * 工具结果内容块
 */
export interface ToolResultContentBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

/**
 * 内容块联合类型
 */
export type ContentBlock = TextContentBlock | ImageContentBlock | ToolUseContentBlock | ToolResultContentBlock;

/**
 * 消息参数
 */
export interface MessageParam {
	role: MessageRole;
	content: string | ContentBlock[];
}

/**
 * 工具定义
 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: {
		type: 'object';
		properties: Record<string, any>;
		required?: string[];
	};
}

/**
 * API 流式响应块类型
 */
export type StreamChunkType = 'text' | 'tool_use' | 'usage' | 'error' | 'heartbeat' | 'reasoning';

/**
 * 文本流块
 */
export interface TextStreamChunk {
	type: 'text';
	text: string;
}

/**
 * 工具使用流块
 */
export interface ToolUseStreamChunk {
	type: 'tool_use';
	id: string;
	name: string;
	input: string; // JSON字符串
	/** 是否为进度片段（true=仍在积累参数中，false=参数已完整） */
	isPartial?: boolean;
}

/**
 * 使用量流块
 * 支持精确 Token 统计和缓存 Token 统计
 */
export interface UsageStreamChunk {
	type: 'usage';
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** 缓存读取的 token 数（用于 prompt caching） */
	cacheReadInputTokens?: number;
	/** 缓存写入的 token 数（用于 prompt caching） */
	cacheCreationInputTokens?: number;
	/** E2优化：输出被截断的原因（'length' 表示命中 max_output_tokens 上限） */
	stopReason?: string;
}

/**
 * 错误流块
 */
export interface ErrorStreamChunk {
	type: 'error';
	error: string;
}

/**
 * 心跳流块（用于长等待期间刷新前端进度状态）
 */
export interface HeartbeatStreamChunk {
	type: 'heartbeat';
	elapsedMs: number;
}

/**
 * 思考链流块（模型 reasoning_content 阶段，内容不展示给用户，只用于进度显示）
 */
export interface ReasoningStreamChunk {
	type: 'reasoning';
	text: string;
}

/**
 * 流响应块联合类型
 */
export type StreamChunk = TextStreamChunk | ToolUseStreamChunk | UsageStreamChunk | ErrorStreamChunk | HeartbeatStreamChunk | ReasoningStreamChunk;

/**
 * API Stream 类型 (AsyncGenerator)
 */
export type ApiStream = AsyncGenerator<StreamChunk, void, unknown>;

/**
 * 模型信息
 */
export interface ModelInfo {
	id: string;
	name: string;
	maxTokens: number;
	supportsTools: boolean;
	supportsVision: boolean;
	supportsStreaming: boolean;
}

/**
 * API 配置
 */
export interface ApiConfiguration {
	apiKey: string;
	model: string;
	temperature?: number;
	maxTokens?: number;
	timeout?: number;
}

/**
 * API Handler 接口
 */
export interface IApiHandler {
	/**
	 * 创建消息并返回流式响应
	 * @param systemPrompt 系统提示词
	 * @param messages 消息历史
	 * @param tools 可用工具列表
	 */
	createMessage(
		systemPrompt: string,
		messages: MessageParam[],
		tools?: ToolDefinition[]
	): ApiStream;

	/**
	 * 获取当前模型信息
	 */
	getModel(): ModelInfo;

	/**
	 * 计算 token 数量
	 * @param content 内容块数组
	 */
	countTokens(content: ContentBlock[]): Promise<number>;
}
