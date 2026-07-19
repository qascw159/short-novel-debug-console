# 短篇小说服务架构与接口文档

> 文档版本：1.2
> 服务地址：`http://49.232.138.53:8010`  
> 默认模型：`deepseek-v4-flash`  
> 核心协议：HTTP + Server-Sent Events（SSE）

[TOC]

## 1. 项目概述

短篇小说服务接收用户当天的一条真实输入，根据输入完整度决定是否需要澄清。需求明确后，服务结合用户画像和知识图谱生成小说大纲，等待用户确认或修改；用户确认后，服务流式生成约 1500 字的中文短篇爽文。

系统同时具备以下能力：

- 澄清卡支持单选、多选、文本输入和混合输入。
- 澄清可多轮进行，默认最多 3 轮。
- 大纲必须由用户确认后才生成小说。
- 小说正文通过 SSE 增量返回。
- 用户画像和知识图谱在大纲生成后异步更新。
- 用户可通过 REST API 或调试台手工维护图谱节点和关系，手工数据优先于 AI 自动补全。
- 服务不限制每日生成次数；调用方通过是否发起新业务请求控制生成频率。
- `message_id` 提供请求幂等，防止重复提交消耗澄清轮次或生成重复小说。
- 会话和小说状态持久化，可在断线后查询和恢复。

## 2. 项目架构

### 2.1 分层架构

```mermaid
flowchart TB
    Client[接入方客户端 / Debug 前端]
    Auth[ApiTokenFilter<br/>鉴权]
    Controller[ConversationController<br/>HTTP / SSE 接口]
    Workflow[ConversationWorkflowService<br/>工作流编排]
    StateMachine[SessionStateMachine<br/>状态与动作校验]
    Clarification[ClarificationService<br/>澄清判断与答案归并]
    Outline[OutlineService<br/>大纲生成与修改]
    Novel[NovelGenerationService<br/>小说流式生成]
    SessionCreation[SessionCreationService<br/>会话与幂等事务]
    Persistence[NovelPersistenceService<br/>小说版本与完成事务]
    Memory[UserMemoryUpdateService<br/>异步画像与图谱更新]
    GraphController[KnowledgeGraphController<br/>节点与关系 CRUD]
    GraphService[KnowledgeGraphService<br/>归属校验与事务维护]
    LLM[LlmClient<br/>OpenAI 兼容模型接口]
    DB[(MySQL)]

    Client --> Auth --> Controller --> Workflow
    Workflow --> StateMachine
    Workflow --> SessionCreation
    Workflow --> Clarification
    Workflow --> Outline
    Workflow --> Novel
    Clarification --> LLM
    Outline --> LLM
    Novel --> LLM
    Outline -.异步.-> Memory
    Memory --> LLM
    Client --> Auth --> GraphController --> GraphService --> DB
    Memory --> GraphService
    SessionCreation --> DB
    Clarification --> DB
    Outline --> DB
    Novel --> Persistence --> DB
    Memory --> DB
```

### 2.2 核心模块职责

| 模块 | 职责 |
| --- | --- |
| `ConversationController` | 暴露 SSE 会话、会话状态和调试配置接口 |
| `ConversationWorkflowService` | 识别新会话或已有会话，编排澄清、大纲、小说和重试流程 |
| `SessionStateMachine` | 判断当前会话状态是否允许执行指定动作 |
| `ClarificationService` | 判断是否需要澄清、规范化澄清卡、记录澄清答案，限制最大轮次 |
| `OutlineService` | 读取画像与图谱，生成或修改大纲，并触发后台记忆更新 |
| `NovelGenerationService` | 返回 `novel_start`、`novel_delta`、`novel_done`，处理超时、断连和失败 |
| `SessionCreationService` | 在同一事务中占用 `message_id` 并创建会话 |
| `NovelPersistenceService` | 在同一事务中分配小说版本、保存小说并完成会话 |
| `UserMemoryUpdateService` | 异步更新用户画像和知识图谱，只使用用户真实输入，不使用虚构小说正文 |
| `KnowledgeGraphController` | 暴露整图查询、节点 CRUD、关系 CRUD 和清空接口 |
| `KnowledgeGraphService` | 校验节点归属和重复关系，事务同步冗余名称，保护手工维护数据 |
| `OpenAiCompatibleLlmClient` | 按 OpenAI Chat Completions 格式调用模型，支持普通请求和流式请求 |
| Flyway | 管理数据库结构版本，当前迁移版本为 `v4` |
| `SessionCleanupService` | 定时清理过期会话和幂等记录 |

### 2.3 核心数据表

| 数据表 | 用途 |
| --- | --- |
| `novel_generation_sessions` | 保存会话状态、澄清记录、大纲、模型配置、小说版本和错误信息 |
| `novel_request_receipts` | 保存 `(user_id, message_id)` 幂等记录 |
| `novel_daily_counters` | 原子分配同一用户同一天的小说版本号 |
| `daily_novels` | 保存小说大纲、正文、版本和扩展信息 |
| `user_profiles` | 保存用户画像、当前状态和摘要 |
| `user_knowledge_graph` | 保存用户实体节点及实体关系边；`extraction_model=manual` 表示用户手工维护 |
| `novel_runtime_config` | 保存默认模型、温度和系统提示词 |
| `flyway_schema_history` | 保存 Flyway 数据库迁移历史 |

### 2.4 会话状态机

