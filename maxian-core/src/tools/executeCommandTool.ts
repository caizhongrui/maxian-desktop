/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Execute Command Tool - 增强版
 *
 * 性能优化（借鉴 Cline CommandOrchestrator）：
 * - 输出缓冲与分块（避免大输出内存问题）
 * - 流式输出收集（实时反馈）
 * - 后台任务支持
 * - 智能输出截断（保留首尾关键信息）
 * - 超时控制与进程管理
 * - 常见命令优化（npm、yarn、git 等）
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

import type { IToolContext } from './IToolContext.js';
import type { ToolResponse } from '../types/toolTypes.js';

/**
 * Windows 下挑选合适的 shell（Git Bash → PowerShell → null 让 spawn 用 cmd 兜底）
 * 目的：AI 生成的 Unix 命令（ls/grep/cat/&& 链式）在 cmd.exe 下会"不识别"。
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
	const pathEntries = (process.env.PATH ?? '').split(';');
	for (const dir of pathEntries) {
		try {
			const bashPath = path.join(dir, 'bash.exe');
			if (fs.existsSync(bashPath)) return { shell: bashPath, prefixArgs: ['-lc'] };
		} catch { /* ignore */ }
	}
	const psCandidates = [
		'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
		process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : '',
	].filter(Boolean);
	for (const p of psCandidates) {
		try { if (fs.existsSync(p)) return { shell: p, prefixArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }; } catch { /* ignore */ }
	}
	return null;
}

// ========== ANSI 色码剥除 ==========
/** 匹配 ANSI escape 序列（颜色/光标控制等） */
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~])|\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[=>]/g;
function stripAnsi(s: string): string {
	if (!s) return s;
	return s.replace(ANSI_RE, '');
}

