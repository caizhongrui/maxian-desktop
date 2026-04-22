/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具选择决策树 Section（Qwen 精简版，决策表直给结论）
 */
export function getToolDecisionTreeSection(): string {
	return `====

TOOL SELECTION

按目标直接选工具，不要犹豫：

| 我想... | 用这个工具 |
|---|---|
| 找"某个字符串/符号/函数名"在哪 | search_files（regex） |
| 找"某个文件名/扩展名" | search_files（file_pattern）或 glob |
| 不知道关键词、只知道功能描述 | codebase_search |
| 看一个已知路径文件 | read_file |
| 浏览一个目录结构 | list_files |
| 改一个位置 | edit |
| 改同一文件多个位置 | multiedit（一次性，禁止拆成多轮 edit） |
| 创建新文件 | write_to_file |
| 删文件/批量创建 | patch |
| 执行命令/测试/构建 | execute_command |
| 看变量类型/跳定义/查引用 | lsp |
| 缺少关键信息必须问用户 | ask_followup_question（必带 2-4 个 options） |
| 任务完成 | attempt_completion |

**硬性规则**：
1. 改文件前**必须**先 read_file 完整读一次
2. 同文件多个改动点 → 一次 multiedit，**不允许连续多次 edit**
3. 多个只读操作（多个 read_file / search_files）可以同轮发起，**上限 3 个**
4. search_files 返回 >10 个候选时，先加过滤条件（path / file_pattern）再搜，不要直接 read_file 全读
5. codebase_search 只在不知道关键词时用；知道关键词优先 search_files
6. 任何写类工具 error 后，**禁止立即用相同参数重试**——先 read_file 确认当前内容`;
}
