# 调试台前端架构

[TOC]

## 1. 定位

本仓库是 `short-novel-service` 的独立本地调试客户端。它不保存业务数据，也不直接持有模型密钥；所有业务状态由后端会话和 MySQL 持久化。

## 2. 运行架构

```mermaid
flowchart TB
    User[调试用户]
    Page[index.html]
    State[页面内状态<br/>会话 / 提示词 / 图谱]
    Sse[SSE 流解析器]
    Graph[图谱编辑器<br/>节点 / 关系 CRUD]
    Proxy[server.mjs<br/>静态文件 + 流式代理]
    Api[Java REST / SSE API]
    DB[(MySQL)]
    Model[OpenAI 兼容模型]

    User --> Page
    Page --> State
    Page --> Sse
    Page --> Graph
    Sse --> Proxy
    Graph --> Proxy
    Proxy --> Api
    Api --> DB
    Api --> Model
```

## 3. 文件职责

| 文件 | 职责 |
| --- | --- |
| `index.html` | 完整交互界面、样式、API 调用、SSE 解析、图谱可视化和编辑逻辑 |
| `server.mjs` | 提供首页，将 `/api/*` 转发到 `API_TARGET`，保持 SSE 分片实时传输 |
| `package.json` | 定义零依赖启动和 JavaScript 语法检查命令 |
| `docs/service-architecture-and-api.md` | 后端完整架构、状态机和全部接口文档 |

当前页面采用单文件结构，是为了与后端内置的 `src/main/resources/static/debug.html` 保持逐字同步，避免两套调试界面行为漂移。页面逻辑继续增长时，可按 `api-client.js`、`conversation-view.js`、`graph-editor.js`、`styles.css` 拆分，但应同时调整后端静态资源构建方式。

## 4. 会话数据流

```mermaid
sequenceDiagram
    actor U as 用户
    participant P as index.html
    participant X as server.mjs
    participant A as Conversation API

    U->>P: 输入 query
    P->>X: POST /api/.../stream
    X->>A: 原样代理 JSON 请求
    A-->>X: SSE status / card / outline / novel_delta
    X-->>P: 逐分片转发
    P-->>U: 实时更新澄清卡、大纲或正文
```

页面使用 `fetch` 和 `ReadableStream` 解析 POST SSE，不使用只支持 GET 的 `EventSource`。`message_id` 每次业务操作重新生成，同一网络重试应复用原值。

## 5. 图谱维护数据流

```mermaid
sequenceDiagram
    actor U as 用户
    participant P as 图谱视图
    participant A as Knowledge Graph API

    P->>A: GET 完整图谱
    A-->>P: nodes + edges
    P-->>U: vis-network + 节点/关系明细
    U->>P: 下拉选择已有资源或自定义新资源
    P->>P: 校验属性 JSON
    P->>A: POST/PUT 节点或关系
    A-->>P: 最新资源对象
    P->>A: GET 完整图谱
    P-->>U: 重绘画布和明细
```

节点和关系选择器会列出当前用户已有资源，选中后直接进入编辑；“自定义新节点/关系”会打开空白表单。节点类型和关系类型使用可输入候选框，候选值由内置常用类型和当前图谱已有类型合并而成，用户仍可输入新的自定义类型。

节点编辑路径使用响应中的数字 `record_id`；关系请求中的 `source`、`target` 使用节点图内部 `id`，两个端点只能从当前用户已有节点中选择。删除节点前会提示其关联关系也会删除，清空整图必须二次确认。

## 6. 本地代理

`server.mjs` 只暴露 `/`、`/index.html` 和 `/api/*`：

- 首页返回 `Cache-Control: no-store`，确保调试修改立即生效。
- API 请求保留方法、请求体和鉴权头。
- 上游响应使用 Node.js Stream 直接 pipe，不聚合 SSE 正文。
- 上游不可用时返回 `502` JSON，不泄露 Token。

## 7. 安全边界

- API Token 只存在于当前标签页内存，不进入 `localStorage`、源码或 Git。
- 模型 API Key 只配置在 Java 服务端。
- 用户 ID 会进入 `localStorage`，用于下次打开时恢复调试对象。
- 本地服务默认只监听 `127.0.0.1`；需要局域网访问时显式设置 `HOST`。
- 图谱写操作和提示词固化都由后端 Token 鉴权，前端不作为权限边界。

## 8. 验证清单

1. `npm run check` 检查本地代理语法。
2. 对 `index.html` 的内联脚本运行 `node --check`。
3. 验证配置接口可经本地代理读取。
4. 验证图谱节点创建、读取、修改、删除。
5. 验证关系创建、读取、修改、删除和重复冲突。
6. 验证节点改名后关系展示同步。
7. 验证资源下拉框可打开已有节点/关系和自定义表单。
8. 验证节点类型、关系类型既可选已有候选，也可手工输入。
9. 验证清空整图后节点和关系均为零。
10. 浏览器检查桌面和移动布局、控制台错误及 SSE 流式输出。