// ========== 长时间进程检测（dev server / watcher / tail -f …）==========
const DEV_SERVER_PATTERNS: RegExp[] = [
	/\b(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/i,
	/\bvite(\s|$)/i,
	/\bnext\s+(dev|start)\b/i,
	/\bwebpack(-dev-server)?\s+(serve|--serve)\b/i,
	/\bnuxt\s+dev\b/i,
	/\brollup\s+-w\b/i,
	/\bnodemon\b/i,
	/\btail\s+-f\b/i,
	/\bpython[0-9]*\s+.*\b(runserver|manage\.py\s+runserver)\b/i,
	/\bflask\s+run\b/i,
	/\buvicorn\b/i,
	/\bgunicorn\b/i,
	/\bdocker\s+logs\s+-f\b/i,
	/\bkubectl\s+logs\s+-f\b/i,
];
function isDevServerCommand(cmd: string): boolean {
	return DEV_SERVER_PATTERNS.some(re => re.test(cmd));
}

// ========== 配置常量 ==========
const EXECUTE_CONFIG = {
	/** 默认超时（60秒） */
	DEFAULT_TIMEOUT: 60000,

	/** 最大超时（10分钟） */
	MAX_TIMEOUT: 600000,

	/** 最大输出长度（字符） */
	MAX_OUTPUT_LENGTH: 50000,

	/** 最大输出行数 */
	MAX_OUTPUT_LINES: 2000,

	/** 输出截断时保留的首尾行数 */
	SUMMARY_LINES_TO_KEEP: 100,

	/** 输出缓冲刷新间隔（毫秒） */
	BUFFER_FLUSH_INTERVAL: 300,

	/** 大输出阈值（超过此值写入临时文件） */
	LARGE_OUTPUT_THRESHOLD: 100000,

	/** 危险命令模式 */
	DANGEROUS_COMMANDS: [
		/rm\s+-rf\s+[\/~]/i,
		/rm\s+-rf\s+\*/i,
		/mkfs/i,
		/dd\s+if=/i,
		/:(){ :|:& };:/,
		/>\s*\/dev\/sd/i,
		/chmod\s+-R\s+777\s+\//i,
	],

	/** 长时间运行命令模式（需要更长超时） */
	LONG_RUNNING_COMMANDS: [
		/npm\s+(install|i|ci)/i,
		/yarn(\s+install)?$/i,
		/pnpm\s+install/i,
		/pip\s+install/i,
		/cargo\s+build/i,
		/mvn\s+(clean\s+)?install/i,
		/gradle\s+build/i,
		/make(\s+|$)/i,
		/docker\s+build/i,
	],
};

// ========== 后台任务管理 ==========
interface BackgroundTask {
	process: ChildProcess;
	command: string;
	startTime: number;
	output: string[];
	exitCode: number | null;
	completed: boolean;
}

const backgroundTasks = new Map<string, BackgroundTask>();

/**
 * 生成任务 ID
 */
function generateTaskId(): string {
	return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 获取后台任务状态
 */
export function getBackgroundTaskStatus(taskId: string): BackgroundTask | undefined {
	return backgroundTasks.get(taskId);
}

/**
 * 列出所有后台任务
 */
export function listBackgroundTasks(): { id: string; command: string; running: boolean; duration: number }[] {
	return Array.from(backgroundTasks.entries()).map(([id, task]) => ({
		id,
		command: task.command,
		running: !task.completed,
		duration: Date.now() - task.startTime,
	}));
}

/**
 * 终止后台任务（Windows 下使用 taskkill）
 */
export function killBackgroundTask(taskId: string): boolean {
	const task = backgroundTasks.get(taskId);
	if (task && !task.completed) {
		if (IS_WINDOWS && task.process.pid) {
			const { exec } = require('child_process');
			exec(`taskkill /PID ${task.process.pid} /T /F`, () => { });
		} else {
			task.process.kill('SIGTERM');
			setTimeout(() => {
				if (!task.completed) {
					task.process.kill('SIGKILL');
				}
			}, 5000);
		}
		return true;
	}
	return false;
}

// ========== 输出处理 ==========

/**
 * 输出缓冲器
 */
class OutputBuffer {
	private lines: string[] = [];
	private totalBytes = 0;
	private truncated = false;

	constructor(
		private maxLines: number,
		private maxBytes: number
	) { }

	append(data: string): void {
		if (this.truncated) return;

		const newLines = data.split('\n');
		for (const line of newLines) {
			if (this.lines.length >= this.maxLines || this.totalBytes >= this.maxBytes) {
				this.truncated = true;
				return;
			}

			this.lines.push(line);
			this.totalBytes += line.length + 1;
		}
	}

	getOutput(): { content: string; truncated: boolean; lineCount: number } {
		return {
			content: this.lines.join('\n'),
			truncated: this.truncated,
			lineCount: this.lines.length,
		};
	}

	getTruncatedOutput(keepLines: number): string {
		if (this.lines.length <= keepLines * 2) {
			return this.lines.join('\n');
		}

		const head = this.lines.slice(0, keepLines);
		const tail = this.lines.slice(-keepLines);
		const skipped = this.lines.length - keepLines * 2;

		return [
			...head,
			'',
			`... (${skipped} lines omitted) ...`,
			'',
			...tail,
		].join('\n');
	}
}

// ========== 命令分析 ==========

/**
 * 检查是否为危险命令
 */
function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
	for (const pattern of EXECUTE_CONFIG.DANGEROUS_COMMANDS) {
		if (pattern.test(command)) {
			return {
				dangerous: true,
				reason: `命令匹配危险模式: ${pattern.toString()}`,
			};
		}
	}
	return { dangerous: false };
}

/**
 * 检查是否为长时间运行命令
 */
function isLongRunningCommand(command: string): boolean {
	return EXECUTE_CONFIG.LONG_RUNNING_COMMANDS.some(pattern => pattern.test(command));
}

/**
 * 解析命令获取程序名
 */
function getCommandProgram(command: string): string {
	// 处理环境变量前缀
	const cleanCmd = command.replace(/^[A-Z_]+=\S+\s+/g, '');
	// 获取第一个单词
	const match = cleanCmd.match(/^\s*(\S+)/);
	return match ? match[1] : '';
}

/**
 * 检测当前是否为 Windows 系统
 */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Windows 下常见的命令不存在错误（中英文系统均覆盖）
 */
const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
	// 英文系统
	'is not recognized as an internal or external command',
	'is not recognized as the name of a cmdlet',
	'command not found',
	'The term',
	'cannot be loaded because running scripts is disabled',
	// 中文系统
	'不是内部或外部命令',
	'无法识别',
	'不是命令、opcode 或脚本',
	'找不到',
];

