# 码弦（Maxian）插件开发指南

本文档介绍如何为码弦 AI 编程助手开发自定义插件：新增工具、响应生命周期事件。

---

## 1. 插件存放位置

所有插件模块存放于：

```
~/.maxian/plugins/
```

两种形式均可识别：

- **单文件插件**：直接放 `*.js` / `*.mjs` / `*.cjs` 文件，如 `~/.maxian/plugins/my-plugin.mjs`
- **目录插件**：目录中含 `package.json`（必须有 `main` 字段指向入口），入口文件需为 ESM 格式（`.mjs` 或 `type: "module"`）

启动服务端时自动扫描并 `import()`。插件失败不会中断服务，控制台会打印 `[Plugin] ... failed: ...` 警告。

---

## 2. 插件模块结构

单文件示例（`my-plugin.mjs`）：

```js
export default {
  name:    'my-plugin',
  version: '1.0.0',

  // ─── 自定义工具（供 AI Agent 调用） ─────────────────────────
  tools: [
    {
      name:        'hello_world',
      description: '打印一条问候语；参数 name: 收件人名字',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '收件人名字' },
        },
        required: ['name'],
      },
      async execute(params, ctx) {
        return `你好, ${params.name}！`;
      },
    },
  ],

  // ─── 生命周期 Hooks（可选） ─────────────────────────────────
  hooks: {
    async 'session.created'(ctx) {
      console.log('[my-plugin] 新会话创建:', ctx.sessionId);
    },
    async 'tool.execute.before'(ctx) {
      // 返回 false 可取消该工具调用
      if (ctx.toolName === 'bash' && String(ctx.params.command).includes('rm -rf /')) {
        return false;
      }
    },
    async 'tool.execute.after'(ctx) {
      console.log(`[my-plugin] 工具 ${ctx.toolName} 完成 (success=${ctx.success})`);
    },
  },
};
```

---

## 3. 工具（Tools）规范

每个工具对象需满足：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✅ | 工具名（snake_case；不可与内置工具重名） |
| `description` | `string` | ✅ | 给 AI 看的工具用途说明 |
| `parameters` | JSONSchema object | ✅ | 参数 Schema（`type: 'object'`，含 `properties` + `required`） |
| `execute` | `(params, ctx) => Promise<string \| unknown>` | ✅ | 执行逻辑。可返回字符串（直接作为工具输出）或对象（会被 `JSON.stringify`） |

### `execute(params, ctx)` 参数

- `params`：`Record<string, unknown>`，AI 传入的已解析参数（与 `parameters` Schema 对应）
- `ctx`：`{ sessionId?: string; workspacePath?: string; ... }`，运行期上下文

### 返回值

- `string`：直接作为工具输出返回给 AI
- 非字符串对象：内部 `JSON.stringify` 后返回
- 抛出异常：转为字符串错误信息返回给 AI（AI 可据此重试或调整策略）

---

## 4. Hooks 生命周期事件

以下事件名可注册在 `hooks` 对象下：

| 事件 | 触发时机 | Context 参数 | 特殊行为 |
|------|---------|--------------|----------|
| `session.created` | 新会话创建 | `{ sessionId }` | — |
| `message.sent` | 用户消息发送 | `{ sessionId, content }` | — |
| `tool.execute.before` | 工具执行前 | `{ toolName, params, sessionId }` | 返回 `false` 可**取消**该工具调用（AI 收到"已取消"反馈） |
| `tool.execute.after` | 工具执行后（含失败） | `{ toolName, params, result, success, sessionId }` | — |
| `agent.iteration` | 每轮 AI 迭代结束 | `{ sessionId, iter, toolCalls }` | — |

所有 hook 函数均可为 `async`，报错会被捕获（不影响其他插件）。

---

## 5. 完整示例：自动埋点插件

统计每轮工具调用并写入本地日志：

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const logFile = path.join(os.homedir(), '.maxian', 'agent-metrics.jsonl');

export default {
  name: 'metrics-logger',
  version: '0.1.0',
  tools: [],
  hooks: {
    async 'agent.iteration'(ctx) {
      const row = {
        ts: Date.now(),
        sessionId: ctx.sessionId,
        iter: ctx.iter,
        toolCalls: ctx.toolCalls,
      };
      try {
        await fs.appendFile(logFile, JSON.stringify(row) + '\n', 'utf8');
      } catch { /* ignore */ }
    },
  },
};
```

---

## 6. 完整示例：自定义工具（HTTP 查询）

```js
export default {
  name: 'http-fetch-plugin',
  version: '0.1.0',
  tools: [
    {
      name: 'get_weather',
      description: '查询指定城市的天气（中国地区，返回当日天气摘要）',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名（如：北京、上海）' },
        },
        required: ['city'],
      },
      async execute({ city }) {
        const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=%l:+%C+%t+%w`);
        if (!res.ok) throw new Error(`天气 API 失败: ${res.status}`);
        return await res.text();
      },
    },
  ],
};
```

装好后重启应用，AI 即可在 agent 模式中主动调用 `get_weather`。

---

## 7. 调试建议

1. **控制台观察加载日志**：启动时看 `[Plugin] 加载 N 个插件` 是否包含你的插件
2. **手动调用测试**：先写一个简单工具验证执行路径，再逐步加复杂逻辑
3. **错误信息**：插件加载失败时在 `loaded plugin` 列表的 `error` 字段可见；设置页的"插件"标签也会展示
4. **ESM 格式要求**：`.mjs` 或 `package.json` 里声明 `"type": "module"`；否则 `import()` 会失败

---

## 8. 安全与限制

- 插件运行在服务端 Node.js 进程中，拥有 **完整文件系统 + 网络 + 子进程权限**——请确保只加载你信任的插件
- 不建议在 `tool.execute.before` 里做重计算（会阻塞工具调用）
- 不要在 hook 中触发新的工具调用（会造成无限递归）
- 工具名与内置工具冲突时，**内置工具优先生效**，插件工具会被忽略

---

## 9. 版本兼容性

当前插件 API 版本：`v1`（随 Maxian Desktop `v0.1.0+` 发布）。

未来 API 变更会通过次版本号递增 + 保留旧接口兼容一段时间；重大破坏性变更会在发版说明中标注。

---

## 附：内置工具清单（请勿重名）

```
read_file, write_to_file, edit_file, multiedit_file, list_files, search_files,
grep_search, bash, todo_write, web_fetch, web_search, lsp, load_skill,
update_todo_list, ask_followup_question, plan_exit
```

---

如需贡献官方插件或反馈问题，请提交 Issue 到项目仓库。
