/*---------------------------------------------------------------------------------------------
 *  Maxian Server — LSP Server Registry
 *
 *  对标 OpenCode `packages/opencode/src/lsp/server.ts` 的核心子集。
 *  删除了 auto-install / archive 解压逻辑，要求用户本地已安装语言服务器（PATH 内）。
 *  不支持的语言返回 undefined，工具会报友好错误。
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LSPServerHandle {
	process:         ChildProcessWithoutNullStreams;
	initialization?: Record<string, any>;
}

export interface LSPServerInfo {
	id:         string;
	extensions: string[];
	/** 判断 root 目录：从 file 向上找 markers（如 package.json），找不到则用 workspace 根 */
	rootMarkers?: string[];
	/** 不兼容的 markers（出现这些则跳过此 server） */
	excludeMarkers?: string[];
	/** spawn：启动 LSP server 进程。找不到可执行文件返回 undefined */
	spawn(root: string): Promise<LSPServerHandle | undefined>;
}

/** 查找可执行文件（类似 `which`） */
function which(cmd: string): string | undefined {
	try {
		const bin = execSync(`command -v ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		return bin || undefined;
	} catch {
		return undefined;
	}
}

/** 向上查找 root marker 文件，返回所在目录；未找到返回 fallback */
function findRoot(file: string, markers: string[], fallback: string): string {
	let dir = path.dirname(file);
	const fallbackAbs = path.resolve(fallback);
	while (dir && dir !== '/' && dir.length >= fallbackAbs.length) {
		for (const m of markers) {
			if (fs.existsSync(path.join(dir, m))) return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return fallback;
}

/** 是否存在排除 marker */
function hasExcluded(file: string, markers: string[], stop: string): boolean {
	let dir = path.dirname(file);
	const stopAbs = path.resolve(stop);
	while (dir && dir !== '/' && dir.length >= stopAbs.length) {
		for (const m of markers) {
			if (fs.existsSync(path.join(dir, m))) return true;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return false;
}

function spawnLsp(cmd: string, args: string[], cwd: string, env?: Record<string, string>): ChildProcessWithoutNullStreams {
	return nodeSpawn(cmd, args, {
		cwd,
		stdio: ['pipe', 'pipe', 'pipe'],
		env:   { ...process.env, ...env },
	});
}

// ── TypeScript / JavaScript ──────────────────────────────────────────────
export const TypescriptServer: LSPServerInfo = {
	id: 'typescript',
	extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
	rootMarkers: ['package.json', 'tsconfig.json', 'jsconfig.json'],
	excludeMarkers: ['deno.json', 'deno.jsonc'],
	async spawn(root) {
		// 优先全局 typescript-language-server，其次 npx
		const bin = which('typescript-language-server');
		if (bin) {
			return { process: spawnLsp(bin, ['--stdio'], root) };
		}
		// 回退 npx（需要联网或已缓存）
		const npx = which('npx');
		if (npx) {
			return { process: spawnLsp(npx, ['-y', 'typescript-language-server', '--stdio'], root) };
		}
		return undefined;
	},
};

// ── Python (pyright) ─────────────────────────────────────────────────────
export const PyrightServer: LSPServerInfo = {
	id: 'pyright',
	extensions: ['.py', '.pyi'],
	rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
	async spawn(root) {
		const bin = which('pyright-langserver');
		if (bin) return { process: spawnLsp(bin, ['--stdio'], root) };
		const npx = which('npx');
		if (npx) return { process: spawnLsp(npx, ['-y', 'pyright-langserver', '--stdio'], root) };
		return undefined;
	},
};

// ── Rust (rust-analyzer) ─────────────────────────────────────────────────
export const RustAnalyzerServer: LSPServerInfo = {
	id: 'rust-analyzer',
	extensions: ['.rs'],
	rootMarkers: ['Cargo.toml'],
	async spawn(root) {
		const bin = which('rust-analyzer');
		if (!bin) return undefined;
		return { process: spawnLsp(bin, [], root) };
	},
};

// ── Go (gopls) ───────────────────────────────────────────────────────────
export const GoplsServer: LSPServerInfo = {
	id: 'gopls',
	extensions: ['.go'],
	rootMarkers: ['go.mod'],
	async spawn(root) {
		const bin = which('gopls');
		if (!bin) return undefined;
		return { process: spawnLsp(bin, [], root) };
	},
};

// ── Java (jdtls / java-language-server) ──────────────────────────────────
export const JavaServer: LSPServerInfo = {
	id: 'jdtls',
	extensions: ['.java'],
	rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
	async spawn(root) {
		const bin = which('jdtls');
		if (!bin) return undefined;
		return { process: spawnLsp(bin, [], root) };
	},
};

// ── Lua (lua-language-server) ───────────────────────────────────────────
export const LuaServer: LSPServerInfo = {
	id: 'lua-language-server',
	extensions: ['.lua'],
	async spawn(root) {
		const bin = which('lua-language-server');
		if (!bin) return undefined;
		return { process: spawnLsp(bin, [], root) };
	},
};

// ── Bash (bash-language-server) ─────────────────────────────────────────
export const BashServer: LSPServerInfo = {
	id: 'bash-language-server',
	extensions: ['.sh', '.bash', '.zsh'],
	async spawn(root) {
		const bin = which('bash-language-server');
		if (bin) return { process: spawnLsp(bin, ['start'], root) };
		const npx = which('npx');
		if (npx) return { process: spawnLsp(npx, ['-y', 'bash-language-server', 'start'], root) };
		return undefined;
	},
};

// ── JSON (vscode-json-languageserver) ───────────────────────────────────
export const JsonServer: LSPServerInfo = {
	id: 'vscode-json-languageserver',
	extensions: ['.json', '.jsonc'],
	async spawn(root) {
		const bin = which('vscode-json-languageserver');
		if (bin) return { process: spawnLsp(bin, ['--stdio'], root) };
		const npx = which('npx');
		if (npx) return { process: spawnLsp(npx, ['-y', 'vscode-json-languageserver', '--stdio'], root) };
		return undefined;
	},
};

// ── C / C++ (clangd) ────────────────────────────────────────────────────
export const ClangdServer: LSPServerInfo = {
	id: 'clangd',
	extensions: ['.c', '.cpp', '.cxx', '.cc', '.c++', '.h', '.hpp'],
	async spawn(root) {
		const bin = which('clangd');
		if (!bin) return undefined;
		return { process: spawnLsp(bin, ['--background-index'], root) };
	},
};

// ── Deno ────────────────────────────────────────────────────────────────
export const DenoServer: LSPServerInfo = {
	id: 'deno',
	extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
	rootMarkers: ['deno.json', 'deno.jsonc'],
	async spawn(root) {
		// 只在有 deno.json 时启用
		if (!fs.existsSync(path.join(root, 'deno.json')) && !fs.existsSync(path.join(root, 'deno.jsonc'))) {
			return undefined;
		}
		const bin = which('deno');
		if (!bin) return undefined;
		return { process: spawnLsp(bin, ['lsp'], root) };
	},
};

export const ALL_SERVERS: LSPServerInfo[] = [
	DenoServer,       // 优先 Deno（有 deno.json 时）
	TypescriptServer,
	PyrightServer,
	RustAnalyzerServer,
	GoplsServer,
	JavaServer,
	LuaServer,
	BashServer,
	JsonServer,
	ClangdServer,
];

/** 根据文件扩展名选择合适的 LSP server。对同一扩展名，按顺序返回第一个可用的 */
export function pickServers(filePath: string): LSPServerInfo[] {
	const ext = path.extname(filePath).toLowerCase();
	return ALL_SERVERS.filter(s => s.extensions.includes(ext));
}

/** 为指定文件计算 root 目录 */
export function computeRoot(server: LSPServerInfo, file: string, workspaceRoot: string): string | undefined {
	if (server.excludeMarkers && hasExcluded(file, server.excludeMarkers, workspaceRoot)) return undefined;
	if (!server.rootMarkers) return workspaceRoot;
	return findRoot(file, server.rootMarkers, workspaceRoot);
}