/**
 * Windows 下常见的权限/访问拒绝错误
 */
const WINDOWS_PERMISSION_DENIED_PATTERNS = [
	'Access is denied',
	'access denied',
	'拒绝访问',
	'不允许',
	'permission denied',
];

/**
 * Windows 下常见的文件/目录不存在错误
 */
const WINDOWS_FILE_NOT_FOUND_PATTERNS = [
	'The system cannot find',
	'系统找不到',
	'找不到指定的路径',
	'找不到指定的文件',
	'ENOENT',
];

/**
 * 检测输出中是否包含 Windows 错误关键词（即使 exit code 为 0）
 * 某些 Windows 命令失败时仍返回 exit code 0，需要通过输出检测
 */
function detectWindowsErrorInOutput(stdout: string, stderr: string): { hasError: boolean; errorType: string } {
	if (!IS_WINDOWS) return { hasError: false, errorType: '' };

	const combined = (stderr + '\n' + stdout).toLowerCase();

	// Unix 命令在 Windows 上被误用（最常见场景）
	const unixCommandsOnWindows = [
		{ pattern: "'ls' is not recognized", msg: 'unix-command' },
		{ pattern: "'cat' is not recognized", msg: 'unix-command' },
		{ pattern: "'rm' is not recognized", msg: 'unix-command' },
		{ pattern: "'grep' is not recognized", msg: 'unix-command' },
		{ pattern: "'find' is not recognized", msg: 'unix-command' },
		{ pattern: "'touch' is not recognized", msg: 'unix-command' },
		{ pattern: "'chmod' is not recognized", msg: 'unix-command' },
		{ pattern: "'mv' is not recognized", msg: 'unix-command' },
		{ pattern: "'cp' is not recognized", msg: 'unix-command' },
		{ pattern: "'which' is not recognized", msg: 'unix-command' },
		{ pattern: "'clear' is not recognized", msg: 'unix-command' },
		// 中文系统
		{ pattern: "'ls' 不是内部或外部命令", msg: 'unix-command' },
		{ pattern: "'cat' 不是内部或外部命令", msg: 'unix-command' },
		{ pattern: "'rm' 不是内部或外部命令", msg: 'unix-command' },
		{ pattern: "'grep' 不是内部或外部命令", msg: 'unix-command' },
	];

	for (const { pattern, msg } of unixCommandsOnWindows) {
		if (combined.includes(pattern.toLowerCase())) {
			return { hasError: true, errorType: msg };
		}
	}

	for (const pattern of WINDOWS_COMMAND_NOT_FOUND_PATTERNS) {
		if (combined.includes(pattern.toLowerCase())) {
			return { hasError: true, errorType: 'command-not-found' };
		}
	}

	for (const pattern of WINDOWS_PERMISSION_DENIED_PATTERNS) {
		if (combined.includes(pattern.toLowerCase())) {
			return { hasError: true, errorType: 'permission-denied' };
		}
	}

	for (const pattern of WINDOWS_FILE_NOT_FOUND_PATTERNS) {
		if (combined.includes(pattern.toLowerCase())) {
			return { hasError: true, errorType: 'file-not-found' };
		}
	}

	return { hasError: false, errorType: '' };
}

/**
 * 获取命令建议
 */
