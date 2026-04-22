/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Project-level Configuration Loader
 *
 *  对标 OpenCode `.opencode/config.jsonc`。读取优先级（从低到高）：
 *   1. 用户级：~/.maxian/config.json
 *   2. 项目级：<workspace>/.maxian/config.json
 *
 *  自定义 agent：<workspace>/.maxian/agents/<name>.md（frontmatter + body）
 *  自定义 command：<workspace>/.maxian/commands/<name>.md（frontmatter + template）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ProjectConfig {
	/** 默认模型的 businessCode 覆盖 */
	defaultBusinessCode?: string;
	/** 权限规则：ask | allow | deny 模式 */
	permissions?: {
		tools?: Record<string, 'ask' | 'allow' | 'deny'>;
		/** 命令模式白名单（正则）*/
		bashPatterns?: {
			allow?: string[];
			deny?:  string[];
		};
	};
	/** AI 调用参数 */
	model?: {
		temperature?: number;
		topP?:        number;
		maxTokens?:   number;
	};
	/** 自定义系统提示附加段落 */
	additionalSystemPrompt?: string;
	/** Plugin 列表（路径） */
	plugins?: string[];
	/** 禁用的内置工具名 */
	disabledTools?: string[];
}

export interface CustomAgent {
	name:          string;
	description:   string;
	systemPrompt:  string;
	/** 允许使用的工具（白名单）。undefined = 全部 */
	tools?:        string[];
	/** 模型覆盖（businessCode）*/
	model?:        string;
	temperature?:  number;
	topP?:         number;
}

export interface CustomCommand {
	name:        string;
	description: string;
	/** 命令模板（支持 $ARGUMENTS / $SELECTION / $FILE 占位符） */
	template:    string;
	/** 触发时用哪个 agent（default / <custom-name>） */
	agent?:      string;
}

function deepMerge<T>(base: T, override: T): T {
	if (typeof base !== 'object' || base === null) return override ?? base;
	if (typeof override !== 'object' || override === null) return base;
	const out: any = Array.isArray(base) ? [...(base as any[])] : { ...(base as any) };
	for (const key of Object.keys(override as any)) {
		const a = (base as any)[key];
		const b = (override as any)[key];
		if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && !Array.isArray(b)) {
			out[key] = deepMerge(a, b);
		} else {
			out[key] = b;
		}
	}
	return out;
}

function readJsonSafe(p: string): any {
	try {
		if (!fs.existsSync(p)) return null;
		const raw = fs.readFileSync(p, 'utf8');
		// 去掉 JSONC 注释（简单处理）
		const stripped = raw
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:"'\/])\/\/.*$/gm, (_m, pre) => pre);
		return JSON.parse(stripped);
	} catch {
		return null;
	}
}

/** 加载项目级 + 用户级合并后的配置 */
export function loadProjectConfig(workspacePath: string): ProjectConfig {
	const userCfg    = readJsonSafe(path.join(os.homedir(), '.maxian', 'config.json'))    ?? {};
	const projectCfg = readJsonSafe(path.join(workspacePath, '.maxian', 'config.json'))    ?? {};
	return deepMerge(userCfg, projectCfg);
}

/** 解析 frontmatter（简易 YAML 子集） + body */
function parseFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
	if (!raw.startsWith('---\n')) return { meta: {}, body: raw };
	const end = raw.indexOf('\n---\n', 4);
	if (end < 0) return { meta: {}, body: raw };
	const fmText = raw.slice(4, end);
	const body = raw.slice(end + 5).trimStart();
	const meta: Record<string, string | string[]> = {};
	for (const line of fmText.split('\n')) {
		const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/);
		if (!m) continue;
		const key = m[1].trim();
		let val: any = m[2].trim();
		// 处理引号
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		// 处理简单 array：[a, b, c]
		if (val.startsWith('[') && val.endsWith(']')) {
			val = val.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
		}
		meta[key] = val;
	}
	return { meta, body };
}

/** 扫描自定义 agent 目录 */
export function loadCustomAgents(workspacePath: string): CustomAgent[] {
	const dirs = [
		path.join(os.homedir(), '.maxian', 'agents'),
		path.join(workspacePath, '.maxian', 'agents'),
	];
	const seen = new Set<string>();
	const agents: CustomAgent[] = [];
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		try {
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith('.md')) continue;
				const abs = path.join(dir, f);
				const raw = fs.readFileSync(abs, 'utf8');
				const { meta, body } = parseFrontmatter(raw);
				const name = (meta.name as string) || f.slice(0, -3);
				if (seen.has(name)) continue;  // 项目级覆盖用户级
				seen.add(name);
				agents.push({
					name,
					description: (meta.description as string) ?? '',
					systemPrompt: body,
					tools:        Array.isArray(meta.tools)       ? meta.tools as string[]       : undefined,
					model:        (meta.model as string)          || undefined,
					temperature:  meta.temperature ? parseFloat(meta.temperature as string) : undefined,
					topP:         meta.topP        ? parseFloat(meta.topP as string)        : undefined,
				});
			}
		} catch { /* ignore */ }
	}
	return agents;
}

/** 扫描自定义 command 目录 */
export function loadCustomCommands(workspacePath: string): CustomCommand[] {
	const dirs = [
		path.join(os.homedir(), '.maxian', 'commands'),
		path.join(workspacePath, '.maxian', 'commands'),
	];
	const seen = new Set<string>();
	const commands: CustomCommand[] = [];
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		try {
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith('.md')) continue;
				const abs = path.join(dir, f);
				const raw = fs.readFileSync(abs, 'utf8');
				const { meta, body } = parseFrontmatter(raw);
				const name = (meta.name as string) || f.slice(0, -3);
				if (seen.has(name)) continue;
				seen.add(name);
				commands.push({
					name,
					description: (meta.description as string) ?? '',
					template:    body,
					agent:       (meta.agent as string) || undefined,
				});
			}
		} catch { /* ignore */ }
	}
	return commands;
}

/** 应用自定义命令模板：替换 $ARGUMENTS / $FILE / $SELECTION */
export function applyCommandTemplate(
	template: string,
	args:     { ARGUMENTS?: string; FILE?: string; SELECTION?: string },
): string {
	let out = template;
	out = out.replace(/\$ARGUMENTS\b/g, args.ARGUMENTS ?? '');
	out = out.replace(/\$FILE\b/g,      args.FILE ?? '');
	out = out.replace(/\$SELECTION\b/g, args.SELECTION ?? '');
	return out;
}
