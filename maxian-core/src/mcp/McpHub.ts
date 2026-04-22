/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP Hub：管理多个 MCP 服务器连接
 * 提供统一的工具调用和资源访问接口
 */

import { McpServerConfig, McpServerInfo, McpTool, McpToolCallResponse, McpResourceReadResponse } from './McpTypes.js';
import { McpClient } from './McpClient.js';

export type McpHubChangeListener = (servers: McpServerInfo[]) => void;

interface McpRetryState {
	failureCount: number;
	nextRetryAt: number;
	lastError: string;
}

export class McpHub {
	private servers: Map<string, McpServerInfo> = new Map();
	private clients: Map<string, McpClient> = new Map();
	private retryStates: Map<string, McpRetryState> = new Map();
	private changeListeners: McpHubChangeListener[] = [];
	private static readonly RETRY_BASE_DELAY_MS = 3000;
	private static readonly RETRY_MAX_DELAY_MS = 60000;

	/**
	 * 获取所有服务器状态
	 */
	getAllServers(): McpServerInfo[] {
		return Array.from(this.servers.values());
	}

	/**
	 * 获取指定服务器状态
	 */
	getServer(name: string): McpServerInfo | undefined {
		return this.servers.get(name);
	}

	/**
	 * 注册变化监听器
	 */
	onDidChange(listener: McpHubChangeListener): () => void {
		this.changeListeners.push(listener);
		return () => {
			const idx = this.changeListeners.indexOf(listener);
			if (idx >= 0) this.changeListeners.splice(idx, 1);
		};
	}

	private notifyChange(): void {
		const servers = this.getAllServers();
		this.changeListeners.forEach(l => l(servers));
	}

	/**
	 * 连接（或重连）指定服务器
	 */
	async connectServer(config: McpServerConfig, options?: { force?: boolean }): Promise<McpServerInfo> {
		const forceRetry = options?.force === true;
		const retryState = this.retryStates.get(config.name);
		const now = Date.now();
		if (!forceRetry && retryState && retryState.nextRetryAt > now) {
			const existing = this.servers.get(config.name);
			const waitSeconds = Math.ceil((retryState.nextRetryAt - now) / 1000);
			const cooledDown: McpServerInfo = {
				config,
				tools: existing?.tools || [],
				resources: existing?.resources || [],
				resourceTemplates: existing?.resourceTemplates || [],
				isConnected: false,
				isConnecting: false,
				error: `连接冷却中，请 ${waitSeconds}s 后重试。上次错误: ${retryState.lastError}`,
				sessionId: undefined,
			};
			this.servers.set(config.name, cooledDown);
			this.notifyChange();
			return cooledDown;
		}

		const existing = this.servers.get(config.name);
		const info: McpServerInfo = {
			config,
			tools: existing?.tools || [],
			resources: existing?.resources || [],
			resourceTemplates: existing?.resourceTemplates || [],
			isConnected: false,
			isConnecting: true,
			error: undefined,
			sessionId: undefined,
		};
		this.servers.set(config.name, info);
		this.notifyChange();

		try {
			const client = new McpClient(config);
			this.clients.set(config.name, client);

			// 初始化连接
			await client.initialize();

			// 获取工具列表
			const tools = await client.listTools();

			// 尝试获取资源列表
			const { resources, resourceTemplates } = await client.listResources();

			const connected: McpServerInfo = {
				config,
				tools,
				resources,
				resourceTemplates,
				isConnected: true,
				isConnecting: false,
				error: undefined,
				sessionId: (client as any).sessionId,
			};
			this.servers.set(config.name, connected);
			this.clearRetryState(config.name);
			this.notifyChange();
			return connected;
		} catch (error: any) {
			const errorMessage = error?.message || String(error);
			const retryState = this.markRetryFailure(config.name, errorMessage);
			const retryInSec = Math.ceil((retryState.nextRetryAt - Date.now()) / 1000);
			const failed: McpServerInfo = {
				config,
				tools: [],
				resources: [],
				resourceTemplates: [],
				isConnected: false,
				isConnecting: false,
				error: `${errorMessage}（${retryInSec}s 后自动允许重试）`,
			};
			this.servers.set(config.name, failed);
			this.clients.delete(config.name);
			this.notifyChange();
			return failed;
		}
	}