function getCommandSuggestions(command: string, error: string, stdout: string = ''): string[] {
	const suggestions: string[] = [];
	const program = getCommandProgram(command);
	const combined = error + '\n' + stdout;

	// Windows：Unix 命令被误用
	if (IS_WINDOWS) {
		const unixToWindowsMap: Record<string, string> = {
			'ls': 'dir 或 Get-ChildItem（PowerShell）',
			'cat': 'type（CMD）或 Get-Content（PowerShell）',
			'rm': 'del（文件）或 rmdir /s /q（目录）',
			'grep': 'findstr（CMD）或 Select-String（PowerShell）',
			'find': 'dir /s /b（CMD）或 Get-ChildItem -Recurse（PowerShell）',
			'touch': 'type nul > file.txt（CMD）或 New-Item（PowerShell）',
			'mv': 'move（CMD）或 Move-Item（PowerShell）',
			'cp': 'copy（CMD）或 Copy-Item（PowerShell）',
			'chmod': 'Windows 不支持 chmod，可使用 icacls',
			'which': 'where（CMD）或 Get-Command（PowerShell）',
			'clear': 'cls（CMD）或 Clear-Host（PowerShell）',
			'export': 'set VAR=value（CMD）或 $env:VAR="value"（PowerShell）',
			'echo': '语法正确，但变量引用用 %VAR%（CMD）或 $env:VAR（PowerShell）',
		};

		if (unixToWindowsMap[program]) {
			suggestions.push(`Windows 不支持 "${program}" 命令，请改用: ${unixToWindowsMap[program]}`);
		}

		// 检测常见 Windows 错误文本
		if (
			WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some(p => combined.toLowerCase().includes(p.toLowerCase())) ||
			combined.includes('not recognized')
		) {
			if (!unixToWindowsMap[program]) {
				suggestions.push(`请确保 "${program}" 已安装并在系统 PATH 中`);
				suggestions.push('在 PowerShell 中运行 where <命令名> 检查是否可用');
			}
		}

		if (WINDOWS_PERMISSION_DENIED_PATTERNS.some(p => combined.toLowerCase().includes(p.toLowerCase()))) {
			suggestions.push('请以管理员权限运行（右键 → 以管理员身份运行）');
		}

		if (WINDOWS_FILE_NOT_FOUND_PATTERNS.some(p => combined.toLowerCase().includes(p.toLowerCase()))) {
			suggestions.push('请检查文件路径是否正确，注意 Windows 路径使用反斜杠 \\');
		}
	} else {
		// Unix/macOS 错误处理
		if (combined.includes('command not found') || combined.includes('not recognized')) {
			if (program === 'node' || program === 'npm') {
				suggestions.push('请确保已安装 Node.js');
			} else if (program === 'python' || program === 'python3') {
				suggestions.push('请确保已安装 Python');
			} else if (program === 'git') {
				suggestions.push('请确保已安装 Git');
			} else {
				suggestions.push(`请确保 ${program} 已安装并在 PATH 中`);
			}
		}

		if (combined.includes('permission denied')) {
			suggestions.push('尝试添加执行权限: chmod +x <file>');
			if (!command.startsWith('sudo')) {
				suggestions.push('或使用 sudo 提升权限');
			}
		}
	}

	if (combined.includes('ENOENT')) {
		suggestions.push('请检查文件或目录路径是否正确');
	}

	if (combined.includes('ETIMEDOUT') || combined.includes('timeout')) {
		suggestions.push('命令执行超时，尝试增加超时时间或检查网络连接');
	}

	return suggestions;
}

// ========== 主函数 ==========

/** 流式输出回调：stdout/stderr 到达时实时调用（用于前端展示） */
export type CommandOutputSink = (chunk: string, kind: 'stdout' | 'stderr') => void | Promise<void>;

