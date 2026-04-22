/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Core HTTP Server (Hono 框架)
 *
 *  借鉴 OpenCode `packages/opencode/src/server/server.ts` 的分层设计：
 *   - Middleware：auth / logger / cors / error
 *   - Routes：health / sessions / workspaces / tools / config
 *   - Adapter：node-server（默认）/ bun（可选）
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import type { IConfiguration } from '@maxian/core';
import type { IToolExecutor } from '@maxian/core/tools';
import {
	AuthMiddleware,
	LoggerMiddleware,
	CorsMiddleware,
	ErrorMiddleware,
} from './middleware/index.js';
import { HealthRoutes } from './routes/health.js';
import { SessionRoutes } from './routes/session.js';
import { WorkspaceRoutes } from './routes/workspace.js';
import { ConfigRoutes } from './routes/config.js';
import { ToolRoutes } from './routes/tool.js';
import { AuthRoutes, type AiRuntimeConfig, type SetAiConfigFn } from './routes/auth.js';
import { SessionManager } from './sessionManager.js';
import { WorkspaceManager } from './workspaceManager.js';

export interface CreateServerOptions {
	/** 配置服务（由调用方提供，如读 ~/.maxian/config.json） */
	config: IConfiguration;
	/** 工具执行器（由 bootstrap 层从 @maxian/core 构建） */
	toolExecutor: IToolExecutor;
	/** CORS 白名单（留空 = 不允许 CORS；true = 允许所有） */
	cors?: string[] | boolean;
	/** 基本认证用户名 */
	authUsername?: string;
	/** 基本认证密码（留空 = 不认证） */
	authPassword?: string;
}

export interface CreatedServer {
	app: Hono;
	sessionManager: SessionManager;
	workspaceManager: WorkspaceManager;
	/** 动态设置运行时 AI 代理配置 */
	setAiConfig: SetAiConfigFn;
	/** 获取当前运行时 AI 代理配置 */
	getAiConfig: () => AiRuntimeConfig | null;
	/** 订阅 AI 配置变化（登录 / 登出触发），返回取消订阅函数 */
	onAiConfigChanged: (listener: (cfg: AiRuntimeConfig | null) => void) => () => void;
}

/**
 * 创建 Maxian HTTP server（不启动监听）。
 * 调用方可以进一步挂载自定义路由、连接 TaskService 等。
 *
 * 注意：此函数接受已从磁盘加载的 manager 实例。
 * 请先调用 WorkspaceManager.load() 和 SessionManager.load()。
 */
export function createServer(
	opts: CreateServerOptions,
	sessionManager?: SessionManager,
	workspaceManager?: WorkspaceManager,
): CreatedServer {
	const serverStartTime = Date.now();
	const sm = sessionManager ?? new SessionManager();
	const wm = workspaceManager ?? new WorkspaceManager();

	// 运行时 AI 配置（可通过 /auth/configure 动态更新）
	let aiRuntimeConfig: AiRuntimeConfig | null = null;
	const aiConfigListeners = new Set<(cfg: AiRuntimeConfig | null) => void>();
	const setAiConfig: SetAiConfigFn = (cfg) => {
		aiRuntimeConfig = cfg;
		for (const listener of aiConfigListeners) {
			try { listener(cfg); } catch (e) { console.warn('[Server] AI 配置监听器异常:', e); }
		}
	};
	const getAiConfig = () => aiRuntimeConfig;
	const onAiConfigChanged = (listener: (cfg: AiRuntimeConfig | null) => void) => {
		aiConfigListeners.add(listener);
		return () => { aiConfigListeners.delete(listener); };
	};

	const app = new Hono();

	// Global error handler
	app.onError(ErrorMiddleware);

	// Global middleware
	app.use('*', LoggerMiddleware);
	app.use('*', CorsMiddleware(opts.cors));
	app.use('*', AuthMiddleware(opts.authUsername, opts.authPassword));

	// Routes
	app.route('/', HealthRoutes(serverStartTime));
	app.route('/', SessionRoutes(sm));
	app.route('/', WorkspaceRoutes(wm));
	app.route('/', ToolRoutes(opts.toolExecutor));
	app.route('/', ConfigRoutes(opts.config));
	app.route('/', AuthRoutes(setAiConfig, getAiConfig));

	return { app, sessionManager: sm, workspaceManager: wm, setAiConfig, getAiConfig, onAiConfigChanged };
}
