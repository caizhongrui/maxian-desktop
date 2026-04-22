/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Batch工具描述 - 以并行只读探索为主，不鼓励在 batch 中执行写操作
 */
export const BATCH_TOOL_DESCRIPTION = `并行执行2-25个工具调用，用于减少独立只读操作的往返次数。

## 使用场景（以只读操作为主）

✅ **推荐使用batch的场景**:
- 读取多个文件（read_file × N）
- 多个搜索操作组合（search_files、glob、list_files、codebase_search）
- 搜索 + 读取组合
- LSP查询（统一使用 lsp，operation=...）

❌ **不能在batch中使用的工具**:
- batch（禁止嵌套）
- ask_followup_question（需要用户输入，并行无意义）
- attempt_completion（任务完成信号）

❌ **不要使用batch的情况**:
- 操作有依赖关系（如：先写入再读取**同一**文件的结果）
- 写操作之间存在耦合，或者你需要逐步验证每次修改的影响
- 不要为了追求并行，把本该串行验证的写操作硬塞进 batch

## 参数格式

\`\`\`json
{
  "tool_calls": [
    {"tool": "read_file", "parameters": {"path": "src/index.ts"}},
    {"tool": "read_file", "parameters": {"path": "src/types.ts"}},
    {"tool": "search_files", "parameters": {"path": "src", "regex": "interface"}}
  ]
}
\`\`\`

## 重要提示

- 最少1个，最多**25**个工具调用
- 所有调用**并行执行**，顺序不保证
- 部分失败不影响其他工具
- **禁止嵌套batch调用**

## 性能优势

- ⚡ 减少多次独立只读操作的请求往返
- 🚀 在多文件探索时明显提升吞吐
`;

/**
 * Batch工具的JSON Schema定义
 */
export const BATCH_TOOL_SCHEMA = {
	name: 'batch',
	description: BATCH_TOOL_DESCRIPTION,
	parameters: {
		type: 'object',
		properties: {
			tool_calls: {
				type: 'array',
				description: '要并行执行的工具调用数组',
				items: {
					type: 'object',
					properties: {
						tool: {
							type: 'string',
							description: '工具名称'
						},
						parameters: {
							type: 'object',
							description: '工具参数'
						}
					},
					required: ['tool', 'parameters']
				},
				minItems: 1,
				maxItems: 25
			}
		},
		required: ['tool_calls']
	}
};
