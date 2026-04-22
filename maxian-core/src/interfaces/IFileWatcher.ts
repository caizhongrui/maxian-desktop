/*---------------------------------------------------------------------------------------------
 *  Maxian Core — File Watcher Abstraction
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from './IMessageBus.js';

/**
 * 文件变更事件。
 */
export interface FileWatchEvent {
	/** 事件类型 */
	type: 'created' | 'changed' | 'deleted';
	/** 事件路径（绝对路径） */
	path: string;
}

/**
 * 文件监听回调。
 */
export type FileWatchHandler = (event: FileWatchEvent) => void;

/**
 * 文件监听服务抽象接口。
 *
 * 实现方：
 * - IDE：基于 VSCode workspace.createFileSystemWatcher
 * - Desktop：基于 chokidar 或 fs.watch
 */
export interface IFileWatcher {
	/**
	 * 监听单个文件。
	 * @returns 可销毁对象，dispose 时停止监听
	 */
	watchFile(path: string, handler: FileWatchHandler): IDisposable;

	/**
	 * 监听目录下的所有文件（递归可选）。
	 * @param pattern Glob 模式（如 '**\/*.ts'）
	 * @param options.recursive 是否递归
	 * @param options.ignoreInitial 是否忽略初始文件列表
	 */
	watchGlob(
		root: string,
		pattern: string,
		handler: FileWatchHandler,
		options?: WatchOptions
	): IDisposable;
}

export interface WatchOptions {
	recursive?: boolean;
	ignoreInitial?: boolean;
	excludePatterns?: string[];
}
