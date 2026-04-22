/*---------------------------------------------------------------------------------------------
 *  Maxian Core — FileContextTracker
 *
 *  跟踪文件操作（读/写/用户编辑），用于检测上下文过期。
 *  VSCode 相关抽象通过 IFileWatcher 和 IStorageProvider 接口注入。
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs/promises';
import type { IFileWatcher } from '../interfaces/IFileWatcher.js';
import type { IDisposable } from '../interfaces/IMessageBus.js';
import type { IWorkspace } from '../interfaces/IWorkspace.js';
import { safeWriteJson, getTaskDirectoryPath } from '../utils/storage.js';
import { GlobalFileNames } from '../utils/globalFileNames.js';
import { fileExistsAtPath } from '../utils/fsUtils.js';
import type { FileMetadataEntry, RecordSource, TaskMetadata } from './FileContextTrackerTypes.js';

/**
 * 全局存储提供者接口 —— 对应 VSCode ExtensionContext.globalStorageUri。
 * Desktop 端可实现为 `~/.maxian/` 等绝对路径。
 */
export interface IStorageProvider {
	/** 全局存储目录路径（绝对路径） */
	readonly globalStoragePath: string;
}

/**
 * This class is responsible for tracking file operations that may result in stale context.
 * If a user modifies a file outside of Maxian, the context may become stale and need to be updated.
 * We do not want Maxian to reload the context every time a file is modified, so we use this class merely
 * to inform Maxian that the change has occurred, and tell Maxian to reload the file before making
 * any changes to it. This fixes an issue with diff editing, where Maxian was unable to complete a diff edit.
 */
export class FileContextTracker {
	readonly taskId: string;
	private storageProviderRef: WeakRef<IStorageProvider>;
	private fileWatcher?: IFileWatcher;
	private workspace?: IWorkspace;

	// File tracking and watching
	private fileDisposables = new Map<string, IDisposable>();
	private recentlyModifiedFiles = new Set<string>();
	private recentlyEditedByMaxian = new Set<string>();
	private checkpointPossibleFiles = new Set<string>();

	constructor(
		storageProvider: IStorageProvider,
		taskId: string,
		fileWatcher?: IFileWatcher,
		workspace?: IWorkspace
	) {
		this.storageProviderRef = new WeakRef(storageProvider);
		this.taskId = taskId;
		this.fileWatcher = fileWatcher;
		this.workspace = workspace;
	}

	private getCwd(): string | undefined {
		const cwd = this.workspace?.getRootPath() ?? undefined;
		if (!cwd) {
			console.info('No workspace folder available - cannot determine current working directory');
		}
		return cwd ?? undefined;
	}

	/**
	 * File watchers are set up for each file that is tracked in the task metadata.
	 */
	async setupFileWatcher(filePath: string): Promise<void> {
		if (this.fileDisposables.has(filePath)) {
			return;
		}
		if (!this.fileWatcher) {
			return;
		}

		const cwd = this.getCwd();
		if (!cwd) {
			return;
		}

		const absolutePath = path.resolve(cwd, filePath);
		const disposable = this.fileWatcher.watchFile(absolutePath, (event) => {
			if (event.type !== 'changed') {
				return;
			}
			if (this.recentlyEditedByMaxian.has(filePath)) {
				this.recentlyEditedByMaxian.delete(filePath);
			} else {
				this.recentlyModifiedFiles.add(filePath);
				this.trackFileContext(filePath, 'user_edited');
			}
		});

		this.fileDisposables.set(filePath, disposable);
	}

	/**
	 * Tracks a file operation in metadata and sets up a watcher for the file.
	 */
	async trackFileContext(filePath: string, operation: RecordSource): Promise<void> {
		try {
			const cwd = this.getCwd();
			if (!cwd) {
				return;
			}

			await this.addFileToFileContextTracker(this.taskId, filePath, operation);
			await this.setupFileWatcher(filePath);
		} catch (error) {
			console.error('Failed to track file operation:', error);
		}
	}

	private getStorageProvider(): IStorageProvider | undefined {
		const provider = this.storageProviderRef.deref();
		if (!provider) {
			console.error('StorageProvider reference is no longer valid');
			return undefined;
		}
		return provider;
	}

	async getTaskMetadata(taskId: string): Promise<TaskMetadata> {
		const storageProvider = this.getStorageProvider();
		if (!storageProvider) {
			return { files_in_context: [] };
		}

		const taskDir = await getTaskDirectoryPath(storageProvider.globalStoragePath, taskId);
		const filePath = path.join(taskDir, GlobalFileNames.taskMetadata);
		try {
			if (await fileExistsAtPath(filePath)) {
				return JSON.parse(await fs.readFile(filePath, 'utf8'));
			}
		} catch (error) {
			console.error('Failed to read task metadata:', error);
		}
		return { files_in_context: [] };
	}