```mermaid
stateDiagram-v2
    [*] --> DECIDING: 创建会话
    DECIDING --> CLARIFYING: 需要澄清
    CLARIFYING --> CLARIFYING: 继续追问且未达到上限
    DECIDING --> OUTLINE_PENDING_CONFIRMATION: 信息充分
    CLARIFYING --> OUTLINE_PENDING_CONFIRMATION: 信息充分或达到轮次上限
    OUTLINE_PENDING_CONFIRMATION --> OUTLINE_PENDING_CONFIRMATION: 修改大纲
    OUTLINE_PENDING_CONFIRMATION --> GENERATING: 确认大纲
    GENERATING --> COMPLETED: 小说保存成功
    GENERATING --> GENERATION_FAILED: 模型失败、超时或连接中断
    GENERATION_FAILED --> GENERATING: retry_generation
```

| 状态 | 含义 | 客户端可执行动作 |
| --- | --- | --- |
| `DECIDING` | 正在判断是否需要澄清 | `retry` |
| `CLARIFYING` | 等待用户回答澄清卡 | `answer_clarification`、`retry` |
| `OUTLINE_PENDING_CONFIRMATION` | 大纲已生成，等待确认 | `confirm_outline`、`modify_outline`、`retry` |
| `GENERATING` | 小说正在流式生成 | 查询会话状态，不要重复确认 |
| `GENERATION_FAILED` | 小说生成失败或流连接中断 | `retry_generation`、`retry` |
| `COMPLETED` | 小说已生成并保存 | 查询小说结果 |

## 3. 用户 Query 完整时序图

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant C as 接入方客户端
    participant A as Conversation API
    participant W as Workflow
    participant DB as MySQL
    participant L as 大模型
    participant M as 后台记忆任务

    U->>C: 输入当天 query
    C->>A: POST /stream<br/>user_id + message_id + query
    A->>W: 鉴权并开始工作流
    W->>DB: 事务占用 message_id 并创建会话

    W-->>C: status<br/>正在判断是否需要澄清
    W->>L: 澄清判断

    loop 最多 3 轮澄清
        alt 需要澄清
            L-->>W: 澄清卡 JSON
            W->>DB: 保存澄清卡和轮次
            W-->>C: clarification_card
            C-->>U: 渲染澄清卡
            U->>C: 选择选项或填写答案
            C->>A: POST /stream<br/>action=answer_clarification
            A->>W: 校验状态和 message_id
            W-->>C: status<br/>正在判断是否继续澄清
            W->>L: 原 query + 已有澄清记录
        else 信息已充分
            L-->>W: clarified_query
        end
    end

    W->>DB: 读取用户画像和知识图谱
    W->>L: 生成小说大纲
    L-->>W: 大纲 JSON
    W->>DB: 保存大纲，状态改为待确认
    W-->>C: outline_created
    W-->>M: 异步触发用户画像和知识图谱更新
    M->>L: 从真实 query 抽取画像和图谱
    M->>DB: 保存画像、节点和关系边

    alt 用户要求修改大纲
        U->>C: 输入修改意见
        C->>A: POST /stream<br/>action=modify_outline
        W-->>C: status<br/>正在修改大纲
        W->>L: 当前大纲 + 修改意见
        L-->>W: 新大纲 JSON
        W->>DB: 保存新大纲
        W-->>C: outline_created
    end

    U->>C: 确认大纲
    C->>A: POST /stream<br/>action=confirm_outline
    W->>DB: 原子更新状态为 GENERATING
    W-->>C: novel_start
    W->>L: 确认大纲 + 画像 + 图谱
    loop 模型流式输出
        L-->>W: 文本 delta
        W-->>C: novel_delta
        C-->>U: 增量展示小说正文
    end
    W->>DB: 事务分配同日新版本、保存小说、完成会话
    W-->>C: novel_done
```

## 4. 接口接入约定

### 4.1 Base URL

```text
http://49.232.138.53:8010
```

生产接入建议通过 HTTPS 网关转发，不建议在公网直接传输明文 Token。

### 4.2 鉴权

除健康检查、调试页面和只读调试配置外，接口需要携带 API Token。支持以下任一方式：

```http
X-API-Token: <YOUR_API_TOKEN>
```

或：

```http
Authorization: Bearer <YOUR_API_TOKEN>
```

未携带或 Token 不正确时返回：

```http
HTTP/1.1 401 Unauthorized

Unauthorized
```

### 4.3 SSE 响应格式

核心会话接口返回 `Content-Type: text/event-stream`。每个事件由一行 `data:` 承载：

```text
data: {"type":"status","session_id":"sess_xxx","payload":{"stage":"deciding","message":"正在判断是否需要澄清"},"timestamp":"2026-07-11T15:00:00Z"}

