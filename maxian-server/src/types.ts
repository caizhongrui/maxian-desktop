/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Shared Types
 *--------------------------------------------------------------------------------------------*/

/** HTTP server 监听配置 */
export interface ListenOptions {
	/** 监听端口（0 = 随机分配） */
	port: number;
	/** 监听地址（默认 127.0.0.1） */
	hostname?: string;
	/** 认证用户名（可选） */
	username?: string;
	/** 认证密码（可选，不设则不认证） */
	password?: string;
	/** 是否允许 CORS */
	cors?: string[] | boolean;
}

/** HTTP server 句柄 */
export interface Listener {
	/** 实际监听的 hostname */
	hostname: string;
	/** 实际监听的端口 */
	port: number;
	/** 完整 URL */
	url: URL;
	/** 底层 Node.js HTTP Server（供附加 WebSocket 使用） */
	httpServer: import('node:http').Server;
	/** 关闭服务器 */
	stop: (closeConnections?: boolean) => Promise<void>;
}

/** 健康检查结果 */
export interface HealthCheckResult {
	ok: boolean;
	version: string;
	uptime: number;
}

/** 会话摘要（供 REST API 使用） */
export interface SessionSummary {
	id: string;
	title: string;
	status: 'running' | 'done' | 'error' | 'idle';
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	workspacePath?: string;
	/** UI 模式：'code' = 代码模式，'chat' = 对话模式 */
	uiMode: 'code' | 'chat';
	/** 归档（软删除） */
	archived?: boolean;
	/** 置顶 */
	pinned?: boolean;
}

/** 工作区信息 */
export interface WorkspaceInfo {
	path: string;
	name: string;
	openedAt: number;
}
