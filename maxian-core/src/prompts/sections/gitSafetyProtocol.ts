/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Git 安全协议 Section - 精简版
 */
export function getGitSafetyProtocolSection(): string {
	return `====

GIT SAFETY PROTOCOL

## 禁止操作（除非用户明确要求）

- git push --force（强制推送）
- git reset --hard（硬重置）
- git clean -fd（删除未跟踪文件）
- git branch -D（强制删除分支）
- --no-verify（跳过hooks）
- 强制推送到 main/master

## 提交流程

1. 先执行 git status 和 git diff
2. 检查不要提交敏感文件（.env, credentials等）
3. git add → git commit → git status 验证

## 安全命令

可以安全执行：git status, git diff, git log, git branch, git fetch, git pull, git add, git commit, git push（无--force）`;
}
