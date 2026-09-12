# 留岸 · Quiet Harbor

中文个人 AI 情绪支持网页，使用 DeepSeek 和可测试的对话 Harness。提供聊天、可选感官锚定、随时停止、清空对话、现实支持提示。未连接服务端时，明确显示“本地预设回复”，不会冒充 AI。

这是情绪支持软件，不是医疗器械、治疗师或急救服务，不诊断、不承诺治疗解离相关障碍。安全机制可能误判或漏判，尚未经临床验证。

## 本地运行

需要 Node.js 22.9+（推荐 24），无第三方运行时依赖。

```powershell
Copy-Item .env.example .env
npm start
```

打开 http://127.0.0.1:4173。未配置密钥即可使用本地体验及感官提示。要使用 DeepSeek，在本机 `.env` 中填写 `AI_API_KEY`，并设置随机的 `APP_ACCESS_TOKEN`（至少 32 字符）。不要把密钥发送到聊天或写入公开文件。可在本机运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成口令。

在网页“连接与隐私”填写服务端根地址和**个人访问口令**，勾选同意发送对话，点击验证并连接。网页不接收模型 API 密钥。连接和断开会清空旧对话，避免把本地体验内容意外发给服务商。

默认接口 `https://api.deepseek.com/chat/completions`，模型 `deepseek-flash`，以 2026-09-12 的 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/)为依据；可通过服务端环境变量更换模型。开启非思考模式，输入与输出审核使用 JSON output，正式回复非流式，完整复核后才显示。

## Harness

1. 严格校验角色、长度、条数；拒绝浏览器指定系统提示或工具。
2. 本地保守规则优先拦截明确风险；否则进行单独的模型输入风险判断。
3. 固定 system 提示，限制为最多 12 条、总计 16000 字符的上下文。不提供执行代码、读写文件、网络检索等工具。
4. 回答先经过规则检查，再经过另一独立 API 调用复核；只接受布尔 `safe: true`。任何超时、无效 JSON、截断、审查失败都会回退到预设支持提示，不泄露未审核草稿。
5. 每分钟最多 12 次、同时最多 2 次、UTC 每天最多 200 次请求；90 秒服务端总超时，支持取消。不自动重试产生额外费用。

这是受限对话编排与安全 Harness，不是 DeepSeek 官方编程代理 Harness 的集成。正常一轮会调用三次 API，分别用于输入检查、生成和输出检查。检查模型默认与对话模型相同，可用 `AI_SAFETY_MODEL` 指定其他兼容模型；这不等于独立临床判断。规则检查保守，可能误触发；模型检查也可能被绕过。测试不能证明临床安全或治疗效果。

进程内计数在服务重启时重置，不适用于多实例共享限流。公开可访问的后端应保持单实例，并在托管平台设置费用上限和外部速率限制。这里面向个人使用，非多用户服务。

## 隐私

- 聊天、连接地址、访问口令只在当前页面内存中保留。无 localStorage、IndexedDB、Cookies、统计脚本或外部字体。刷新清空。
- 服务端不记录聊天、API 密钥或模型回答；只在请求处理期间持有内容。静态服务仅公开白名单资源，无法读取 `.env`、源代码或 Git 配置。
- 连接 AI 后，最近部分对话会发送给所配置的服务端及 DeepSeek。服务商可能按其政策保留请求，清空页面不能删除服务商的记录；托管平台也可能保留访问元数据。
- 取消请求无法撤回已经传出的数据，也不保证服务商停止计算或计费。
- 公开源代码不包含任何人的病史、真实聊天或模型密钥。GitHub Pages 前端是公开页面，个人 API 通过独立口令保护。

## GitHub Pages 上线

推送 `main` 到自己的仓库，在 Settings → Pages → Source 选择 **GitHub Actions**。仓库内的工作流会执行语法检查、Harness 测试，然后仅将 `public/` 目录发布到 Pages。资源使用相对路径，支持仓库子路径。

**GitHub Pages 只能部署静态前端，不能运行 DeepSeek 服务端。** 前端即使已上线，也只提供本地体验，直到你连接已部署的服务端。

后端可在支持 Node 24 或 Docker 的服务器部署。仓库提供 Dockerfile；将 `.env.example` 对应值配置为平台环境变量，容器不要包含 `.env`。公开托管设置 `HOST=0.0.0.0`，平台提供 HTTPS，`ALLOWED_ORIGINS` 设为实际 Pages 的 origin（如 `https://crystalxhorizon.github.io`，不带仓库路径）。单个 Node 服务也能同时托管网页和 API。

```sh
docker build -t quiet-harbor .
docker run --env-file .env -p 4173:4173 quiet-harbor
```

若本机 `.env` 设置了 `HOST=127.0.0.1`，容器运行时加 `-e HOST=0.0.0.0`。不要把宿主机端口直接暴露为无 HTTPS 的公网服务。托管平台配置 HTTPS 后，在网页里连接其 HTTPS 根地址。

## 验证

```sh
npm run check
npm test
```

测试使用模拟服务商，无实际 AI 调用或费用；涵盖风险分流、输出拦截、故障回退、角色注入、上下文限制、身份验证、CORS、静态密钥隔离与限流。真实服务商行为与成本需要配置密钥后另行验证。

浏览器支持 WebMCP 时，仅提供 `start_grounding({})` 来打开界面中的感官提示，不暴露读聊天或发聊天工具。不支持 WebMCP 的浏览器仍可正常使用所有按钮。

## 参考

- [NHS：解离相关障碍与专业支持](https://www.nhs.uk/mental-health/conditions/dissociative-disorders/)
- [OWASP：提示注入防范](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
