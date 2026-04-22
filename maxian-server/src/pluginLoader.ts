/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Plugin Loader
 *
 *  对标 OpenCode `packages/opencode/src/plugin/loader.ts` 的精简版本。
 *  扫描 ~/.maxian/plugins/ 目录下的 .js / .mjs 文件，动态 import，
 *  读取默认导出的 `tools` 数组合并到 AGENT_TOOL_DEFINITIONS。
 *
 *  插件模块格式：
 *    export default {
 *      name: 'my-plugin',
 *      version: '1.0.0',
 *      tools: [
 *        {
 *          name: 'my_custom_tool',
 *          description: '...',
 *          parameters: { type: 'object', ... },
 *          async execute(params, ctx) { return 'result'; },
 *        }
 *      ],
 *    };
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import type { ToolDefinition } from '@maxian/core/api';

export interface PluginToolDef extends ToolDefinition {
	/** 插件工具的执行函数 */
	execute: (params: Record<string, unknown>, ctx: any) => Promise<string | unknown>;
}

/** 插件 hooks 生命周期签名 */
export interface PluginHooks {
	/** 工具执行前触发，可返回 false 取消调用 */
	'tool.execute.before'?: (ctx: { toolName: string; params: Record<string, unknown>; sessionId?: string }) => boolean | void | Promise<boolean | void>;
	/** 工具执行后触发（无论成功失败） */
	'tool.execute.after'?:  (ctx: { toolName: string; params: Record<string, unknown>; result: string; success: boolean; sessionId?: string }) => void | Promise<void>;
	/** 会话创建 */
	'session.created'?:     (ctx: { sessionId: string }) => void | Promise<void>;
	/** 新消息发送 */
	'message.sent'?:        (ctx: { sessionId: string; content: string }) => void | Promise<void>;
	/** Agent 轮次结束 */
	'agent.iteration'?:     (ctx: { sessionId: string; iter: number; toolCalls: number }) => void | Promise<void>;
}

export interface LoadedPlugin {
	name:     string;
	version:  string;
	path:     string;
	tools:    PluginToolDef[];
	hooks?:   PluginHooks;
	error?:   string;
}

const PLUGIN_DIRS = [
	path.join(os.homedir(), '.maxian', 'plugins'),
];

/** 从所有插件目录加载插件 */
export async function loadAllPlugins(): Promise<LoadedPlugin[]> {
	const results: LoadedPlugin[] = [];
	for (const dir of PLUGIN_DIRS) {
		if (!fs.existsSync(dir)) continue;
		let entries: string[];
		try { entries = fs.readdirSync(dir); } catch { continue; }

		for (const entry of entries) {
			const full = path.join(dir, entry);
			try {
				const stat = fs.statSync(full);
				if (stat.isDirectory()) {
					// 目录插件：读取 package.json 的 main
					const pkgPath = path.join(full, 'package.json');
					if (!fs.existsSync(pkgPath)) continue;
					const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
					const entryFile = pkg.main ?? 'index.js';
					const entryPath = path.join(full, entryFile);
					if (!fs.existsSync(entryPath)) continue;
					results.push(await loadPluginFile(entryPath, pkg.name ?? entry, pkg.version ?? '0.0.0'));
				} else if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.cjs')) {
					const name = path.basename(entry, path.extname(entry));
					results.push(await loadPluginFile(full, name, '0.0.0'));
				}
			} catch (e) {
				results.push({
					name:    entry,
					version: '0.0.0',
					path:    full,
					tools:   [],
					error:   (e as Error).message,
				});
			}
		}
	}
	return results;
}

async function loadPluginFile(filePath: string, name: string, version: string): Promise<LoadedPlugin> {
	try {
		const url = pathToFileURL(filePath).href;
		const mod = await import(url);
		const exported = mod.default ?? mod;
		const tools: PluginToolDef[] = Array.isArray(exported?.tools) ? exported.tools : [];

		const validTools = tools.filter((t: any) => {
			if (typeof t?.name !== 'string' || !t.name) return false;
			if (typeof t?.description !== 'string') return false;
			if (typeof t?.execute !== 'function') return false;
			return true;
		});

		// 校验 hooks：只接受指定事件名
		const allowedHookNames = new Set([
			'tool.execute.before', 'tool.execute.after',
			'session.created', 'message.sent', 'agent.iteration',
		]);
		const hooks: PluginHooks = {};
		if (exported?.hooks && typeof exported.hooks === 'object') {
			for (const [k, v] of Object.entries(exported.hooks)) {
				if (allowedHookNames.has(k) && typeof v === 'function') {
					(hooks as any)[k] = v;
				}
			}
		}

		return {
			name:    exported?.name ?? name,
			version: exported?.version ?? version,
			path:    filePath,
			tools:   validTools,
			hooks:   Object.keys(hooks).length > 0 ? hooks : undefined,
		};
	} catch (e) {
		return {
			name, version, path: filePath, tools: [],
			error: (e as Error).message,
		};
	}
}

/** 中心化触发：调度所有已加载插件对应的 hook */
export async function triggerPluginHook<K extends keyof PluginHooks>(
	plugins: LoadedPlugin[],
	event:   K,
	ctx:     any,
): Promise<boolean> {
	let allowed = true;
	for (const p of plugins) {
		const fn = p.hooks?.[event];
		if (!fn) continue;
		try {
			const r = await (fn as any)(ctx);
			if (event === 'tool.execute.before' && r === false) allowed = false;
		} catch (e) {
			console.warn(`[Plugin] hook ${event} in ${p.name} failed:`, (e as Error).message);
		}
	}
	return allowed;
}
