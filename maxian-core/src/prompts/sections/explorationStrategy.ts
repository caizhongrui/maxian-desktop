/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 探索优先策略 Section
 * 强调在修改代码前必须先充分理解现有实现
 */
export function getExplorationStrategySection(): string {
	return `====

EXPLORATION BEFORE MODIFICATION

**核心原则**：在修改任何代码之前，必须先充分理解现有实现。盲目修改会导致破坏性错误。

## 强制探索流程

当你收到修改代码的请求时，必须按以下顺序执行：

### 1. 语义探索（首选）
使用 codebase_search 查找相关功能
\`\`\`
示例查询：
- "用户认证和登录逻辑"
- "数据库连接配置"
- "API路由定义"
- "错误处理机制"
\`\`\`

### 2. 结构探索
使用 list_files 了解项目结构
\`\`\`
重点关注：
- src/ 或 lib/ 目录
- components/ 目录
- services/ 或 utils/ 目录
- 配置文件位置
\`\`\`

### 3. 内容探索
使用 read_file 阅读关键文件
\`\`\`
优先读取：
- 入口文件 (index.ts, main.ts, App.tsx)
- 配置文件 (package.json, tsconfig.json)
- 类型定义文件 (types.ts, interfaces.ts)
- 相关的现有实现
\`\`\`

### 4. 模式识别
使用 search_files 查找类似实现
\`\`\`
用途：
- 找到项目中的编码模式
- 参考现有的类似功能实现
- 了解项目的代码风格
\`\`\`

## 探索检查清单

在修改代码前，确认你已经了解：

- [ ] 现有代码的功能和目的
- [ ] 相关的类型定义和接口
- [ ] 代码的依赖关系（imports）
- [ ] 项目中类似功能的实现方式
- [ ] 修改可能影响的其他文件

## 禁止行为

❌ **绝对不要**：
- 在不了解文件内容的情况下修改它
- 假设文件结构，必须用 list_files 确认
- 猜测函数签名，必须 read_file 查看
- 忽略错误处理，要学习现有的错误处理模式
- 不看 imports 就添加新依赖

## 探索示例

**任务**："添加用户登录功能"

**正确的探索流程**：
1. codebase_search "用户认证" - 查找是否有现有认证逻辑
2. list_files "src" - 了解项目结构
3. read_file "src/types/user.ts" - 了解用户类型定义
4. search_files "login|auth" - 查找相关代码
5. read_file 相关文件 - 深入了解实现
6. 然后才开始修改

**错误的做法**：
直接创建 login.ts 文件，不了解项目结构和现有代码`;
}