data: {"type":"clarification_card","session_id":"sess_xxx","payload":{"card":{}},"timestamp":"2026-07-11T15:00:10Z"}
```

所有事件统一结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 事件类型 |
| `session_id` | string/null | 会话 ID；参数校验发生在会话创建前时可能为 `null` |
| `payload` | object | 事件数据，不同事件结构不同 |
| `timestamp` | string | UTC ISO-8601 时间 |

### 4.4 全部接口总表

| 分组 | 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- | --- |
| 会话 | POST | `/api/novels/daily/conversation/stream` | 是 | 新建或继续会话，返回 SSE |
| 会话 | GET | `/api/novels/daily/conversation/sessions/{session_id}` | 是 | 查询会话、小说和后台记忆状态 |
| 调试配置 | GET | `/api/novels/daily/conversation/debug-config` | 否 | 查询默认模型、温度和提示词 |
| 调试配置 | PUT | `/api/novels/daily/conversation/debug-config` | 是 | 持久化默认模型、温度和提示词 |
| 图谱 | GET | `/api/novels/knowledge-graph/{user_id}` | 是 | 查询完整图谱 |
| 图谱节点 | POST | `/api/novels/knowledge-graph/{user_id}/nodes` | 是 | 新增节点 |
| 图谱节点 | GET | `/api/novels/knowledge-graph/{user_id}/nodes/{record_id}` | 是 | 查询节点 |
| 图谱节点 | PUT | `/api/novels/knowledge-graph/{user_id}/nodes/{record_id}` | 是 | 完整更新节点 |
| 图谱节点 | DELETE | `/api/novels/knowledge-graph/{user_id}/nodes/{record_id}` | 是 | 删除节点及其关联关系 |
| 图谱关系 | POST | `/api/novels/knowledge-graph/{user_id}/edges` | 是 | 新增关系 |
| 图谱关系 | GET | `/api/novels/knowledge-graph/{user_id}/edges/{edge_id}` | 是 | 查询关系 |
| 图谱关系 | PUT | `/api/novels/knowledge-graph/{user_id}/edges/{edge_id}` | 是 | 完整更新关系 |
| 图谱关系 | DELETE | `/api/novels/knowledge-graph/{user_id}/edges/{edge_id}` | 是 | 删除关系 |
| 图谱 | DELETE | `/api/novels/knowledge-graph/{user_id}` | 是 | 清空用户图谱 |
| 兼容用户 | GET/POST | `/users`、`/users/by-name` | 是 | 旧用户数据接口 |
| 兼容画像 | GET/POST | `/user-profiles/...` | 是 | 旧画像数据接口 |
| 兼容小说 | GET/POST | `/daily-novels/...` | 是 | 旧小说数据接口 |
| 运维 | GET | `/actuator/health`、`/actuator/info` | 否 | 健康和服务信息 |
| 已废弃 | POST | `/api/novels/daily/generate` | 是 | 固定返回 `410 Gone` |

## 5. 核心会话接口

### 5.1 开始会话或继续会话

```http
POST /api/novels/daily/conversation/stream
Content-Type: application/json
Accept: text/event-stream
X-API-Token: <YOUR_API_TOKEN>
```

新建会话和会话后续动作共用同一个接口，通过是否传递 `session_id` 区分。

#### 请求字段

| 字段 | 类型 | 新会话 | 后续动作 | 说明 |
| --- | --- | --- | --- | --- |
| `user_id` | string | 必填 | 必填 | 业务系统中的稳定用户 ID |
| `message_id` | string | 强烈建议 | 强烈建议 | 用户级幂等键，最长 128 字符 |
| `session_id` | string | 不传 | 必填 | 首次 SSE 事件返回的会话 ID |
| `query` | string | 必填 | 不传 | 用户当天的原始输入 |
| `action` | string | 不传 | 必填 | 会话动作，见动作表 |
| `payload` | object/string | 可选 | 按动作传递 | 动作参数 |
| `model` | string | 可选 | 忽略 | 模型 ID，默认 `deepseek-v4-flash` |
| `temperature` | number | 可选 | 忽略 | 范围会被限制到 `0.0-2.0`，默认 `0.7` |
| `prompt_overrides` | object | 可选 | 忽略 | 本会话提示词覆盖，创建后固化在会话中 |
| `force_regenerate` | boolean | 可选 | 忽略 | 已废弃，仅为兼容旧调用方保留，传入任何值都不影响流程 |

#### 动作表

| `action` | 使用状态 | `payload` | 说明 |
| --- | --- | --- | --- |
| `answer_clarification` | `CLARIFYING` | `{"answer": ...}` | 回答澄清卡 |
| `confirm_outline` | `OUTLINE_PENDING_CONFIRMATION` | 无 | 确认大纲并开始流式生成小说 |
| `modify_outline` | `OUTLINE_PENDING_CONFIRMATION` | `{"feedback":"..."}` | 修改大纲 |
| `retry_generation` | `GENERATION_FAILED` | 无 | 重试小说生成 |
| `retry` | 可恢复状态 | 无 | 重新执行或回放当前步骤 |

兼容动作别名包括 `answer`、`clarification_answer`、`confirm` 和 `modify`，新接入方应使用动作表中的标准名称。

### 5.2 新建会话示例

```json
{
  "user_id": "user_10001",
  "message_id": "msg_20260711_0001",
  "query": "今天很不开心",
  "model": "deepseek-v4-flash",
  "temperature": 0.7
}
```

服务会立即返回 `status`，之后返回以下结果之一：

- `clarification_card`：需要用户继续补充。
- `outline_created`：信息充分，已生成待确认大纲。
- `error`：工作流处理失败。

### 5.3 回答文本或单选澄清卡

```json
{
  "session_id": "sess_0123456789abcdefghij",
  "user_id": "user_10001",
  "message_id": "msg_20260711_0002",
  "action": "answer_clarification",
  "payload": {
    "answer": "表姐，她在家人面前否定了我的工作成果"
  }
}
```

### 5.4 回答多选或混合澄清卡

```json
{
  "session_id": "sess_0123456789abcdefghij",
  "user_id": "user_10001",
  "message_id": "msg_20260711_0003",
  "action": "answer_clarification",
  "payload": {
    "answer": {
      "selections": ["prove_with_data", "public_apology"],
      "custom_text": "希望结尾不要过度惩罚对方"
    }
  }
}
```

客户端应根据澄清卡中的 `min_selections` 和 `max_selections` 限制选择数量。

### 5.5 修改大纲

```json
{
  "session_id": "sess_0123456789abcdefghij",
  "user_id": "user_10001",
  "message_id": "msg_20260711_0004",
  "action": "modify_outline",
  "payload": {
    "feedback": "保留逆袭主线，但结尾更温暖，不要让反派受到过度惩罚"
  }
}
```

修改完成后再次返回 `outline_created`，客户端应使用新大纲覆盖旧大纲。

### 5.6 确认大纲并生成小说

```json
{
  "session_id": "sess_0123456789abcdefghij",
  "user_id": "user_10001",
  "message_id": "msg_20260711_0005",
  "action": "confirm_outline"
}
```

正常事件顺序：

```text
novel_start
novel_delta
novel_delta
...
novel_done
```

### 5.7 重试小说生成

```json
{
  "session_id": "sess_0123456789abcdefghij",
  "user_id": "user_10001",
  "message_id": "msg_20260711_retry_0001",
  "action": "retry_generation"
}
```

仅当会话状态为 `GENERATION_FAILED` 时可调用。

## 6. SSE 事件文档

### 6.1 `status`

表示服务已经接收请求，正在执行耗时步骤。

```json
{
  "type": "status",
  "session_id": "sess_xxx",
  "payload": {
    "stage": "deciding",
    "message": "正在判断是否需要澄清"
  },
  "timestamp": "2026-07-11T15:00:00Z"
}
```

常见 `stage`：

| `stage` | 含义 |
| --- | --- |
| `deciding` | 判断需求是否需要澄清 |
| `clarifying` | 判断是否继续澄清 |
| `outline_generating` | 生成小说大纲 |
| `outline_modifying` | 修改小说大纲 |
| `generating` | 幂等回放时表示小说仍在生成 |
| `completed` | 幂等回放时表示请求已完成 |

### 6.2 `clarification_card`

```json
{
  "type": "clarification_card",
  "session_id": "sess_xxx",
  "payload": {
    "card": {
      "card_type": "single_select",
      "question": "是谁让你不开心？",
      "description": "请选择最接近的关系，也可以直接填写",
      "options": [
        {
          "value": "family",
          "label": "家人",
          "description": "父母、亲戚或伴侣"
        },
        {
          "value": "coworker",
          "label": "同事",
          "description": "同事或上级"
        }
      ],
      "allow_custom": true,
      "min_selections": 1,
      "max_selections": 1,
      "input_placeholder": "也可以直接说是谁",
      "round": 1,
      "max_rounds": 3
    }
  },
  "timestamp": "2026-07-11T15:00:10Z"
}
```

`card_type` 取值：

| 类型 | 客户端控件 | 回答格式 |
| --- | --- | --- |
| `single_select` | 单选项，可附加自定义文本 | 字符串 |
| `multi_select` | 多选项 | `selections + custom_text` |
| `text_input` | 文本输入框 | 字符串 |
| `mixed` | 多选项 + 文本输入框 | `selections + custom_text` |

### 6.3 `outline_created`

```json
{
  "type": "outline_created",
  "session_id": "sess_xxx",
  "payload": {
    "outline": {
      "title": "数据为王",
      "logline": "主角用真实项目数据回应亲戚的否定。",
      "protagonist": {
        "identity": "项目负责人",
        "goal": "证明自己的工作成果",
        "strength": "专业与冷静"
      },
      "antagonistic_force": "亲戚的公开质疑",
      "emotional_target": "释放委屈并获得认可",
      "core_pleasure": "用事实完成反转",
      "beats": [
        {
          "order": 1,
          "title": "当众否定",
          "summary": "聚会中主角的成果被轻视。",
          "emotional_change": "委屈转为克制"
        }
      ],
      "ending": "对方承认判断错误，主角获得家人尊重。",
      "estimated_chinese_characters": 1500
    },
    "requires_confirmation": true,
    "allowed_actions": ["confirm_outline", "modify_outline"]
  },
  "timestamp": "2026-07-11T15:01:00Z"
}
```

大纲至少保证存在 `title` 和数组类型的 `beats`。其余字段由当前系统提示词约定。

### 6.4 `novel_start`

```json
{
  "type": "novel_start",
  "session_id": "sess_xxx",
  "payload": {
    "model": "deepseek-v4-flash",
    "temperature": 0.7,
    "target_chinese_characters": 1500
  },
  "timestamp": "2026-07-11T15:02:00Z"
}
```

客户端收到该事件后应清空本次正文缓冲区，并进入流式展示状态。

### 6.5 `novel_delta`

```json
{
  "type": "novel_delta",
  "session_id": "sess_xxx",
  "payload": {
    "delta": "会议室里忽然安静下来。"
  },
  "timestamp": "2026-07-11T15:02:01Z"
}
```

客户端应按接收顺序直接追加 `payload.delta`，不要对单个分片做 JSON、Markdown 或句子级解析。

### 6.6 `novel_done`

新小说生成完成：

```json
{
  "type": "novel_done",
  "session_id": "sess_xxx",
  "payload": {
    "generated": true,
    "novel_id": 1001,
    "novel_version": 1,
    "title": "数据为王",
    "content": "完整小说正文……",
    "character_count": 1450,
    "length_target_met": true
  },
  "timestamp": "2026-07-11T15:03:00Z"
}
```

同一个 `message_id` 在小说完成后重发时，服务回放已保存的最终结果：

```json
{
  "type": "novel_done",
  "session_id": "sess_xxx",
  "payload": {
    "generated": true,
    "replayed": true,
    "novel_id": 1001,
    "novel_version": 1,
    "title": "数据为王",
    "outline": "{...}",
    "content": "完整小说正文……"
  },
  "timestamp": "2026-07-11T15:03:00Z"
}
```

客户端应以 `novel_done.payload.content` 作为最终正文真值。正常流式生成时，它应与所有 `novel_delta` 拼接结果一致。

### 6.7 `error`

```json
{
  "type": "error",
  "session_id": "sess_xxx",
  "payload": {
    "code": "NOVEL_GENERATION_FAILED",
    "message": "小说生成失败，可使用同一 session_id 重试",
    "retryable": true
  },
  "timestamp": "2026-07-11T15:03:00Z"
}
```

客户端应以 `payload.retryable` 判断是否展示重试按钮，不应根据错误文案做程序判断。

## 7. 查询会话状态

```http
GET /api/novels/daily/conversation/sessions/{session_id}?user_id={user_id}
X-API-Token: <YOUR_API_TOKEN>
```

示例：

```http
GET /api/novels/daily/conversation/sessions/sess_0123456789abcdefghij?user_id=user_10001
```

响应：

```json
{
  "session_id": "sess_0123456789abcdefghij",
  "user_id": "user_10001",
  "novel_date": "2026-07-11",
  "status": "OUTLINE_PENDING_CONFIRMATION",
  "clarification_round": 2,
  "clarification_card": null,
  "outline": {
    "title": "数据为王",
    "beats": []
  },
  "model": "deepseek-v4-flash",
  "temperature": 0.7,
  "prompt_overrides": {},
  "novel_id": null,
  "novel_version": null,
  "memory_update_status": "RUNNING",
  "memory_error_message": null,
  "error_code": null,
  "error_message": null,
  "created_at": "2026-07-11T23:00:00",
  "updated_at": "2026-07-11T23:01:00"
}
```

`session_id` 不存在，或 `session_id` 与 `user_id` 不匹配时返回 `404 Not Found`。

### 7.1 后台记忆状态

| 状态 | 含义 |
| --- | --- |
| `PENDING` | 尚未开始更新 |
| `RUNNING` | 正在更新画像和图谱 |
| `COMPLETED` | 更新成功 |
| `FAILED` | 更新失败，可通过 `memory_error_message` 排查 |
| `SKIPPED` | 旧版本每日限额产生的历史会话未执行记忆更新；当前版本不再新增此状态 |

## 8. 用户知识图谱接口

图谱由节点和有向关系组成。整图中的节点 `id` 是图内部实体 ID，用于关系的 `source`、`target`；节点 CRUD 路径使用数字 `record_id`。关系 CRUD 路径使用关系的数字 `id`。

所有写操作满足以下规则：

- `properties` 必须是 JSON 对象，不能是数组、字符串或数字。
- `confidence` 范围为 `0.0-1.0`，不传时手工数据默认使用 `1.0`。
- 相同用户下，节点的 `(type, name)` 不能重复。
- 相同用户下，关系的 `(source, relation, target)` 不能重复。
- 创建和修改关系时，源节点、目标节点必须属于路径中的用户。
- 手工创建或修改后 `provenance=manual`，后续 AI 自动抽取不会覆盖该记录。
- 修改节点名称或类型时，所有关联边中的冗余名称和类型会在同一事务中同步。
- 删除节点会在同一事务中删除它的全部入边和出边。

### 8.1 查询完整图谱

```http
GET /api/novels/knowledge-graph/{user_id}
X-API-Token: <YOUR_API_TOKEN>
```

响应：

```json
{
  "user_id": "user_10001",
  "nodes": [
    {
      "record_id": 17,
      "id": "person:表姐",
      "name": "表姐",
      "type": "person",
      "properties": {
        "relationship": "亲戚"
      },
      "confidence": 0.9,
      "provenance": "ai",
      "source_date": "2026-07-17",
      "created_at": "2026-07-17T10:00:00",
      "updated_at": "2026-07-17T10:00:00"
    }
  ],
  "edges": [
    {
      "id": 31,
      "source": "person:用户",
      "target": "person:表姐",
      "relation": "relative_of",
      "source_type": "person",
      "source_name": "用户",
      "target_type": "person",
      "target_name": "表姐",
      "properties": {},
      "confidence": 0.9,
      "provenance": "ai",
      "source_date": "2026-07-17",
      "created_at": "2026-07-17T10:00:00",
      "updated_at": "2026-07-17T10:00:00"
    }
  ]
}
```

用户暂时没有图谱时仍返回 `200 OK`，`nodes` 和 `edges` 为空数组。

### 8.2 新增节点

```http
POST /api/novels/knowledge-graph/{user_id}/nodes
Content-Type: application/json
X-API-Token: <YOUR_API_TOKEN>
```

```json
{
  "name": "表姐",
  "type": "person",
  "properties": {
    "relationship": "亲戚",
    "note": "在同一家公司工作"
  },
  "confidence": 1.0
}
```

成功返回 `201 Created`，并包含新节点。服务生成稳定的图内部 `id`，调用方不要自行拼接。

```http
Location: /api/novels/knowledge-graph/user_10001/nodes/42
```

```json
{
  "record_id": 42,
  "id": "manual:9c42c09d-9a98-4cbf-a8ef-6c14fbff8131",
  "name": "表姐",
  "type": "person",
  "properties": {
    "relationship": "亲戚",
    "note": "在同一家公司工作"
  },
  "confidence": 1.0,
  "provenance": "manual",
  "source_date": "2026-07-17",
  "created_at": "2026-07-17T20:00:00",
  "updated_at": "2026-07-17T20:00:00"
}
```

### 8.3 查询单个节点

```http
GET /api/novels/knowledge-graph/{user_id}/nodes/{record_id}
X-API-Token: <YOUR_API_TOKEN>
```

成功返回与新增节点相同的对象结构；节点不存在或不属于当前用户时返回 `404 Not Found`。

### 8.4 更新节点

```http
PUT /api/novels/knowledge-graph/{user_id}/nodes/{record_id}
Content-Type: application/json
X-API-Token: <YOUR_API_TOKEN>
```

PUT 使用完整替换语义，字段与新增节点相同。节点内部 `id` 和数字 `record_id` 不变；更新成功返回 `200 OK` 和完整节点对象。

```json
{
  "name": "姐姐",
  "type": "person",
  "properties": {
    "relationship": "亲戚",
    "note": "用户更习惯称呼为姐姐"
  },
  "confidence": 1.0
}
```

### 8.5 删除节点

```http
DELETE /api/novels/knowledge-graph/{user_id}/nodes/{record_id}
X-API-Token: <YOUR_API_TOKEN>
```

成功返回 `204 No Content`。该节点的全部入边和出边同时删除；重复删除返回 `404 Not Found`。

### 8.6 新增关系

```http
POST /api/novels/knowledge-graph/{user_id}/edges
Content-Type: application/json
X-API-Token: <YOUR_API_TOKEN>
```

`source` 和 `target` 使用整图响应中节点的图内部 `id`，不是数字 `record_id`。

```json
{
  "source": "person:用户",
  "target": "manual:9c42c09d-9a98-4cbf-a8ef-6c14fbff8131",
  "relation": "family_of",
  "properties": {
    "description": "表姐妹"
  },
  "confidence": 1.0
}
```

成功返回 `201 Created`：

```json
{
  "id": 58,
  "source": "person:用户",
  "target": "manual:9c42c09d-9a98-4cbf-a8ef-6c14fbff8131",
  "relation": "family_of",
  "source_type": "person",
  "source_name": "用户",
  "target_type": "person",
  "target_name": "表姐",
  "properties": {
    "description": "表姐妹"
  },
  "confidence": 1.0,
  "provenance": "manual",
  "source_date": "2026-07-17",
  "created_at": "2026-07-17T20:05:00",
  "updated_at": "2026-07-17T20:05:00"
}
```

### 8.7 查询、更新和删除单个关系

```http
GET /api/novels/knowledge-graph/{user_id}/edges/{edge_id}
PUT /api/novels/knowledge-graph/{user_id}/edges/{edge_id}
DELETE /api/novels/knowledge-graph/{user_id}/edges/{edge_id}
X-API-Token: <YOUR_API_TOKEN>
```

PUT 请求体与新增关系相同，使用完整替换语义。GET 和 PUT 成功返回关系对象；DELETE 成功返回 `204 No Content`；关系不存在或不属于当前用户时返回 `404 Not Found`。

### 8.8 删除整个用户图谱

```http
DELETE /api/novels/knowledge-graph/{user_id}
X-API-Token: <YOUR_API_TOKEN>
```

成功返回 `204 No Content`。

### 8.9 cURL 完整维护示例

```bash
# 创建节点
curl -X POST "$BASE_URL/api/novels/knowledge-graph/user_10001/nodes" \
  -H "X-API-Token: $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"表姐","type":"person","properties":{},"confidence":1}'