export async function executeCommandTool(
	ctx: IToolContext,
	params: any,
	onOutput?: CommandOutputSink,
): Promise<ToolResponse> {
	const command = params.command;
	const customCwd = params.cwd;
	const background = params.background === 'true' || params.background === true;

	if (!command) {
		return 'Error: No command provided';
	}

	// 检查危险命令
	const dangerCheck = isDangerousCommand(command);
	if (dangerCheck.dangerous) {
		return `⚠️ 危险命令被阻止\n\n命令: ${command}\n原因: ${dangerCheck.reason}\n\n如果确实需要执行此命令，请手动在终端中运行。`;
	}

	try {
		// 确定工作目录
		let workingDir: string;
		if (!customCwd) {
			workingDir = ctx.workspacePath;
		} else if (path.isAbsolute(customCwd)) {
			workingDir = customCwd;
		} else {
			workingDir = path.resolve(ctx.workspacePath, customCwd);
		}

		// 检查目录是否存在
		if (!fs.existsSync(workingDir)) {
			return `Error: Working directory does not exist: ${workingDir}`;
		}

		// 确定超时时间
		const timeout = isLongRunningCommand(command)
			? EXECUTE_CONFIG.MAX_TIMEOUT
			: EXECUTE_CONFIG.DEFAULT_TIMEOUT;

		console.log(`[ExecuteCommand] 执行命令: ${command}`);
		console.log(`[ExecuteCommand] 工作目录: ${workingDir}`);
		console.log(`[ExecuteCommand] 超时时间: ${timeout}ms`);
		console.log(`[ExecuteCommand] 后台模式: ${background}`);

		// 后台任务模式
		if (background) {
			return await executeBackgroundCommand(command, workingDir);
		}

		// 前台任务模式
		return await executeForegroundCommand(command, workingDir, timeout, ctx, onOutput);

	} catch (error: any) {
		const errorMessage = error.message || String(error);
		const suggestions = getCommandSuggestions(command, errorMessage, '');

		const output = [
			`❌ 命令执行失败`,
			'',
			`命令: ${command}`,
			`错误: ${errorMessage}`,
		];

		if (suggestions.length > 0) {
			output.push('');
			output.push('💡 建议:');
			suggestions.forEach(s => output.push(`  - ${s}`));
		}

		return output.join('\n');
	}
}

/**
 * 执行前台命令
 */
