/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Public API
 *
 *  此文件是 @maxian/core 包的唯一入口。
 *  消费方（@maxian/ide、@maxian/desktop）通过此文件使用 Core 的所有能力。
 *
 *  由于模块众多且少数类型名重复，此处采用命名空间导出 + 精选扁平导出，
 *  消费方按需使用深路径（如 `import { TaskService } from '@maxian/core/task'`）。
 *--------------------------------------------------------------------------------------------*/

// ─── 平台抽象接口 ────────────────────────────────────────
export * from './interfaces/index.js';
export type { IFileWatcher, FileWatchEvent, FileWatchHandler, WatchOptions } from './interfaces/IFileWatcher.js';

// ─── 共享类型 ────────────────────────────────────────────
export * from './types/index.js';
export { CancellationTokenSource, Emitter } from './types/cancellation.js';
export type { CancellationToken, Event } from './types/cancellation.js';
export { Disposable, DisposableStore, combinedDisposable, EmptyDisposable } from './types/lifecycle.js';

// ─── 纯工具函数 ──────────────────────────────────────────
export * from './utils/index.js';

// ─── Diff ────────────────────────────────────────────────
export * from './diff/fuzzyMatch.js';
export * from './diff/insertGroups.js';
export * from './diff/MultiSearchReplaceDiffStrategy.js';

// ─── 核心版本信息 ────────────────────────────────────────
export const MAXIAN_CORE_VERSION = '0.1.0';

/**
 * 检查核心库是否与消费方版本兼容。
 */
export function isCompatibleVersion(consumerVersion: string): boolean {
	const [coreMajor] = MAXIAN_CORE_VERSION.split('.').map(Number);
	const [consumerMajor] = consumerVersion.split('.').map(Number);
	return coreMajor === consumerMajor;
}

/**
 * 子模块直接入口（按需 import）：
 *
 *   import { TaskService } from '@maxian/core/task'
 *   import { globalToolRegistry } from '@maxian/core/tools'
 *   import { SystemPromptGenerator } from '@maxian/core/prompts'
 *   import { QwenHandler } from '@maxian/core/api'
 *   import { ContextManager } from '@maxian/core/context'
 *   import { McpHub } from '@maxian/core/mcp'
 *   import { AgentOrchestrator } from '@maxian/core/agents'
 *   import { MaxianIgnoreController } from '@maxian/core/ignore'
 *   import { CheckpointManager } from '@maxian/core/checkpoints'
 *
 * 这样避免根 index 层的重名冲突，也更符合 Tree-shaking 友好的使用方式。
 */