# 创建关系
curl -X POST "$BASE_URL/api/novels/knowledge-graph/user_10001/edges" \
  -H "X-API-Token: $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"person:用户","target":"manual:节点UUID","relation":"family_of","properties":{},"confidence":1}'

# 更新 record_id=42 的节点
curl -X PUT "$BASE_URL/api/novels/knowledge-graph/user_10001/nodes/42" \
  -H "X-API-Token: $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"姐姐","type":"person","properties":{},"confidence":1}'

# 删除 edge_id=58 的关系
curl -X DELETE "$BASE_URL/api/novels/knowledge-graph/user_10001/edges/58" \
  -H "X-API-Token: $API_TOKEN"
```

### 8.10 已废弃的按名称删除接口

```http
DELETE /api/novels/knowledge-graph/{user_id}/entity/{entity_name}
X-API-Token: <YOUR_API_TOKEN>
```

该接口仅为旧客户端保留。它按名称删除，存在同名误删风险；新接入必须使用 `DELETE /nodes/{record_id}`。

## 9. 调试配置接口

### 9.1 获取模型、温度和提示词

```http
GET /api/novels/daily/conversation/debug-config
```

该接口无需 Token，供调试页面初始化配置。

```json
{
  "default_model": "deepseek-v4-flash",
  "default_temperature": 0.7,
  "persisted": true,
  "updated_at": "2026-07-11T22:27:39",
  "max_clarification_rounds": 3,
  "model_suggestions": ["deepseek-v4-flash"],
  "prompts": {
    "clarification_system": "...",
    "outline_system": "...",
    "outline_modify_system": "...",
    "novel_system": "...",
    "profile_system": "...",
    "graph_system": "..."
  }
}
```

### 9.2 保存系统默认配置

```http
PUT /api/novels/daily/conversation/debug-config
Content-Type: application/json
X-API-Token: <YOUR_API_TOKEN>
```

```json
{
  "default_model": "deepseek-v4-flash",
  "default_temperature": 0.7,
  "prompts": {
    "clarification_system": "完整提示词",
    "outline_system": "完整提示词",
    "outline_modify_system": "完整提示词",
    "novel_system": "完整提示词",
    "profile_system": "完整提示词",
    "graph_system": "完整提示词"
  }
}
```

该接口会修改所有后续新会话的系统默认值，应只对管理员或内部调试工具开放。已有会话继续使用创建时固化的模型、温度和提示词快照。

## 10. 错误码

### 10.1 SSE 业务错误码

| 错误码 | `retryable` | 含义 | 建议处理 |
| --- | --- | --- | --- |
| `QUERY_REQUIRED` | false | 新会话缺少 query | 提示用户输入内容 |
| `MESSAGE_ID_TOO_LONG` | false | `message_id` 超过 128 字符 | 生成更短的幂等键 |
| `SESSION_NOT_FOUND` | false | 会话不存在或已过期 | 创建新会话 |
| `USER_MISMATCH` | false | 会话不属于当前用户 | 检查用户与会话绑定 |
| `INVALID_ACTION` | false | 动作不受支持 | 使用标准动作名称 |
| `INVALID_SESSION_STATUS` | false | 当前状态不允许此动作 | 先查询会话状态 |
| `ANSWER_REQUIRED` | false | 澄清答案为空 | 要求用户回答 |
| `FEEDBACK_REQUIRED` | false | 修改大纲时未提供反馈 | 填写 `payload.feedback` |
| `DUPLICATE_REQUEST` | true | 幂等请求已被处理，但暂时无法回放 | 查询会话状态 |
| `WORKFLOW_FAILED` | true | 澄清或大纲模型调用失败 | 使用同一会话执行 `retry` |
| `OUTLINE_REQUIRED` | false | 会话内没有可用大纲 | 回到大纲步骤 |
| `GENERATION_BUSY_OR_COMPLETED` | false | 小说正在生成或已经完成 | 查询会话状态，不要重复确认 |
| `NOVEL_GENERATION_FAILED` | true | 小说模型调用或保存失败 | 使用新 `message_id` 执行 `retry_generation` |
| `NOT_RETRYABLE` | false | 当前状态不需要重试 | 按当前状态继续 |

`STREAM_CANCELLED` 记录在会话的 `error_code` 中。它表示小说流尚未完成时客户端主动断开，客户端重新连接后应查询状态并执行 `retry_generation`。

### 10.2 HTTP 状态码

| HTTP 状态 | 场景 |
| --- | --- |
| `200 OK` | 接口正常；SSE 业务错误仍可能以 `type=error` 返回 |
| `201 Created` | 图谱节点或关系创建成功 |
| `204 No Content` | 图谱删除成功 |
| `400 Bad Request` | Bean Validation 校验失败或请求参数非法 |
| `401 Unauthorized` | Token 缺失或错误 |
| `404 Not Found` | 会话、图谱节点或图谱关系不存在，或不属于当前用户 |
| `409 Conflict` | 同类型同名节点重复，或相同源、关系、目标的边重复 |
| `410 Gone` | 调用了已废弃的同步生成接口 |
| `500 Internal Server Error` | 未被工作流转换为 SSE 错误的服务器异常 |

## 11. 幂等、生成频率与重试策略

### 11.1 `message_id` 规则

`message_id` 在同一 `user_id` 下唯一，建议格式：

```text
<业务名>_<日期>_<UUID或递增序号>
```

示例：

```text
app_20260711_9f2bd5f0
```

处理原则：

1. 每一次用户业务操作使用一个新的 `message_id`。
2. 同一个 HTTP 请求因网络未知结果而重发时，必须复用原 `message_id`。
3. 重复请求不会重复消费澄清轮次，也不会创建新的小说版本，而是回放当前会话状态。
4. 用户主动点击“重试”属于新的业务操作，应生成新的 `message_id`。

### 11.2 生成频率由调用方控制

- 服务端不限制同一用户每天创建小说的次数。
- 调用方每发起一个新的业务请求并使用新的 `message_id`，服务就创建独立会话。
- 同一天完成的多篇小说使用递增的 `novel_version` 保存，不覆盖已有小说。
- 重发同一业务请求必须复用原 `message_id`，服务只回放原会话，不创建新版本。
- `force_regenerate` 已废弃但仍兼容接收，传入 `true` 或 `false` 都不会改变上述行为。
- 小说版本由数据库事务原子分配，并发请求不会获得相同版本号。

### 11.3 断线恢复

普通澄清或大纲请求断线：

1. 使用原 `message_id` 重发原请求。
2. 服务回放澄清卡、大纲或当前状态。

小说流断线：

1. 调用会话状态接口。
2. 若状态为 `GENERATION_FAILED` 且 `error_code=STREAM_CANCELLED`，使用新 `message_id` 调用 `retry_generation`。
3. 不应尝试从中断位置续写；当前实现会重新生成完整小说。

### 11.4 超时建议

- 模型流式请求服务端上限为 3 分钟。
- 接入方 HTTP/SSE 客户端建议设置至少 240 秒整体超时。
- 收到 `status` 后应持续等待终态事件，不要因为暂时没有正文分片就立即断开。
- 终态事件为 `clarification_card`、`outline_created`、`novel_done` 或 `error`。

## 12. JavaScript SSE 接入示例

`EventSource` 只支持 GET，不适合本接口的 POST JSON 请求。浏览器端应使用 `fetch` 读取响应流。

```javascript
async function conversationStream(requestBody, apiToken, onEvent) {
  const response = await fetch(
    "http://49.232.138.53:8010/api/novels/daily/conversation/stream",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-API-Token": apiToken
      },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart())
        .join("\n");

      if (data && data !== "[DONE]") {
        onEvent(JSON.parse(data));
      }
    }

    if (done) break;
  }
}

