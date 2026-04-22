/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Tools Barrel Export
 *
 *  冲突说明：
 *  - BATCH_TOOL_DESCRIPTION 在 batchTool.ts 和 batchToolDescription.ts 都有定义
 *    仅暴露 batchToolDescription 版
 *  - ToolGroup 在 toolRegistry.ts 与 toolTypes.ts 有不同定义（前者更偏向工具注册表，
 *    后者偏向提示词分组）。toolRegistry 版不在此导出，需要时从具体模块引用。
 *--------------------------------------------------------------------------------------------*/

// 上下文接口（由消费方实现）
export type { IToolContext, IFileContextTracker } from './IToolContext.js';
export { MemoryFileContextTracker } from './IToolContext.js';

// 调度器接口
export type { IToolExecutor, ToolExecutionContext, ToolExecutionResult } from './toolExecutor.js';

// 工具调用协议
export * from './toolExecutionProtocol.js';

// 工具执行器装饰器
export * from './filteredToolExecutor.js';

// 工具注册表（精选导出，ToolGroup 未导出避免与 toolTypes 冲突）
export {
	ToolRegistry,
	globalToolRegistry,
	registerBuiltinTools,
	adaptMcpTool,
	registerMcpServerTools,
	unregisterMcpServerTools,
} from './toolRegistry.js';
export type {
	ToolDefinition,
	ToolInputSchema,
	ToolParameterSchema,
	ToolSource,
	ToolExecuteFunction,
	ToolRegistryEvent,
	ToolRegistryListener,
} from './toolRegistry.js';

// 基础工具描述（长版）
export * from './toolDescriptions.js';

// Batch 描述（唯一版本源）
export { BATCH_TOOL_DESCRIPTION, BATCH_TOOL_SCHEMA } from './batchToolDescription.js';

// TODO 工具
export * from './todoStore.js';
export * from './todoWriteTool.js';

// 结果缓存
export * from './ToolResultCache.js';

// 循环检测
export * from './ToolRepetitionDetector.js';

// 各工具实现
export * from './readFileTool.js';
export * from './writeToFileTool.js';
export * from './editTool.js';
export * from './multieditTool.js';
export * from './searchFilesTool.js';
export * from './listFilesTool.js';
export * from './executeCommandTool.js';

// batchTool 仅暴露类型（描述走 batchToolDescription）
export type { IBatchToolParams, IBatchToolResult, IBatchToolExecutor } from './batchTool.js';

export * from './skillTool.js';
export * from './prReviewTool.js';
export * from './generateTestsTool.js';
export * from './webfetchTool.js';

// 新增工具（对标 OpenCode）
export * from './truncate.js';
export * from './grepTool.js';
export * from './bashTool.js';
export * from './globTool.js';
export * from './lsTool.js';
export * from './applyPatchTool.js';
export * from './lspTool.js';
export * from './questionTool.js';
export * from './planExitTool.js';
export * from './taskTool.js';