	/**
	 * 断开指定服务器
	 */
	disconnectServer(name: string): void {
		this.servers.delete(name);
		this.clients.delete(name);
		this.retryStates.delete(name);
		this.notifyChange();
	}

	/**
	 * 更新服务器配置（重新连接）
	 */
	async updateServer(config: McpServerConfig): Promise<McpServerInfo> {
		this.disconnectServer(config.name);
		if (config.enabled) {
			return this.connectServer(config, { force: true });
		}
		// 禁用：只存配置，不连接
		const info: McpServerInfo = {
			config,
			tools: [],
			resources: [],
			resourceTemplates: [],
			isConnected: false,
			isConnecting: false,
			error: '已禁用',
		};
		this.servers.set(config.name, info);
		this.notifyChange();
		return info;
	}

	/**
	 * 调用工具
	 */
	async callTool(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<McpToolCallResponse> {
		const client = this.getConnectedClient(serverName);
		try {
			return await client.callTool(toolName, args);
		} catch (error: any) {
			return {
				content: [{ type: 'text', text: `工具调用失败: ${error?.message || String(error)}` }],
				isError: true,
			};
		}
	}

	/**
	 * 读取资源
	 */
	async readResource(serverName: string, uri: string): Promise<McpResourceReadResponse> {
		const client = this.getConnectedClient(serverName);
		return client.readResource(uri);
	}

	/**
	 * 获取所有已连接服务器的工具（用于系统提示词）
	 */
	getConnectedTools(): Array<{ serverName: string; tool: McpTool }> {
		const result: Array<{ serverName: string; tool: McpTool }> = [];
		for (const [name, info] of this.servers) {
			if (info.isConnected) {
				for (const tool of info.tools) {
					result.push({ serverName: name, tool });
				}
			}
		}
		return result;
	}

	private getConnectedClient(serverName: string): McpClient {
		const client = this.clients.get(serverName);
		if (!client) {
			throw new Error(`MCP 服务器 "${serverName}" 未连接`);
		}
		return client;
	}

	/**
	 * 从存储格式加载配置并批量连接
	 */
	async loadConfigs(configs: McpServerConfig[]): Promise<void> {
		const uniqueEnabledConfigs: McpServerConfig[] = [];
		const seenSignatures = new Set<string>();
		for (const config of configs) {
			if (!config.enabled) {
				continue;
			}
			const signature = JSON.stringify({
				url: config.url || '',
				headers: config.headers || {},
			});
			if (seenSignatures.has(signature)) {
				continue;
			}
			seenSignatures.add(signature);
			uniqueEnabledConfigs.push(config);
		}

		const promises = uniqueEnabledConfigs
			.map(c => this.connectServer(c).catch(err => {
				console.error(`[McpHub] 连接服务器 ${c.name} 失败:`, err);
			}));
		await Promise.all(promises);
	}

	/**
	 * 销毁所有连接
	 */
	dispose(): void {
		this.servers.clear();
		this.clients.clear();
		this.retryStates.clear();
		this.changeListeners = [];
	}

	private markRetryFailure(name: string, errorMessage: string): McpRetryState {
		const previous = this.retryStates.get(name);
		const failureCount = (previous?.failureCount || 0) + 1;
		const delay = Math.min(
			McpHub.RETRY_BASE_DELAY_MS * Math.pow(2, failureCount - 1),
			McpHub.RETRY_MAX_DELAY_MS
		);
		const retryState: McpRetryState = {
			failureCount,
			nextRetryAt: Date.now() + delay,
			lastError: errorMessage,
		};
		this.retryStates.set(name, retryState);
		return retryState;
	}

	private clearRetryState(name: string): void {
		this.retryStates.delete(name);
	}
}
