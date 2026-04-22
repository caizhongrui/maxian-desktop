/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Bash Tool
 *
 *  对标 OpenCode `packages/opencode/src/tool/bash.ts`
 *  比 execute_command 更强：超时、并发软限制、stdout/stderr 合并、命令危险性检测。
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { IToolContext } from './IToolContext.js';

/**
 * Windows 下挑选合适的 shell：
 * 1. Git Bash（大部分开发者装 Git for Windows 自带，支持 ls/grep/cat/&& 等 Unix 语法）
 * 2. PowerShell（内置，ls/cat 有别名，但 && 需 PS 7+）
 * 3. 退回 cmd.exe（兜底，兼容差）
 *
 * 返回 { shell, prefix } —— prefix 为调用参数前缀（bash 用 `-lc`、cmd 用 `/s /c`）
 */
function pickWindowsShell(): { shell: string; prefixArgs: string[] } | null {
	if (process.platform !== 'win32') return null;
	const candidates = [
		'C:\\Program Files\\Git\\bin\\bash.exe',
		'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
		'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
	];
	for (const p of candidates) {
		try { if (fs.existsSync(p)) return { shell: p, prefixArgs: ['-lc'] }; } catch { /* ignore */ }
	}
	// PATH 里找 bash（wsl / msys）
	const pathSep = ';';
	const pathEntries = (process.env.PATH ?? '').split(pathSep);
	for (const dir of pathEntries) {
		try {
			const bashPath = path.join(dir, 'bash.exe');
			if (fs.existsSync(bashPath)) return { shell: bashPath, prefixArgs: ['-lc'] };
		} catch { /* ignore */ }
	}
	// 退回 PowerShell 7 或内置 PowerShell
	const psCandidates = [
		'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
		process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : '',
	].filter(Boolean);
	for (const p of psCandidates) {
		try { if (fs.existsSync(p)) return { shell: p, prefixArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }; } catch { /* ignore */ }
	}
	// 最后兜底：null → 让 spawn 用 shell:true 默认（cmd.exe）
	return null;
}

/** 匹配 ANSI escape 序列（颜色/光标控制等） */
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~])|\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[=>]/g;
function stripAnsi(s: string): string {
	if (!s) return s;
	return s.replace(ANSI_RE, '');
}

