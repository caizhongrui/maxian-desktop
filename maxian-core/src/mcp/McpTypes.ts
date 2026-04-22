/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP (Model Context Protocol) 类型定义
 * 支持 Streamable HTTP 传输协议
 */

/** MCP 服务器配置 */
export interface McpServerConfig {
	/** 服务器唯一名称（用于工具命名前缀） */
	name: string;
	/** 服务器 URL，如 https://mcp.figma.com/mcp */
	url: string;
	/** HTTP 请求头，如 Authorization: Bearer <token> */
	headers?: Record<string, string>;
	/** 是否启用 */
	enabled: boolean;
	/** 描述 */
	description?: string;
}

/** MCP 工具定义 */
export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: {
		type: string;
		properties?: Record<string, any>;
		required?: string[];
		[key: string]: any;
	};
}

/** MCP 资源定义 */
export interface McpResource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

/** MCP 资源模板 */
export interface McpResourceTemplate {
	uriTemplate: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

/** MCP 服务器运行时状态 */
export interface McpServerInfo {
	config: McpServerConfig;
	tools: McpTool[];
	resources: McpResource[];
	resourceTemplates: McpResourceTemplate[];
	isConnected: boolean;
	isConnecting: boolean;
	error?: string;
	sessionId?: string;
}

/** MCP 工具调用结果内容项 */
export interface McpContentItem {
	type: 'text' | 'image' | 'resource' | 'resource_link' | 'audio';
	text?: string;
	mimeType?: string;
	data?: string;
	uri?: string;
	name?: string;
	description?: string;
	resource?: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

/** MCP 工具调用响应 */
export interface McpToolCallResponse {
	content: McpContentItem[];
	isError?: boolean;
}

/** MCP 资源读取响应 */
export interface McpResourceReadResponse {
	contents: Array<{
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	}>;
}

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
	jsonrpc: '2.0';
	method: string;
	params?: any;
	id: number | string;
}

/** JSON-RPC 2.0 响应 */
export interface JsonRpcResponse {
	jsonrpc: '2.0';
	result?: any;
	error?: {
		code: number;
		message: string;
		data?: any;
	};
	id: number | string | null;
}

/** MCP Initialize 参数 */
export interface McpInitializeParams {
	protocolVersion: string;
	capabilities: {
		roots?: { listChanged?: boolean };
		sampling?: {};
	};
	clientInfo: {
		name: string;
		version: string;
	};
}

/** MCP Initialize 结果 */
export interface McpInitializeResult {
	protocolVersion: string;
	capabilities: {
		logging?: {};
		prompts?: { listChanged?: boolean };
		resources?: { subscribe?: boolean; listChanged?: boolean };
		tools?: { listChanged?: boolean };
	};
	serverInfo: {
		name: string;
		version: string;
	};
}
