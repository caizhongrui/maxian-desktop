/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Tool Context
 *
 *  工具执行时需要的最小上下文接口。
 *  消费方（IDE / Desktop）在调用工具时提供此上下文的实现。
 *--------------------------------------------------------------------------------------------*/

/** 记录来源（与 context-tracking/FileContextTrackerTypes 中的 RecordSource 保持一致） */
export type TrackReason = 'read_tool' | 'user_edited' | 'roo_edited' | 'file_mentioned';

/**
 * 文件上下文追踪器 —— 记录哪些文件被读写过。
 * 最小接口，仅包含工具层实际调用的两个方法，方便 IDE 的 VSCode 实现直接满足。
 * IDE 用 VSCode 内部实现；Desktop 可实现为内存 Set。
 */
export interface IFileContextTracker {
	/** 记录一次文件读取 */
	trackFileRead(path: string, reason?: TrackReason): void | Promise<void>;
	/** 记录一次文件写入 */
	trackFileWrite(path: string, reason?: TrackReason): void | Promise<void>;
}

/**
 * 工具执行上下文 —— 工具访问宿主环境的统一入口。
 *
 * 这取代了原 IDE 里对 `Task` 类的直接依赖，使工具能在 IDE 和 Desktop
 * 两种宿主环境下都能运行。
 */
export interface IToolContext {
	/** 当前工作区根目录绝对路径 */
	readonly workspacePath: string;

	/** 文件上下文追踪器 */
	readonly fileContextTracker: IFileContextTracker;

	/** 标记本任务是否已对文件产生写入（用于 taskService 状态追踪） */
	didEditFile: boolean;

	/** 当前会话 ID（可选，用于日志/追踪） */
	readonly sessionId?: string;

	/** 当前任务 ID（可选） */
	readonly taskId?: string;
}

/**
 * 简单的内存版 IFileContextTracker 实现，供 Desktop / 测试环境使用。
 */
export class MemoryFileContextTracker implements IFileContextTracker {
	private readFiles = new Set<string>();
	private writtenFiles = new Set<string>();

	trackFileRead(path: string, _reason?: TrackReason): void {
		this.readFiles.add(path);
	}

	trackFileWrite(path: string, _reason?: TrackReason): void {
		this.writtenFiles.add(path);
	}

	/** 获取读过的文件列表 */
	getReadFiles(): string[] {
		return Array.from(this.readFiles);
	}

	/** 获取写过的文件列表 */
	getWrittenFiles(): string[] {
		return Array.from(this.writtenFiles);
	}

	reset(): void {
		this.readFiles.clear();
		this.writtenFiles.clear();
	}
}
