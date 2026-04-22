# @maxian/core

码弦（Maxian）AI Coding Agent 核心库 — IDE 与桌面客户端共享。

## 设计原则

1. **零平台依赖**：不依赖 `vscode` API，不依赖浏览器 DOM，也不直接 import `fs`/`child_process`。
2. **接口驱动**：所有平台相关操作通过 `interfaces/` 下的抽象接口调用。
3. **纯异步**：所有对外接口均为 `Promise` 或 `AsyncIterable`，便于跨进程（IPC）调用。
4. **无副作用导出**：支持 Tree-shaking。

## 目录结构

```
src/
├── interfaces/           抽象接口定义（IFileSystem、ITerminal 等）
├── types/                共享类型（ToolUse、ClineMessage 等）
├── prompts/              系统提示词生成（纯函数）
├── tools/                26+ 工具实现（依赖 interfaces，不依赖具体平台）
├── api/                  AI 服务调用（qwenHandler、aiProxyHandler）
├── task/                 TaskService 主循环
├── context/              上下文压缩、历史管理
├── mcp/                  MCP 客户端
├── adapters/             （仅示例）平台适配器应由调用方提供
└── utils/                纯工具函数（token 估算、字符串处理等）
```

## 使用方

- **@maxian/ide**：IDE（VSCode Fork）通过 VSCode API 实现接口
- **@maxian/desktop**：Tauri 桌面客户端通过 Node.js API 实现接口

## 开发命令

```bash
npm run build       # 编译
npm run watch       # 监听编译
npm run typecheck   # 仅类型检查
npm run test        # 运行测试
```

## 发布

```bash
npm run build
npm pack            # 生成 tgz 供本地测试
```

## 版本策略

- 主版本号：与 IDE 大版本保持一致
- 次版本号：功能迭代（新增工具、新增接口）
- 修订号：Bug 修复、性能优化