let novelText = "";

await conversationStream(
  {
    user_id: "user_10001",
    message_id: crypto.randomUUID(),
    query: "今天很不开心"
  },
  "<YOUR_API_TOKEN>",
  event => {
    switch (event.type) {
      case "status":
        console.log(event.payload.message);
        break;
      case "clarification_card":
        renderClarificationCard(event.payload.card);
        break;
      case "outline_created":
        renderOutline(event.payload.outline);
        break;
      case "novel_start":
        novelText = "";
        break;
      case "novel_delta":
        novelText += event.payload.delta;
        renderNovel(novelText);
        break;
      case "novel_done":
        novelText = event.payload.content;
        renderNovel(novelText);
        break;
      case "error":
        renderError(event.payload);
        break;
    }
  }
);
```

## 13. cURL 调试示例

`curl -N` 可关闭输出缓冲，实时查看 SSE：

```bash
curl -N \
  -X POST "http://49.232.138.53:8010/api/novels/daily/conversation/stream" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "X-API-Token: <YOUR_API_TOKEN>" \
  -d '{
    "user_id": "user_10001",
    "message_id": "msg_20260711_0001",
    "query": "今天很不开心"
  }'
```

查询会话：

```bash
curl \
  "http://49.232.138.53:8010/api/novels/daily/conversation/sessions/sess_xxx?user_id=user_10001" \
  -H "X-API-Token: <YOUR_API_TOKEN>"
