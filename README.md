# 留岸 · Quiet Harbor

中文个人 AI 情绪支持网页，浏览器直接连接 DeepSeek 官方 API，无需部署服务端。

## 使用

打开 https://crystalxhorizon.github.io/quiet-harbor/ ，点击“连接与隐私”或右上角“本地体验”，填写自己的 DeepSeek API Key，勾选同意后点击“验证并连接”。密钥验证通过后即可聊天。未连接时明确标注为本地预设回复，不会冒充 AI。

固定聊天接口：`https://api.deepseek.com/chat/completions`；验证接口：`https://api.deepseek.com/models`；默认模型：`deepseek-flash`。验证模型列表不生成聊天内容；正常一轮对话通常调用三次 API，费用由你的 DeepSeek 账户承担。接口与模型依据 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/)。

## 隐私与边界

- API Key 默认仅在页面内存中保留。可选 AES-256-GCM 加密保存至此网站的 localStorage；使用随机 16 字节盐、12 字节 IV 和 PBKDF2-SHA256（600000 次）从用户解锁密码派生密钥。密码和明文 Key 不持久化。刷新或断开清除已解锁密钥，加密副本保留，点“忘记已保存密钥”才删除。忘记密码无法恢复，只能重新输入 API Key。解锁后的页面脚本或有权限的扩展仍可访问明文。聊天仍不持久化。
- 密钥只通过 HTTPS Authorization 请求头发送到 DeepSeek 官方域名，不会发送给 GitHub 或应用作者。网页中的脚本及有权限的浏览器扩展可能访问当前页面密钥；这是用户自带密钥的个人使用模式。
- 连接后，最近最多 12 条、总计 16000 字符的对话直接发给 DeepSeek。DeepSeek 可能按其政策保留请求；清空页面不能删除服务商记录，停止等待也不能撤回已发出的数据。
- 本应用不是治疗师、医疗器械或急救服务，不诊断、不承诺治愈。没有真人实时监测或自动报警。

## 浏览器 Harness

`public/harness.js` 实现输入校验、保守规则分流、单独的模型风险判断、固定陪伴提示、回答规则检查和单独的输出复核。通过检查后才显示完整回答，不显示未审查草稿。无效检查、截断和异常回复会暂停输出；网络、密钥、余额与限流问题显示明确提示。支持停止与超时取消。

禁止诊断、药物调整、催眠、恢复记忆、诱导身份切换、鼓励伤害和排他性依赖。提供可选感官提示与现实支持入口。检查可能误判或漏判，未经过临床验证。浏览器端规则可以被修改或绕过，不是服务端安全边界；刷新也会重置页面状态。本页面不承诺强制限流或账户费用上限。

这是自建的受限对话 Harness，不是 DeepSeek 官方编程代理 Harness。三次调用默认使用同一个模型，不等于独立临床判断。

## 开发与发布

需要 Node.js 24，无第三方运行时依赖。

```sh
npm start
npm run check
npm test
```

开发时打开 http://127.0.0.1:4173 。`server.mjs` 仅用于本地预览或可选的旧版后端；当前网页不调用其 API，不需要 `.env`、后台口令或服务器。共享 Harness 通过根目录 `harness.mjs` 重导出供旧版后端和测试使用。

推送 main 后，GitHub Actions 自动检查并将 `public/` 发布到 GitHub Pages。密钥不能写进任何源文件、公开仓库或工作流。前端资源使用相对路径，支持仓库子路径。

测试使用模拟 API，不产生真实费用；覆盖正常三阶段对话、危险请求分流、输出拦截、故障回退、上下文与角色校验、直连认证、错误提示和旧版后端隔离。没有真实 Key 时，不能验证付费模型的最终响应。

WebMCP 仅提供 `start_grounding({})` 打开感官提示，不提供读取或发送聊天的工具。

## 参考

- [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/zh-cn/)
- [NHS：解离相关困扰与专业支持](https://www.nhs.uk/mental-health/conditions/dissociative-disorders/)
- [OWASP：提示注入防范](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)

自然倾听规则包含倾诉、实际帮助、纠正误解、暂停和减少提问五种本轮提示；只接受枚举值，不能改变安全边界。正常对话仍为三次 API 请求。真实语言质量的验收案例见 [evals/conversation.md](evals/conversation.md)，自动化测试不代表真实模型语言质量或治疗效果。