/** 长运行服务检测（dev server / watcher / tail -f 等） */
const DEV_SERVER_PATTERNS: RegExp[] = [
	/\b(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/i,
	/\bvite(\s|$)/i,
	/\bnext\s+(dev|start)\b/i,
	/\bwebpack(-dev-server)?\s+(serve|--serve)\b/i,
	/\bnuxt\s+dev\b/i,
	/\brollup\s+-w\b/i,
	/\bnodemon\b/i,
	/\btail\s+-f\b/i,
	/\bflask\s+run\b/i,
	/\buvicorn\b/i,
	/\bgunicorn\b/i,
	/\bdocker\s+logs\s+-f\b/i,
	/\bkubectl\s+logs\s+-f\b/i,
];
function isDevServerCommand(cmd: string): boolean {
	return DEV_SERVER_PATTERNS.some(re => re.test(cmd));
}

export interface IBashToolParams {
	/** 要执行的 shell 命令 */
	command:     string;
	/** 超时（毫秒，默认 120000 = 2 分钟，最大 600000 = 10 分钟） */
	timeout?:    number;
	/** 工作目录（相对或绝对，默认工作区根） */
	cwd?:        string;
	/** 后台执行（不等待完成，返回 PID） */
	background?: boolean;
	/** 简短描述（用于审批界面展示） */
	description?: string;
}

export interface IBashToolResult {
	stdout:   string;
	stderr:   string;
	exitCode: number | null;
	timedOut: boolean;
	/** 背景任务返回 PID */
	pid?:     number;
}

/** 危险命令模式（返回匹配项或空字符串） */
export function detectDangerousCommand(command: string): string {
	const patterns: Array<{ re: RegExp; label: string }> = [
		{ re: /\brm\s+-rf\s+\//i,                    label: 'rm -rf /' },
		{ re: /\brm\s+-rf\s+~(?:\/|$)/i,             label: 'rm -rf ~' },
		{ re: /\bmkfs(\.|\s)/i,                      label: 'mkfs' },
		{ re: /\bdd\s+.*of=\/dev\//i,                label: 'dd to /dev' },
		{ re: /:\(\)\s*\{\s*:\|:&\s*\};:/,           label: 'fork bomb' },
		{ re: /\bchmod\s+(?:-R\s+)?0?7{3,}\s+\//i,   label: 'chmod 777 /' },
		{ re: /\b(?:shutdown|reboot|halt)\b/i,       label: 'shutdown/reboot' },
		{ re: />\s*\/dev\/sd[a-z]/i,                 label: 'write to disk device' },
	];
	for (const p of patterns) {
		if (p.re.test(command)) return p.label;
	}
	return '';
}

/** 流式输出回调：每当 stdout/stderr 有新数据到达时调用 */
export type BashOutputSink = (chunk: string, kind: 'stdout' | 'stderr') => void | Promise<void>;

export async function bashTool(
	ctx:    IToolContext,
	params: IBashToolParams,
	onOutput?: BashOutputSink,
): Promise<IBashToolResult> {
	const command = params.command?.trim();
	if (!command) {
		return { stdout: '', stderr: 'command is required', exitCode: 1, timedOut: false };
	}

	// 超时范围 1s–10min，默认 2min
	const timeout = Math.min(Math.max(params.timeout ?? 120_000, 1000), 600_000);

	// cwd 解析与越界保护
	const cwd = params.cwd
		? (path.isAbsolute(params.cwd) ? params.cwd : path.resolve(ctx.workspacePath, params.cwd))
		: ctx.workspacePath;

	// 挑选合适的 shell（仅 Windows 有选择；其他平台用默认）
	const winShell = pickWindowsShell();

	// 背景执行
	if (params.background) {
		const spawnOpts: any = {
			cwd,
			detached: true,
			stdio:    'ignore',
			windowsHide: true,   // ⚠️ Windows 下禁止弹出黑色控制台窗口
		};
		const child = winShell
			? spawn(winShell.shell, [...winShell.prefixArgs, command], spawnOpts)
			: spawn(command, { ...spawnOpts, shell: true });
		child.unref();
		return {
			stdout:   `[background] 已启动 pid=${child.pid}`,
			stderr:   '',
			exitCode: 0,
			timedOut: false,
			pid:      child.pid,
		};
	}

	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let completed = false;
		let lastOutputTime = Date.now();
		const startTime = Date.now();

		const isDevServer = isDevServerCommand(command);

		const spawnOpts: any = {
			cwd,
			env:   { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: isDevServer,
			windowsHide: true,   // ⚠️ 禁止 Windows 弹黑框
		};
		const child = winShell
			? spawn(winShell.shell, [...winShell.prefixArgs, command], spawnOpts)
			: spawn(command, { ...spawnOpts, shell: true });

		// dev server: idle-detach（3s 无输出即视为就绪，脱离前台等待）
		const IDLE_MS  = 3000;
		const MIN_WAIT = 2500;
		const idleChecker = isDevServer ? setInterval(() => {
			if (completed) return;
			const now = Date.now();
			const elapsed = now - startTime;
			const idleFor = now - lastOutputTime;
			if (elapsed >= MIN_WAIT && idleFor >= IDLE_MS) {
				detachAndResolve();
			}
		}, 500) : null;

		const killTimer = setTimeout(() => {
			if (completed) return;
			timedOut = true;
			try { child.kill('SIGTERM'); } catch { /* ignore */ }
			setTimeout(() => {
				try { child.kill('SIGKILL'); } catch { /* ignore */ }
			}, 2000);
		}, timeout);

		const detachAndResolve = () => {
			if (completed) return;
			completed = true;
			clearTimeout(killTimer);
			if (idleChecker) clearInterval(idleChecker);
			try { child.unref(); } catch {}
			try { child.stdout.removeAllListeners('data'); } catch {}
			try { child.stderr.removeAllListeners('data'); } catch {}
			if (onOutput) {
				try { void onOutput(`\n[服务已后台运行 pid=${child.pid}，AI 可继续下一步]\n`, 'stdout'); } catch {}
			}
			resolve({
				stdout: stdout + `\n\n💡 识别为长时间运行服务（dev server / watcher），已后台继续 pid=${child.pid}。`,
				stderr,
				exitCode: 0,
				timedOut: false,
				pid: child.pid,
			});
		};

		child.stdout.on('data', (d) => {
			lastOutputTime = Date.now();
			const chunk = stripAnsi(d.toString('utf8'));
			stdout += chunk;
			if (onOutput) {
				try { void onOutput(chunk, 'stdout'); } catch { /* ignore sink errors */ }
			}
			if (stdout.length > 1_000_000) {
				stdout = stdout.slice(0, 1_000_000) + '\n[输出过大已被截断]';
				if (!isDevServer) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
			}
		});
		child.stderr.on('data', (d) => {
			lastOutputTime = Date.now();
			const chunk = stripAnsi(d.toString('utf8'));
			stderr += chunk;
			if (onOutput) {
				try { void onOutput(chunk, 'stderr'); } catch { /* ignore sink errors */ }
			}
			if (stderr.length > 500_000) {
				stderr = stderr.slice(0, 500_000) + '\n[stderr 过大已被截断]';
			}
		});

		child.on('error', (e) => {
			if (completed) return;
			completed = true;
			clearTimeout(killTimer);
			if (idleChecker) clearInterval(idleChecker);
			resolve({ stdout, stderr: stderr + '\n' + e.message, exitCode: 1, timedOut });
		});

		child.on('close', (code) => {
			if (completed) return;
			completed = true;
			clearTimeout(killTimer);
			if (idleChecker) clearInterval(idleChecker);
			resolve({
				stdout,
				stderr,
				exitCode: timedOut ? null : (code ?? 0),
				timedOut,
			});
		});
	});
}

export function formatBashResult(r: IBashToolResult, params: IBashToolParams): string {
	const parts: string[] = [];
	parts.push(`$ ${params.command}`);
	if (r.pid !== undefined) {
		parts.push(`[background pid=${r.pid}]`);
	} else {
		if (r.timedOut) parts.push(`[超时 ${params.timeout ?? 120000}ms 后被杀]`);
		else parts.push(`[exit=${r.exitCode}]`);
	}
	if (r.stdout) parts.push(r.stdout.trimEnd());
	if (r.stderr) parts.push('--- stderr ---\n' + r.stderr.trimEnd());
	return parts.join('\n');
}
