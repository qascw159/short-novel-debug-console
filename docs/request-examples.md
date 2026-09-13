# 请求示例与供应商连接测试

服务地址：http://49.232.138.53:8010
所有业务请求携带 X-API-Token: <SERVICE_API_TOKEN> 和 Content-Type: application/json。
服务 API Token 与模型供应商 API Key 是两个不同的凭证。

## 会话请求

POST /api/novels/daily/conversation/stream
Accept: text/event-stream

新建会话：
```json
{
  "user_id": "user_001",
  "message_id": "msg_start_001",
  "query": "今天我的方案被同事质疑，后来我用数据证明了自己",
  "language": "en-US",
  "model": "deepseek-v4-flash",
  "temperature": 0.7,
  "prompt_overrides": {}
}
```

user_id、query 为新会话必填。message_id 建议必传，用户级幂等；
同一请求重试用相同 ID，新动作使用新 ID。
language 支持 zh-CN / en-US（及 zh / en 别名），每次独立处理，省略默认中文。
model、temperature、prompt_overrides 可省略，采用对应语言的默认配置。
供应商地址和 Key 通过配置接口设置，不放进会话请求。
force_regenerate 已废弃，无需传递。

以下 session_id 使用上一次 SSE 返回值。

回答澄清：
```json
{"user_id":"user_001","message_id":"msg_answer_001","session_id":"sess_xxx","language":"en-US","action":"answer_clarification","payload":{"answer":"是同事质疑了我的项目方案，我想写成温暖的职场成长故事"}}
```

修改大纲：
```json
{"user_id":"user_001","message_id":"msg_modify_001","session_id":"sess_xxx","language":"en-US","action":"modify_outline","payload":{"feedback":"结尾更温暖，不要惩罚同事"}}
```

确认大纲，流式生成正文：
```json
{"user_id":"user_001","message_id":"msg_confirm_001","session_id":"sess_xxx","language":"en-US","action":"confirm_outline"}
```

失败后重试生成（会话需为 GENERATION_FAILED）：
```json
{"user_id":"user_001","message_id":"msg_retry_001","session_id":"sess_xxx","language":"en-US","action":"retry_generation"}
```

后续动作仍使用会话原模型和温度，language 按当前请求。
幂等回放不翻译已存在的内容；不自动翻译历史小说。
查询会话：GET /api/novels/daily/conversation/sessions/sess_xxx?user_id=user_001

## 供应商连接测试

POST /api/novels/daily/conversation/provider-settings/test
```json
{
  "base_url": "https://api.example.com/v1",
  "api_key": "<PROVIDER_API_KEY>",
  "model": "deepseek-v4-flash",
  "thinking_mode": "disabled"
}
```

model 必填。base_url、api_key、thinking_mode 可省略，沿用当前服务端配置。
更换主机或端口时必须提供新 Key，防止旧密钥发送给新供应商。
thinking_mode: disabled、enabled、omit（不发送 thinking 字段）。
支持根地址和完整 /chat/completions 地址。

测试会发起一次真实但很短的非流式模型请求（max_tokens=32），可能消耗少量额度。
不会保存草稿配置、创建小说会话或返回供应商原始响应/密钥。
请求总超时20秒，连接超时5秒。测试通过表明地址、鉴权、模型和普通文本接口可用，
不等于完整验证长文本、SSE、安全审核和服务并发。

返回示例（已完成的测试返回 HTTP 200，成功与否看 ok）：
```json
{"ok":true,"code":"OK","message":"连接成功，模型已返回文本","elapsed_ms":1234,"upstream_status":200}
```

失败 code：INVALID_TEST_SETTINGS、PROVIDER_AUTH_FAILED、PROVIDER_NOT_FOUND、
PROVIDER_RATE_LIMITED、PROVIDER_HTTP_ERROR、PROVIDER_TIMEOUT、PROVIDER_INTERRUPTED、
PROVIDER_INVALID_RESPONSE、PROVIDER_CONNECTION_FAILED。
缺少或错误服务 Token 仍返回 HTTP 401。

## 保存供应商与提示词

PUT /api/novels/daily/conversation/provider-settings
```json
{"base_url":"https://api.example.com/v1","api_key":"<PROVIDER_API_KEY>","thinking_mode":"disabled"}
```
保存后全局生效，Key 不回显；留空保留当前 Key。测试不等同保存。
GET 同一路径读取 base_url、api_key_configured、thinking_mode。

PUT /api/novels/daily/conversation/debug-config
```json
{"language":"en-US","default_model":"deepseek-v4-flash","default_temperature":0.7,"prompts":{"novel_system":"Write an English short story of approximately 900 words based on the confirmed outline."}}
```
GET /api/novels/daily/conversation/debug-config?language=en-US
读取对应语言的默认模型、温度和六类提示词。


## 会话用户画像 user_profile（2026-09-13）

POST /api/novels/daily/conversation/stream 新增可选 user_profile，类型为 JSON 对象。
调用方可在首次请求、回答澄清或修改大纲时提供，服务保存到本次会话的 user_profile 字段；
省略或 null 保留原值，提供新对象整体替换，{} 清除外部画像内容。
对象序列化后最多16000字符，错误类型/超长返回 SSE error / INVALID_USER_PROFILE。
相同 message_id 的幂等重试不会重复替换画像。
查询会话响应新增 user_profile，旧会话为 null。

示例：
```json
{
  "user_id": "user_001",
  "message_id": "msg_profile_001",
  "query": "把我今天的项目挫折写成温暖的成长故事",
  "language": "zh-CN",
  "user_profile": {
    "age_range": "25-34",
    "occupation": "product designer",
    "personality_traits": ["thoughtful", "persistent"],
    "interests": ["photography", "travel"],
    "content_preferences": {
      "genre": "realistic workplace fiction",
      "tone": "warm",
      "ending": "positive"
    }
  }
}
```

生成和修改大纲时，英文提示词同时包含历史画像和本次传入画像。
优先级：本次明确需求/修改意见 > 调用方画像 > 历史画像；人物、场景、情绪转折和结尾按相关信息个性化。
该入参作为数据处理，不作为模型系统指令，不直接覆盖长期画像或关系图谱。
正文依据已确认大纲生成；若确认大纲时才传入新画像，不会自动重写已有大纲，
应先通过 modify_outline 生成新大纲再确认。
当前 language 仍只控制输出语言，画像字段值可以是中文或英文。
调试台新增“本次用户画像”JSON输入框，在新建会话时提交。
Flyway V7新增会话JSON列，不改变历史画像数据。


## 2026-09-13：请求级风控与中文提示词

最新业务请求说明以仓库 README“最新接口说明”为准。
新增 safety_enabled: true/false/null，按每次请求控制现有敏感词和QwenGuard链路。
true显式启用，即使服务端默认关闭；false跳过；省略/null使用当前服务端默认，不继承上个请求。
业务方应在开始、澄清答复、修改大纲、确认生成和重试动作中明确传递。
开关使用独立请求配置，不修改全局状态。已保存的屏蔽内容不会还原，幂等回放不重做模型审核。
风控关闭时不再展示“正在进行内容安全审核”的流程状态。

中文模式的澄清、大纲、修改大纲、正文及画像默认提示词均改为中文，用户提示词标签也按语言生成；
英文模式仍用英文。共享图谱抽取模板及英文关系编码不变。
Flyway V8先备份旧中文默认配置到novel_prompt_backup_v8，再切换中文模板；
自定义prompt_overrides及历史会话快照不自动翻译。