async function executeForegroundCommand(
	command: string,
	workingDir: string,
	timeout: number,
	ctx: IToolContext,
	onOutput?: CommandOutputSink,
): Promise<ToolResponse> {
	return new Promise((resolve) => {
		const startTime = Date.now();
		const stdoutBuffer = new OutputBuffer(
			EXECUTE_CONFIG.MAX_OUTPUT_LINES,
			EXECUTE_CONFIG.MAX_OUTPUT_LENGTH
		);
		const stderrBuffer = new OutputBuffer(
			EXECUTE_CONFIG.MAX_OUTPUT_LINES / 2,
			EXECUTE_CONFIG.MAX_OUTPUT_LENGTH / 2
		);

		// dev server / watcher 检测 → 更激进的 idle-detach 策略
		const isDevServer = isDevServerCommand(command);

		// Windows: 优先走 Git Bash / PowerShell，避免 cmd.exe 不识别 Unix 命令
		const winShell = pickWindowsShell();

		const spawnOpts: any = {
			cwd: workingDir,
			env: {
				...process.env,
				FORCE_COLOR: '0',
				NO_COLOR: '1',
				TERM: 'dumb',
				CI: 'true',
			},
			// Windows 下绝不 detached，参考 OpenCode 的 cross-spawn-spawner 行为
			detached: process.platform !== 'win32' && isDevServer,
			windowsHide: true,
		};
		const childProcess = winShell
			? spawn(winShell.shell, [...winShell.prefixArgs, command], spawnOpts)
			: spawn(command, { ...spawnOpts, shell: true });

		let completed = false;
		let lastOutputTime = Date.now();

		// ── idle-detach：仅对 dev server / watcher / tail -f 类命令启用 ──
		// 思路（参考 OpenCode 但更友好）：OpenCode 无脑靠硬超时杀死，dev server 会被误杀；
		// 我们只对识别到的长服务类命令启用"空闲即脱离"，普通命令仍走硬超时（不会误伤 curl 等）。
		// dev server：首次输出后 3s 无新输出就 detach（让 AI 尽快拿回控制权）
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

		// 超时处理（硬超时仍然 kill）
		const timeoutId = setTimeout(() => {
			if (!completed) {
				if (IS_WINDOWS && childProcess.pid) {
					const { exec } = require('child_process');
					exec(`taskkill /PID ${childProcess.pid} /T /F`, () => { });
				} else {
					childProcess.kill('SIGTERM');
					setTimeout(() => { if (!completed) childProcess.kill('SIGKILL'); }, 5000);
				}
			}
		}, timeout);

		const detachAndResolve = () => {
			if (completed) return;
			completed = true;
			clearTimeout(timeoutId);
			if (idleChecker) clearInterval(idleChecker);
			// 不 kill，让进程继续运行；解除父进程对子的引用
			try { childProcess.unref(); } catch { /* ignore */ }
			// 移除 stdio 监听，避免后续输出再触发回调
			try { childProcess.stdout?.removeAllListeners('data'); } catch {}
			try { childProcess.stderr?.removeAllListeners('data'); } catch {}
			const elapsed = Date.now() - startTime;
			const stdout = stdoutBuffer.getOutput();
			const stderr = stderrBuffer.getOutput();
			const pid = childProcess.pid;
			if (onOutput) {
				try { void onOutput(`\n[服务已后台运行 pid=${pid}，AI 可继续下一步]\n`, 'stdout'); } catch { /* ignore */ }
			}
			const base = formatCommandResult(
				command, workingDir,
				0, stdout, stderr, elapsed, timeout,
			);
			const note = `\n\n💡 此命令被识别为长时间运行的服务（dev server / watcher / tail -f 等），已在后台继续运行（pid=${pid}）。上方输出为前 ${Math.round(elapsed/1000)}s 捕获到的内容，服务仍在运行，不会被自动终止。`;
			resolve(base + note);
		};

		// 收集 stdout（剥 ANSI 色码 + 实时推送）
		childProcess.stdout?.on('data', (data: Buffer) => {
			lastOutputTime = Date.now();
			const s = stripAnsi(data.toString('utf8'));
			stdoutBuffer.append(s);
			if (onOutput) {
				try { void onOutput(s, 'stdout'); } catch { /* ignore */ }
			}
		});

		// 收集 stderr
		childProcess.stderr?.on('data', (data: Buffer) => {
			lastOutputTime = Date.now();
			const s = stripAnsi(data.toString('utf8'));
			stderrBuffer.append(s);
			if (onOutput) {
				try { void onOutput(s, 'stderr'); } catch { /* ignore */ }
			}
		});

		// 进程正常结束
		childProcess.on('close', (code) => {
			if (completed) return;
			completed = true;
			clearTimeout(timeoutId);
			if (idleChecker) clearInterval(idleChecker);

			const elapsed = Date.now() - startTime;
			const stdout = stdoutBuffer.getOutput();
			const stderr = stderrBuffer.getOutput();

			ctx.didEditFile = true;

			resolve(formatCommandResult(
				command,
				workingDir,
				code ?? -1,
				stdout,
				stderr,
				elapsed,
				timeout
			));
		});

		// 进程错误
		childProcess.on('error', (error) => {
			if (completed) return;
			completed = true;
			clearTimeout(timeoutId);
			if (idleChecker) clearInterval(idleChecker);

			const elapsed = Date.now() - startTime;

			resolve([
				`❌ 命令启动失败`,
				'',
				`命令: ${command}`,
				`工作目录: ${workingDir}`,
				`错误: ${error.message}`,
				`耗时: ${formatDuration(elapsed)}`,
			].join('\n'));
		});
	});
}

/**
 * 执行后台命令
 */
