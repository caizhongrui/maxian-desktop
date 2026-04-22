/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Markdown格式化规则
 */
export function getMarkdownFormattingSection(): string {
	return `====

MARKDOWN RULES

所有响应中的代码引用和文件名都必须格式化为可点击链接，格式：[\`filename OR language.declaration()\`](relative/file/path.ext:line)

规则：
- 代码结构（函数、类等）必须包含行号
- 文件名引用行号可选
- 这适用于所有Markdown响应，包括 <attempt_completion> 中的内容

示例：
- [\`getUserInfo()\`](src/user.ts:42) - 函数引用（带行号）
- [\`UserService\`](src/services/UserService.ts:15) - 类引用
- [package.json](package.json) - 文件引用（无行号）`;
}