	async saveTaskMetadata(taskId: string, metadata: TaskMetadata): Promise<void> {
		try {
			const storageProvider = this.getStorageProvider();
			if (!storageProvider) {
				return;
			}

			const taskDir = await getTaskDirectoryPath(storageProvider.globalStoragePath, taskId);
			const filePath = path.join(taskDir, GlobalFileNames.taskMetadata);
			await safeWriteJson(filePath, metadata);
		} catch (error) {
			console.error('Failed to save task metadata:', error);
		}
	}

	async addFileToFileContextTracker(
		taskId: string,
		filePath: string,
		source: RecordSource
	): Promise<void> {
		try {
			const metadata = await this.getTaskMetadata(taskId);
			const now = Date.now();

			metadata.files_in_context.forEach((entry: FileMetadataEntry) => {
				if (entry.path === filePath && entry.record_state === 'active') {
					entry.record_state = 'stale';
				}
			});

			const getLatestDateForField = (filePath2: string, field: keyof FileMetadataEntry): number | null => {
				const relevantEntries = metadata.files_in_context
					.filter((entry: FileMetadataEntry) => entry.path === filePath2 && entry[field])
					.sort((a: FileMetadataEntry, b: FileMetadataEntry) =>
						(b[field] as number) - (a[field] as number)
					);

				return relevantEntries.length > 0 ? (relevantEntries[0][field] as number) : null;
			};

			const newEntry: FileMetadataEntry = {
				path: filePath,
				record_state: 'active',
				record_source: source,
				roo_read_date: getLatestDateForField(filePath, 'roo_read_date'),
				roo_edit_date: getLatestDateForField(filePath, 'roo_edit_date'),
				user_edit_date: getLatestDateForField(filePath, 'user_edit_date'),
			};

			switch (source) {
				case 'user_edited':
					newEntry.user_edit_date = now;
					this.recentlyModifiedFiles.add(filePath);
					break;

				case 'roo_edited':
					newEntry.roo_read_date = now;
					newEntry.roo_edit_date = now;
					this.checkpointPossibleFiles.add(filePath);
					this.markFileAsEditedByMaxian(filePath);
					break;

				case 'read_tool':
				case 'file_mentioned':
					newEntry.roo_read_date = now;
					break;
			}

			metadata.files_in_context.push(newEntry);
			await this.saveTaskMetadata(taskId, metadata);
		} catch (error) {
			console.error('Failed to add file to metadata:', error);
		}
	}

	getAndClearRecentlyModifiedFiles(): string[] {
		const files = Array.from(this.recentlyModifiedFiles);
		this.recentlyModifiedFiles.clear();
		return files;
	}

	getAndClearCheckpointPossibleFile(): string[] {
		const files = Array.from(this.checkpointPossibleFiles);
		this.checkpointPossibleFiles.clear();
		return files;
	}

	markFileAsEditedByMaxian(filePath: string): void {
		this.recentlyEditedByMaxian.add(filePath);
	}

	trackFileRead(filePath: string, source: string = 'read_tool'): Promise<void> | void {
		return this.trackFileContext(filePath, source as RecordSource);
	}

	trackFileWrite(filePath: string, source: string = 'roo_edited'): Promise<void> | void {
		return this.trackFileContext(filePath, source as RecordSource);
	}

	/**
	 * 返回所有被读取过的文件路径列表（实现 IFileContextTracker 接口）。
	 */
	getReadFiles(): string[] {
		return Array.from(this.checkpointPossibleFiles);
	}

	/**
	 * 返回所有被写入过的文件路径列表（实现 IFileContextTracker 接口）。
	 */
	getWrittenFiles(): string[] {
		return Array.from(this.recentlyEditedByMaxian);
	}

	async getRecentFiles(limit: number = 10): Promise<string[]> {
		try {
			const metadata = await this.getTaskMetadata(this.taskId);

			const fileAccessMap = new Map<string, number>();

			metadata.files_in_context.forEach((entry: FileMetadataEntry) => {
				const mostRecentDate = Math.max(
					entry.roo_read_date || 0,
					entry.roo_edit_date || 0,
					entry.user_edit_date || 0
				);

				const existingDate = fileAccessMap.get(entry.path) || 0;
				if (mostRecentDate > existingDate) {
					fileAccessMap.set(entry.path, mostRecentDate);
				}
			});

			return Array.from(fileAccessMap.entries())
				.sort((a, b) => b[1] - a[1])
				.slice(0, limit)
				.map(([filePath]) => filePath);
		} catch (error) {
			console.error('Failed to get recent files:', error);
			return [];
		}
	}

	dispose(): void {
		for (const disposable of this.fileDisposables.values()) {
			disposable.dispose();
		}
		this.fileDisposables.clear();
	}
}