async function executeBackgroundCommand(
	command: string,
	workingDir: string
): Promise<ToolResponse> {
	const taskId = generateTaskId();

	const winShell = pickWindowsShell();
	const spawnOpts: any = {
		cwd: workingDir,
		// Windows 下后台任务用 child.unref() 脱离，不用 detached（会引起孤儿进程）
		detached: process.platform !== 'win32',
		env: { ...process.env, FORCE_COLOR: '0' },
		windowsHide: true,
	};
	const childProcess = winShell
		? spawn(winShell.shell, [...winShell.prefixArgs, command], spawnOpts)
		: spawn(command, { ...spawnOpts, shell: true });

	const task: BackgroundTask = {
		process: childProcess,
		command,
		startTime: Date.now(),
		output: [],
		exitCode: null,
		completed: false,
	};

	backgroundTasks.set(taskId, task);

	// 收集输出
	childProcess.stdout?.on('data', (data: Buffer) => {
		task.output.push(data.toString());
		// 限制输出大小
		if (task.output.length > EXECUTE_CONFIG.MAX_OUTPUT_LINES) {
			task.output.shift();
		}
	});

	childProcess.stderr?.on('data', (data: Buffer) => {
		task.output.push(`[stderr] ${data.toString()}`);
	});

	childProcess.on('close', (code) => {
		task.exitCode = code;
		task.completed = true;
	});

	childProcess.on('error', (error) => {
		task.output.push(`[error] ${error.message}`);
		task.completed = true;
	});

	// 分离进程
	childProcess.unref();

	return [
		`🚀 后台任务已启动`,
		'',
		`任务 ID: ${taskId}`,
		`命令: ${command}`,
		`工作目录: ${workingDir}`,
		'',
		'💡 使用以下方式管理任务:',
		`  - 查看状态: 调用 execute_command 工具，参数 command="task_status ${taskId}"`,
		`  - 终止任务: 调用 execute_command 工具，参数 command="task_kill ${taskId}"`,
	].join('\n');
}

/**
 * 格式化命令结果
 */
function formatCommandResult(
	command: string,
	workingDir: string,
	exitCode: number,
	stdout: { content: string; truncated: boolean; lineCount: number },
	stderr: { content: string; truncated: boolean; lineCount: number },
	elapsed: number,
	timeout: number
): string {
	// Windows 下即使 exit code 为 0，也可能通过输出内容检测到错误
	const windowsOutputError = detectWindowsErrorInOutput(stdout.content, stderr.content);
	const isSuccess = exitCode === 0 && !windowsOutputError.hasError;
	const isTimeout = elapsed >= timeout - 1000; // 接近超时

	let failReason = '';
	if (exitCode !== 0) {
		failReason = ` (退出码: ${exitCode})`;
	} else if (windowsOutputError.hasError) {
		failReason = ` (Windows 指令错误，退出码为 0 但输出含错误信息)`;
	}

	const header = [
		isSuccess ? `✅ 命令执行成功` : `❌ 命令执行失败${failReason}`,
		'',
		`命令: ${command}`,
		`工作目录: ${workingDir}`,
		`耗时: ${formatDuration(elapsed)}${isTimeout ? ' (接近超时)' : ''}`,
	];

	const output: string[] = [...header];

	// 输出头尾截断：超过 30KB 时保留头 10KB + 尾 10KB（字节级）
	const BYTE_LIMIT = 30 * 1024;
	const BYTE_HEAD = 10 * 1024;
	const BYTE_TAIL = 10 * 1024;

	// 添加 stdout
	if (stdout.content.trim()) {
		const stdoutBytes = Buffer.byteLength(stdout.content, 'utf8');
		const needsByteTruncate = stdoutBytes > BYTE_LIMIT;
		const truncatedLabel = (stdout.truncated || needsByteTruncate) ? ' (已截断)' : '';
		output.push('');
		output.push(`📤 输出${truncatedLabel} (${stdout.lineCount} 行):`);
		output.push('```');

		let content = stdout.content;
		if (stdout.truncated) {
			// 行级截断优先（保留行级智能裁剪）
			content = truncateOutput(content, EXECUTE_CONFIG.SUMMARY_LINES_TO_KEEP);
		}
		if (Buffer.byteLength(content, 'utf8') > BYTE_LIMIT) {
			content = truncateByBytes(content, BYTE_LIMIT, BYTE_HEAD, BYTE_TAIL);
		}
		output.push(content);

		output.push('```');
	}

	// 添加 stderr
	if (stderr.content.trim()) {
		const stderrBytes = Buffer.byteLength(stderr.content, 'utf8');
		const needsByteTruncate = stderrBytes > BYTE_LIMIT;
		const truncatedLabel = (stderr.truncated || needsByteTruncate) ? ' (已截断)' : '';
		output.push('');
		output.push(`⚠️ 错误输出${truncatedLabel} (${stderr.lineCount} 行):`);
		output.push('```');

		let content = stderr.content;
		if (stderr.truncated) {
			content = truncateOutput(content, EXECUTE_CONFIG.SUMMARY_LINES_TO_KEEP / 2);
		}
		if (Buffer.byteLength(content, 'utf8') > BYTE_LIMIT) {
			content = truncateByBytes(content, BYTE_LIMIT, BYTE_HEAD, BYTE_TAIL);
		}
		output.push(content);

		output.push('```');
	}

	// 如果失败，添加建议
	if (!isSuccess) {
		const suggestions = getCommandSuggestions(command, stderr.content, stdout.content);
		if (suggestions.length > 0) {
			output.push('');
			output.push('💡 建议:');
			suggestions.forEach(s => output.push(`  - ${s}`));
		}

		// Windows 下如果 exit code 为 0 但检测到错误，额外提示
		if (windowsOutputError.hasError && exitCode === 0) {
			output.push('');
			output.push('⚠️ 注意: 此命令返回了退出码 0，但输出中包含错误信息，任务实际上未成功执行。');
			if (windowsOutputError.errorType === 'unix-command') {
				output.push('   → 当前系统为 Windows，请使用对应的 Windows/PowerShell 命令替代。');
			}
		}
	}

	return output.join('\n');
}

