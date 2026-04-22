/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Bootstrap
 *
 *  完整启动 Maxian server 的便捷函数：
 *   1. 装配平台接口（IFileSystem / ITerminal / IConfiguration 等）
 *   2. 构建 TaskService + ToolExecutor
 *   3. 创建 HTTP server 并监听
 *   4. 连接 SessionManager 事件流到 TaskService
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type {
	IConfiguration,
	IWorkspace,
	IFileSystem,
	ITerminal,
	IStorage,
	IAuthProvider,
	IMessageBus,
	MaxianEvent,
	IBehaviorReporter,
} from '@maxian/core';
import type { IToolExecutor } from '@maxian/core/tools';
import { createServer, type CreatedServer } from './server.js';
import type { SessionManager } from './sessionManager.js';
import type { WorkspaceManager } from './workspaceManager.js';
import { listen } from './adapter/node.js';
import type { Listener, ListenOptions } from './types.js';

export interface BootstrapOptions {
	/** 预加载的 SessionManager（可选，不传则新建空实例） */
	sessionManager?: SessionManager;
	/** 预加载的 WorkspaceManager（可选，不传则新建空实例） */
	workspaceManager?: WorkspaceManager;
	/** 平台抽象实现（由使用方提供） */
	platform: {
		config: IConfiguration;
		workspace: IWorkspace;
		fs: IFileSystem;
		terminal: ITerminal;
		storage: IStorage;
		auth: IAuthProvider;
		messageBus?: IMessageBus;
		behaviorReporter?: IBehaviorReporter;
	};
	/** 工具执行器（由使用方构建，因为这依赖业务上的 IToolContext） */
	toolExecutor: IToolExecutor;
	/** 监听参数 */
	listen: ListenOptions;
	/** 可选的 CORS */
	cors?: string[] | boolean;
}

export interface BootstrapResult {
	server: CreatedServer;
	listener: Listener;
}

/**
 * 启动一个完整的 Maxian HTTP Server。
 *
 * 典型用法：
 * ```ts
 * const { server, listener } = await bootstrap({
 *   platform: { config, workspace, fs, terminal, storage, auth },
 *   toolExecutor: myToolExecutor,
 *   listen: { port: 4096 },
 * });
 * console.log(`Maxian server on ${listener.url}`);
 * ```
 */
export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
	// 1. 生成随机 auth password（如未指定）
	const authPassword = opts.listen.password ?? randomUUID();
	const authUsername = opts.listen.username ?? 'maxian';

	// 2. 建 server（传入预加载的 manager 实例以恢复持久化数据）
	const server = createServer(
		{
			config: opts.platform.config,
			toolExecutor: opts.toolExecutor,
			cors: opts.cors,
			authUsername,
			authPassword,
		},
		opts.sessionManager,
		opts.workspaceManager,
	);

	// 3. 连接 SessionManager 到 MessageBus（若提供）
	if (opts.platform.messageBus) {
		opts.platform.messageBus.onCommand((command) => {
			if (command.type === 'send_message') {
				void server.sessionManager.sendMessage(command.sessionId, {
					content: command.text,
					images: command.images,
				});
			} else if (command.type === 'cancel_task') {
				void server.sessionManager.cancelTask(command.sessionId);
			} else if (command.type === 'approve_tool') {
				void server.sessionManager.approveToolCall(command.sessionId, {
					toolUseId: command.toolUseId,
					approved: command.approved,
					feedback: command.feedback,
				});
			}
		});
	}

	// 4. 启动监听
	const listener = await listen(server.app, {
		port: opts.listen.port,
		hostname: opts.listen.hostname,
	});

	console.log(`[Maxian Server] Listening on ${listener.url}`);
	console.log(`[Maxian Server] Auth username: ${authUsername}`);
	console.log(`[Maxian Server] Auth password: ${authPassword}`);

	return {
		server,
		listener,
	};
}

/**
 * 辅助函数：将 MaxianEvent 转发到 SessionManager。
 * 供 TaskService 的事件回调使用。
 */
export function wireEventsToSessionManager(
	sessionManager: CreatedServer['sessionManager'],
	sessionId: string,
	event: MaxianEvent
): void {
	void sessionManager.emitEvent(sessionId, event);
}
