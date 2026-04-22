/*---------------------------------------------------------------------------------------------
 *  Maxian Core — MaxianIgnoreController
 *
 *  Controls LLM access to files by enforcing ignore patterns from .maxianignore.
 *  抽象文件监听通过 IFileWatcher 接口注入（IDE/Desktop 各自实现）。
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import ignore, { type Ignore } from 'ignore';
import type { IFileWatcher } from '../interfaces/IFileWatcher.js';
import type { IDisposable } from '../interfaces/IMessageBus.js';
import { fileExistsAtPath } from '../utils/fsUtils.js';

export const LOCK_TEXT_SYMBOL = '\u{1F512}';

/**
 * Controls LLM access to files by enforcing ignore patterns.
 * Designed to be instantiated once in Task and passed to file manipulation services.
 * Uses the 'ignore' library to support standard .gitignore syntax in .maxianignore files.
 */
export class MaxianIgnoreController {
	private cwd: string;
	private ignoreInstance: Ignore;
	private disposables: IDisposable[] = [];
	private fileWatcher?: IFileWatcher;
	maxianIgnoreContent: string | undefined;

	constructor(cwd: string, fileWatcher?: IFileWatcher) {
		this.cwd = cwd;
		this.fileWatcher = fileWatcher;
		this.ignoreInstance = ignore();
		this.maxianIgnoreContent = undefined;
		if (this.fileWatcher) {
			this.setupFileWatcher(this.fileWatcher);
		}
	}

	async initialize(): Promise<void> {
		await this.loadMaxianIgnore();
	}

	private setupFileWatcher(watcher: IFileWatcher): void {
		const ignorePath = path.join(this.cwd, '.maxianignore');
		const disposable = watcher.watchFile(ignorePath, () => {
			this.loadMaxianIgnore();
		});
		this.disposables.push(disposable);
	}

	private async loadMaxianIgnore(): Promise<void> {
		try {
			this.ignoreInstance = ignore();
			const ignorePath = path.join(this.cwd, '.maxianignore');
			if (await fileExistsAtPath(ignorePath)) {
				const content = await fs.readFile(ignorePath, 'utf8');
				this.maxianIgnoreContent = content;
				this.ignoreInstance.add(content);
				this.ignoreInstance.add('.maxianignore');
			} else {
				this.maxianIgnoreContent = undefined;
			}
		} catch (error) {
			console.error('Unexpected error loading .maxianignore:', error);
		}
	}

	validateAccess(filePath: string): boolean {
		if (!this.maxianIgnoreContent) {
			return true;
		}
		try {
			const absolutePath = path.resolve(this.cwd, filePath);

			let realPath: string;
			try {
				realPath = fsSync.realpathSync(absolutePath);
			} catch {
				realPath = absolutePath;
			}

			const relativePath = path.relative(this.cwd, realPath).replace(/\\/g, '/');
			return !this.ignoreInstance.ignores(relativePath);
		} catch {
			return true;
		}
	}

	validateCommand(command: string): string | undefined {
		if (!this.maxianIgnoreContent) {
			return undefined;
		}

		const parts = command.trim().split(/\s+/);
		const baseCommand = parts[0].toLowerCase();

		const fileReadingCommands = [
			'cat', 'less', 'more', 'head', 'tail', 'grep', 'awk', 'sed',
			'get-content', 'gc', 'type', 'select-string', 'sls',
		];

		if (fileReadingCommands.includes(baseCommand)) {
			for (let i = 1; i < parts.length; i++) {
				const arg = parts[i];
				if (arg.startsWith('-') || arg.startsWith('/')) {
					continue;
				}
				if (arg.includes(':')) {
					continue;
				}
				if (!this.validateAccess(arg)) {
					return arg;
				}
			}
		}

		return undefined;
	}

	filterPaths(paths: string[]): string[] {
		try {
			return paths
				.map((p) => ({
					path: p,
					allowed: this.validateAccess(p),
				}))
				.filter((x) => x.allowed)
				.map((x) => x.path);
		} catch (error) {
			console.error('Error filtering paths:', error);
			return [];
		}
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
	}

	getInstructions(): string | undefined {
		if (!this.maxianIgnoreContent) {
			return undefined;
		}

		return `# .maxianignore\n\n(The following is provided by a root-level .maxianignore file where the user has specified files and directories that should not be accessed. When using list_files, you'll notice a ${LOCK_TEXT_SYMBOL} next to files that are blocked. Attempting to access the file's contents e.g. through read_file will result in an error.)\n\n${this.maxianIgnoreContent}\n.maxianignore`;
	}
}