```

## 14. 运维与数据生命周期

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_CLARIFICATION_ROUNDS` | `3` | 最大澄清轮次 |
| `SESSION_TTL_HOURS` | `168` | 会话保留时间，默认 7 天 |
| `REQUEST_RECEIPT_TTL_DAYS` | `14` | 幂等记录保留时间 |
| `SESSION_CLEANUP_CRON` | `0 20 3 * * *` | 每天 03:20 清理过期记录 |
| `APP_TIMEZONE` | `Asia/Shanghai` | 每日小说日期和定时任务时区 |
| `AI_GENERATION_MODEL` | `deepseek-v4-flash` | 默认生成模型 |
| `AI_ANALYSIS_MODEL` | `deepseek-v4-flash` | 默认分析模型 |
| `AI_TEMPERATURE` | `0.7` | 默认温度 |
| `AI_THINKING_ENABLED` | `false` | 是否启用模型思考；默认关闭以降低延迟 |

会话过期后，小说、用户画像和知识图谱不会随会话一起删除。接入方不应将会话接口当作永久小说存储接口。

## 15. 已废弃接口

```http
POST /api/novels/daily/generate
```

该同步接口已废弃，返回：

```http
HTTP/1.1 410 Gone
Deprecation: true
Link: </api/novels/daily/conversation/stream>; rel="successor-version"
```

