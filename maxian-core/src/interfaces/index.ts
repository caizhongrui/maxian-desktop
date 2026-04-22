/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Interface Barrel Export
 *
 *  所有平台相关能力的抽象接口统一从这里导出。
 *  Core 内部代码只能 import from '@maxian/core/interfaces'，
 *  严禁直接 import 'vscode' / 'fs' / 'child_process'。
 *--------------------------------------------------------------------------------------------*/

export type {
	IFileSystem,
	FileStat,
	FileEntry,
	DeleteOptions,
	ListFilesOptions,
	FileSystemErrorCode,
} from './IFileSystem.js';
export { FileSystemError } from './IFileSystem.js';

export type {
	ITerminal,
	ExecuteOptions,
	ExecuteResult,
	TerminalChunk,
} from './ITerminal.js';

export type { IWorkspace } from './IWorkspace.js';

export type {
	IMessageBus,
	IDisposable,
	MaxianEvent,
	MaxianCommand,
	AssistantMessageEvent,
	ReasoningEvent,
	ToolCallStartEvent,
	ToolCallArgsStreamingEvent,
	ToolCallResultEvent,
	TodoListUpdateEvent,
	TodoItem,
	TokenUsageEvent,
	TaskStatusEvent,
	ErrorEvent,
	FileChangeEvent,
	FileChangeSummary,
	CompletionEvent,
} from './IMessageBus.js';

export type { IConfiguration } from './IConfiguration.js';

export type { IStorage, StorageScope } from './IStorage.js';

export type { IAuthProvider, AuthCredentials } from './IAuthProvider.js';

export type { ISkillService } from './ISkillService.js';

export type { IBehaviorReporter } from './IBehaviorReporter.js';
export { NoopBehaviorReporter } from './IBehaviorReporter.js';

/**
 * 平台能力容器 — 所有接口的集合。
 * 使用方（IDE / Desktop）把各自的实现打包传给 Core。
 */
export interface MaxianPlatform {
	fs: import('./IFileSystem.js').IFileSystem;
	terminal: import('./ITerminal.js').ITerminal;
	workspace: import('./IWorkspace.js').IWorkspace;
	messageBus: import('./IMessageBus.js').IMessageBus;
	config: import('./IConfiguration.js').IConfiguration;
	storage: import('./IStorage.js').IStorage;
	auth: import('./IAuthProvider.js').IAuthProvider;
}
