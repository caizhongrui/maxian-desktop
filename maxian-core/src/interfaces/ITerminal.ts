/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Terminal / Command Execution Abstraction
 *--------------------------------------------------------------------------------------------*/

/**
 * 命令执行抽象接口。
 *
 * 实现方：
 * - IDE：基于 VSCode ITerminalService（Solo 模式有专用终端面板）
 * - Desktop：基于 node-pty + xterm.js 渲染
 */
export interface ITerminal {
	/**
	 * 执行命令并返回结果（短命令场景）。
	 * 适用于：git status、npm install、ls 等执行后结束的命令。
	 *
	 * @param command 完整命令（含参数）
	 * @param options 执行选项
	 * @returns 命令执行结果
	 */
	execute(command: string, options?: ExecuteOptions): Promise<ExecuteResult>;

	/**
	 * 以流式方式执行命令（长命令场景）。
	 * 适用于：dev server、watch 模式等长时间运行的命令。
	 *
	 * @returns AsyncIterable，每次 yield 一段输出；命令结束后自动关闭
	 */
	executeStream(command: string, options?: ExecuteOptions): AsyncIterable<TerminalChunk>;

	/**
	 * 中断正在执行的命令（通过 PID 或 token）。
	 */
	cancel(token: string): Promise<void>;
}

export interface ExecuteOptions {
	/** 工作目录（默认为工作区根） */
	cwd?: string;
	/** 环境变量（会合并到系统环境变量） */
	env?: Record<string, string>;
	/** 超时毫秒数（默认 120000，0 表示不超时） */
	timeoutMs?: number;
	/** 最大输出字节数（默认 50000，超出截断） */
	maxOutputBytes?: number;
	/** 最大输出行数（默认 2000） */
	maxOutputLines?: number;
	/** 用于取消的 token（返回后用 cancel 中断） */
	cancellationToken?: string;
	/** 是否在已存在的终端中执行（IDE 专用，Desktop 可忽略） */
	reuseTerminal?: boolean;
	/** 是否检测 dev server 启动（检测到 ready/listening 等关键字后视为成功） */
	detectDevServer?: boolean;
}

export interface ExecuteResult {
	/** 命令退出码（null 表示被中断 / 超时 / dev-server 提前返回） */
	exitCode: number | null;
	/** 标准输出（已按 maxOutputBytes/Lines 截断） */
	stdout: string;
	/** 标准错误 */
	stderr: string;
	/** 是否因超时被中断 */
	timedOut: boolean;
	/** 是否被用户主动取消 */
	cancelled: boolean;
	/** 是否被判定为 dev server 启动成功（detectDevServer=true 时有意义） */
	devServerStarted: boolean;
	/** 执行耗时（毫秒） */
	durationMs: number;
}

/** 流式输出的单次 chunk */
export interface TerminalChunk {
	type: 'stdout' | 'stderr' | 'exit';
	/** stdout/stderr 的文本内容 */
	data?: string;
	/** exit 事件的退出码 */
	exitCode?: number | null;
	/** 是否被取消/超时 */
	cancelled?: boolean;
	timedOut?: boolean;
}