```json
{
  "code": "SYNC_GENERATION_RETIRED",
  "message": "同步生成流程已废弃，请使用会话 SSE 接口",
  "successor": "/api/novels/daily/conversation/stream"
}
```

所有新接入必须使用 `/api/novels/daily/conversation/stream`。

## 16. 兼容数据接口

这些接口用于兼容早期数据脚本，直接读写底层用户、画像和小说记录，不执行澄清、大纲确认、幂等或小说生成工作流。新业务应优先使用会话接口。

除 `/` 外，以下接口均需要 API Token。

### 16.1 服务根路径

```http
GET /
```

返回纯文本 `Java short-novel-service is running`。

### 16.2 用户数据

```http
GET /users
GET /users/by-name?name=张三
POST /users
```

创建用户请求：

```json
{
  "name": "张三",
  "email": "zhangsan@example.com"
}
```

`name` 必填，`email` 必须符合邮箱格式。查询返回用户数组，字段包括 `id`、`name`、`email`、`created_at`。

### 16.3 用户画像数据

```http
GET /user-profiles/{user_id}
POST /user-profiles
```

```json
{
  "user_id": "user_10001",
  "phone": "",
  "data_source": "manual",
  "profile": {
    "identity_keywords": ["产品经理"]
  },
  "current_state": {
    "current_emotion": {
      "description": "开心",
      "intensity": "medium"
    }
  },
  "summary": {
    "short_bio": "喜欢节奏明快的故事"
  }
}
```

