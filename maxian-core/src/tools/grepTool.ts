/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Grep Tool (ripgrep 封装)
 *
 *  对标 OpenCode `packages/opencode/src/tool/grep.ts`
 *  正则跨文件搜索，比传统 search_files 更快、支持 --glob / --type 过滤。
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { IToolContext } from './IToolContext.js';

export interface IGrepToolParams {
	/** 正则表达式 */
	pattern:       string;
	/** 搜索起始目录（默认 cwd） */
	path?:         string;
	/** glob 文件过滤，例如 "*.ts" 或 "src/**\/*.tsx" */
	include?:      string;
	/** 文件类型（ripgrep --type），例如 "js" "py" "rust" */
	type?:         string;
	/** 大小写不敏感（-i） */
	ignoreCase?:   boolean;
	/** 上下文行数（-C N） */
	context?:      number;
	/** 最多返回行数（默认 500） */
	limit?:        number;
	/** 输出模式：content = 带行号匹配行（默认），files_with_matches = 仅文件名，count = 每个文件的匹配次数 */
	outputMode?:   'content' | 'files_with_matches' | 'count';
}

export interface IGrepToolResult {
	matches:    number;
	output:     string;
	truncated:  boolean;
}

/** 检测 rg 可执行文件路径 */
function findRgPath(): string {
	// 常见位置
	const candidates = [
		'/opt/homebrew/bin/rg',
		'/usr/local/bin/rg',
		'/usr/bin/rg',
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	// 回退到 PATH
	return 'rg';
}

export async function grepTool(
	ctx:    IToolContext,
	params: IGrepToolParams,
): Promise<IGrepToolResult> {
	if (!params.pattern) {
		return { matches: 0, output: 'Error: pattern is required', truncated: false };
	}

	const searchPath = params.path
		? (path.isAbsolute(params.path) ? params.path : path.resolve(ctx.workspacePath, params.path))
		: ctx.workspacePath;

	// 路径越界检查（工作区外需谨慎）
	const abs = path.resolve(searchPath);
	if (!abs.startsWith(path.resolve(ctx.workspacePath)) && !fs.existsSync(abs)) {
		return { matches: 0, output: `Error: path not found: ${params.path}`, truncated: false };
	}

	const rgPath = findRgPath();
	const args: string[] = ['--no-messages', '--hidden', '--field-match-separator=|'];

	// 输出模式
	const mode = params.outputMode ?? 'content';
	if (mode === 'files_with_matches') {
		args.push('-l');
	} else if (mode === 'count') {
		args.push('-c');
	} else {
		args.push('-nH');  // 行号 + 文件名
		if (params.context && params.context > 0) {
			args.push('-C', String(params.context));
		}
	}

	if (params.ignoreCase) args.push('-i');
	if (params.include) args.push('--glob', params.include);
	if (params.type) args.push('--type', params.type);

	args.push('--regexp', params.pattern);
	args.push(abs);

	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		const proc = spawn(rgPath, args, {
			cwd:   ctx.workspacePath,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
		proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
		proc.on('error', (e) => {
			resolve({ matches: 0, output: `Error: ${e.message} (请安装 ripgrep)`, truncated: false });
		});
		proc.on('close', (code) => {
			// rg exit codes: 0 = matches found, 1 = no matches, 2 = error
			if (code === 1 || (code === 2 && !stdout.trim())) {
				resolve({ matches: 0, output: '未找到匹配', truncated: false });
				return;
			}
			if (code !== 0 && code !== 2) {
				resolve({ matches: 0, output: `ripgrep 失败: ${stderr || `exit ${code}`}`, truncated: false });
				return;
			}

			const limit = params.limit ?? 500;
			const lines = stdout.split('\n').filter(Boolean);
			const truncated = lines.length > limit;
			const limited = truncated ? lines.slice(0, limit) : lines;

			resolve({
				matches:   lines.length,
				output:    limited.join('\n') + (truncated ? `\n\n… 仅显示前 ${limit} 条（共 ${lines.length}）` : ''),
				truncated,
			});
		});
	});
}

export function formatGrepResult(r: IGrepToolResult, params: IGrepToolParams): string {
	return `# Grep: ${params.pattern}\n${r.matches} 个匹配\n\n${r.output}`;
}