/**
 * 按字节数做头尾截断：超过 limit 时保留头 headBytes + 尾 tailBytes，
 * 中间折叠为 "... [N lines / M bytes omitted] ..."
 */
function truncateByBytes(content: string, limit: number, headBytes: number, tailBytes: number): string {
	const totalBytes = Buffer.byteLength(content, 'utf8');
	if (totalBytes <= limit) {
		return content;
	}

	// 按字节切（避免 UTF-8 截断异常，使用 Buffer + 回退到字符边界）
	const buf = Buffer.from(content, 'utf8');
	// 从头往后找 headBytes 附近的换行，确保不截断多字节字符
	let headEnd = Math.min(headBytes, buf.length);
	// 向前回退，直到遇到完整字符边界
	while (headEnd > 0 && (buf[headEnd] & 0xC0) === 0x80) {
		headEnd--;
	}
	let tailStart = Math.max(buf.length - tailBytes, headEnd);
	while (tailStart < buf.length && (buf[tailStart] & 0xC0) === 0x80) {
		tailStart++;
	}

	const head = buf.slice(0, headEnd).toString('utf8');
	const tail = buf.slice(tailStart).toString('utf8');

	const omittedBytes = totalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
	const omittedLines = content.split('\n').length - head.split('\n').length - tail.split('\n').length;

	return `${head}\n... [${omittedLines} lines / ${omittedBytes} bytes omitted] ...\n${tail}`;
}

/**
 * 智能截断输出（保留首尾）
 */
function truncateOutput(content: string, keepLines: number): string {
	const lines = content.split('\n');

	if (lines.length <= keepLines * 2) {
		return content;
	}

	const head = lines.slice(0, keepLines);
	const tail = lines.slice(-keepLines);
	const skipped = lines.length - keepLines * 2;

	return [
		...head,
		'',
		`... (${skipped} 行已省略) ...`,
		'',
		...tail,
	].join('\n');
}

/**
 * 格式化时长
 */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.round((ms % 60000) / 1000);
	return `${minutes}m ${seconds}s`;
}
