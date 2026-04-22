/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LSP统一工具接口
 * 将5个独立的LSP工具合并为1个，参考OpenCode的设计
 */

/**
 * LSP操作类型
 */
export type LspOperation =
	| 'diagnostics'      // 获取诊断信息（错误、警告）
	| 'hover'            // 获取类型信息和文档
	| 'definition'       // 跳转到定义
	| 'references'       // 查找所有引用
	| 'typeDefinition'   // 查看类型定义
	| 'documentSymbol'   // 获取文件结构（新增）
	| 'workspaceSymbol'; // 全局符号搜索（新增）

/**
 * LSP工具参数
 */
export interface ILspToolParams {
	/** LSP操作类型 */
	operation: LspOperation;

	/** 文件路径（所有操作都需要，除了workspaceSymbol） */
	filePath?: string;

	/** 行号（1-based，hover/definition/references/typeDefinition需要） */
	line?: number;

	/** 列号（1-based，hover/definition/references/typeDefinition需要） */
	column?: number;

	/** 搜索查询（workspaceSymbol需要） */
	query?: string;
}

/**
 * LSP工具描述
 */
export const LSP_UNIFIED_TOOL_DESCRIPTION = `与LSP服务器交互，获取代码智能分析功能。

## 支持的操作

### 1. diagnostics - 获取诊断信息
获取文件的错误、警告和提示信息。
参数: filePath

### 2. hover - 查看类型信息
获取符号的类型信息、文档和签名。
参数: filePath, line, column

### 3. definition - 跳转到定义
查找符号的定义位置。
参数: filePath, line, column

### 4. references - 查找引用
查找符号的所有引用位置。
参数: filePath, line, column

### 5. typeDefinition - 查看类型定义
查找变量/参数的类型定义。
参数: filePath, line, column

### 6. documentSymbol - 文件结构 (新)
获取文件的所有符号（类、函数、变量等）。
参数: filePath

### 7. workspaceSymbol - 全局符号搜索 (新)
在整个工作区搜索符号。
参数: query

## 使用示例

\`\`\`json
// 获取类型信息
{
  "operation": "hover",
  "filePath": "src/index.ts",
  "line": 10,
  "column": 15
}

// 查找引用
{
  "operation": "references",
  "filePath": "src/types.ts",
  "line": 5,
  "column": 20
}

// 全局符号搜索
{
  "operation": "workspaceSymbol",
  "query": "UserService"
}
\`\`\`

## 注意事项

- line和column都是1-based（与编辑器显示一致）
- LSP服务器必须已配置且支持该文件类型
- 某些操作可能返回空结果（如未找到定义）
`;

/**
 * LSP操作的参数要求
 */
export const LSP_OPERATION_PARAMS: Record<LspOperation, {
	requiresFile: boolean;
	requiresPosition: boolean;
	requiresQuery: boolean;
}> = {
	diagnostics: {
		requiresFile: true,
		requiresPosition: false,
		requiresQuery: false
	},
	hover: {
		requiresFile: true,
		requiresPosition: true,
		requiresQuery: false
	},
	definition: {
		requiresFile: true,
		requiresPosition: true,
		requiresQuery: false
	},
	references: {
		requiresFile: true,
		requiresPosition: true,
		requiresQuery: false
	},
	typeDefinition: {
		requiresFile: true,
		requiresPosition: true,
		requiresQuery: false
	},
	documentSymbol: {
		requiresFile: true,
		requiresPosition: false,
		requiresQuery: false
	},
	workspaceSymbol: {
		requiresFile: false,
		requiresPosition: false,
		requiresQuery: true
	}
};

/**
 * 验证LSP工具参数
 */
export function validateLspParams(params: ILspToolParams): { valid: boolean; error?: string } {
	const requirements = LSP_OPERATION_PARAMS[params.operation];

	if (requirements.requiresFile && !params.filePath) {
		return { valid: false, error: `Operation '${params.operation}' requires filePath` };
	}

	if (requirements.requiresPosition) {
		if (params.line === undefined || params.column === undefined) {
			return { valid: false, error: `Operation '${params.operation}' requires line and column` };
		}
		if (params.line < 1 || params.column < 1) {
			return { valid: false, error: 'line and column must be >= 1' };
		}
	}

	if (requirements.requiresQuery && !params.query) {
		return { valid: false, error: `Operation '${params.operation}' requires query` };
	}

	return { valid: true };
}