POST 按 `user_id` 新增或覆盖画像。旧接口在画像不存在时返回 `200 OK` 和 JSON `null`。

### 16.4 小说数据

```http
GET /daily-novels/{user_id}
GET /daily-novels/{user_id}/{novel_date}
POST /daily-novels
```

日期使用 `YYYY-MM-DD`。POST 请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | string | 是 | 用户 ID |
| `novel_date` | string | 是 | 小说日期 |
| `title` | string | 否 | 标题 |
| `demand` | string | 否 | 用户需求 |
| `outline` | string | 否 | 大纲字符串 |
| `content` | string | 否 | 小说正文 |
| `style`、`mood`、`status`、`source` | string | 否 | 扩展元数据 |
| `version` | integer | 否 | 版本号 |
| `feedback` | string | 否 | 用户反馈 |
| `rating` | integer | 否 | 评分 |
| `extra` | object | 否 | JSON 扩展字段 |

### 16.5 运维接口

```http
GET /actuator/health
GET /actuator/info
```

无需 Token。健康接口正常时返回：

```json
{"status":"UP"}
```

## 17. 图谱维护架构与事务边界

```mermaid
sequenceDiagram
    actor U as 用户
    participant UI as Debug Console
    participant API as KnowledgeGraphController
    participant S as KnowledgeGraphService
    participant R as KnowledgeGraphRepository
    participant DB as MySQL

    U->>UI: 新增/编辑节点或关系
    UI->>API: 带 Token 的 JSON 请求
    API->>S: Bean Validation 后调用服务
    S->>R: 校验记录归属和重复约束
    R->>DB: 查询用户节点/关系
    alt 修改节点
        S->>R: 更新节点并标记 manual
        R->>DB: 同事务同步所有入边/出边名称和类型
    else 删除节点
        S->>R: 删除节点
        R->>DB: 同事务删除全部关联边
    else 新增或修改关系
        S->>R: 校验两个端点属于当前用户
        R->>DB: 写入关系并标记 manual
    end
    S-->>API: 最新资源对象
    API-->>UI: 200/201/204 或结构化错误
```

AI 后台补图谱仍通过同一个 `KnowledgeGraphService` 写入。仓储层在 upsert 时检查 `extraction_model=manual`：手工记录保留用户维护的名称、类型、属性、置信度和来源日期，AI 只能新增其他事实，不能覆盖手工记录。模型抽取到相同 `(type, name)` 的节点时会复用手工节点 ID，抽取出的新关系也会连接到该节点，避免形成语义重复的两套节点。
