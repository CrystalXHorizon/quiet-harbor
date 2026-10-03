# 留岸 2.0：Supabase 部署步骤

当前支持 Supabase 托管项目。历史 RDS 单文件打包路径已停用，见 [停用说明](DEPLOY-RDS.md)。

此版本包含可部署的登录、社区、管理后台和服务端 AI。没有 Supabase 项目时，页面明确显示“尚未配置”，只能使用本地体验和练习；这不代表云端已经上线。

## 1. 本地检查

使用 Node.js 24：

```sh
npm ci
npm run check
npm test
npm run build
npm run preview
```

打开终端显示的地址。`dist/` 是构建产物；不要直接发布含未打包模块的 `public/`。
测试使用模拟服务和本地 PostgreSQL 引擎，不产生真实 AI 调用费用。

浏览器回归执行 `npx playwright install chromium` 和 `npm run test:browser`，脚本自动构建、启动和关闭预览，使用固定测试夹具。CI 会安装 Chromium 并运行相同检查。截图保存在 `test-results/browser/`。

## 2. 创建 Supabase 项目

在自己的 Supabase 账号下创建项目。记录 Project URL 和 publishable key（旧项目也可使用 anon key）。这两个值可以公开；`service_role`、`sb_secret_`、数据库密码及 AI API Key 都不能放进前端或 Git 仓库。

Auth 配置：

- Site URL 填正式网页地址 `https://crystalxhorizon.github.io/quiet-harbor/`。
- Redirect URLs 添加正式网页地址和密码恢复地址 `https://crystalxhorizon.github.io/quiet-harbor/?account=recovery`；本地测试时另加 `http://127.0.0.1:4177/` 及 `http://127.0.0.1:4177/?account=recovery`。不要配置任意域名通配跳转。
- 先应用全部数据库迁移、部署 API，再开启 Supabase Auth 的邮箱注册。新账户默认待审批：验证邮箱后提交申请，由站长或管理员审批；也可以兑换站长签发的有效邀请码免审批。邮箱验证仍然必需，邀请码不授予管理员权限。
- 启用邮箱确认，配置发送验证、邀请、找回密码邮件的 SMTP。先测试实际收信及重置密码流程，再开放用户使用。
- 启用 TOTP MFA。已绑定验证器的账户，密码登录后必须完成二次验证才能读取应用数据；所有管理读写接口都要求二次验证，包括队列、申请、用户、审计、AI 设置和用量。尚未绑定的管理员可先进入账户安全设置验证器。

官方说明：[Auth](https://supabase.com/docs/guides/auth)、[SMTP](https://supabase.com/docs/guides/auth/auth-smtp)、[MFA](https://supabase.com/docs/guides/auth/auth-mfa)。

## 3. 应用数据库迁移

安装/使用 Supabase CLI，在仓库目录运行：

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

确认目标是自己的新项目。迁移创建 `qh_` 前缀的业务表，不使用现有其他应用的数据表；如果目标项目已有同名表，应先核对迁移历史，不要强行覆盖。

业务表开启 RLS，并撤销浏览器角色直接访问及执行内部 RPC 的权限。网页只能调用验证账户身份的 `api` 函数；普通用户无法用 SDK 直接更改角色、审核结果或密钥。

### 从旧版升级申请制

已有数据库仅执行尚未应用的 `202610010002_admission.sql`，不要重新执行初始建表脚本。随后更新 Edge Function，再发布前端，最后允许 Auth 邮箱注册。升级使用新增的迁移文件，不执行历史完整初始化脚本。

升级前已有账户保持已批准；新账户默认待审批。用户验证邮箱、登录后，在“我的账户”提交简短申请，或兑换邀请码。待审批账户不能读取社区或调用 AI。站长与管理员在后台审批，站长管理邀请码；管理修改操作需要二次验证。邀请码只免人工审批，不免邮箱验证，也不会解除封禁或授予管理角色。

邀请码原文只在创建时显示一次，数据库保存哈希。请私下交给预期使用者；到期、停用或次数耗尽后不可兑换。申请理由只需描述使用意图，无需提供诊断或个人经历。

公开接受申请前必须配置并验证邮件服务。Supabase 默认邮件服务可能仅向项目组织成员发送，不能作为公共注册投产依据；没有可用 SMTP 时，普通访客可能收不到验证邮件。不要通过关闭邮箱验证来绕过这个问题。

## 4. 设置服务端密钥并部署函数

在 Supabase 的 Edge Functions Secrets 中设置：

| 名称 | 用途 |
|---|---|
| `ALLOWED_ORIGINS` | 允许的网页来源，例如 `https://crystalxhorizon.github.io`；本地联调可另加 `http://127.0.0.1:4177`，逗号分隔，不含仓库路径 |
| `AI_ENCRYPTION_KEY` | 32 个随机字节的标准 Base64 编码；只存服务端，用于加密供应商 API Key |
| `AI_ALLOWED_HOSTS` | 自定义供应商的可信域名，逗号分隔、使用小写、不含协议/路径/通配符；标准预设有内置允许列表 |

`SUPABASE_URL` 和服务端 Supabase 凭据由运行环境提供，具体变量参见 `supabase/functions/api/index.ts`。不要把这些服务端变量添加为 `PUBLIC_` 开头的前端变量。

在自己的终端生成主密钥，然后直接填入 Secrets；不要把输出发送到聊天或保存到仓库：

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

也可以把 `supabase/.env.example` 复制为被 Git 忽略的 `supabase/.env.local`，在本机填好以上值后执行 `npx supabase secrets set --env-file supabase/.env.local`。旧版根目录服务器与个人 AI Key 配置已经移除。

```sh
npx supabase functions deploy api
```

函数始终验证用户身份；即使部署配置将平台的 `verify_jwt` 关闭以兼容新版 JWT，也不能删除函数内部对 Supabase Auth 的验证。核对仓库 `supabase/config.toml`，不要使用额外的匿名开放代理。

供应商地址只能落在预设或部署允许列表中；不接受浏览器传入的聊天目标。请求不跟随重定向，AI Key 不会返回给用户。主密钥应保存在自己的密码管理器或安全备份中；丢失后需要重新录入供应商 Key。变更主密钥前先处理旧配置的解密与重新加密。

自定义域名允许列表代表部署者对该服务的信任。只添加可信的公网 AI 服务域名，不添加用户可控制的域名或内网地址；域名检查不能保证阻止所有 DNS 重绑定。使用自定义服务且需要更强隔离时，应另外配置服务端出站网络约束。

## 5. 配置前端并发布

本地可以修改 `public/site-config.json` 的公开配置，然后重新构建。正式 GitHub Pages 在仓库 **Settings → Secrets and variables → Actions → Variables** 设置：

- `PUBLIC_SUPABASE_URL`：项目的 HTTPS URL。
- `PUBLIC_SUPABASE_ANON_KEY`：publishable key 或 anon key。不能填写 service_role / secret key / AI Key。

构建会拒绝 service_role JWT 和 `sb_secret_` 私钥。GitHub Actions 只在 `main` 且前两项配置齐全时发布；功能分支只检查代码并生成预览构建包。

先在测试环境验证，再通过 `main` 部署后端和前端。Pages 发布会检查后端健康接口返回的提交与本次提交相同；先完成后端工作流，再重新运行 Pages 工作流。

## 6. 初始化站长

确认第 5 步的新前端已可访问，再通过邮箱注册并验证自己的账户，或使用下述 token_hash 模板邀请自己的邮箱。邀请确认只完成邮箱验证和资料设置，密码通过“找回密码”流程设置。不要把邀请发往尚无新版登录功能的旧页面；已有过期邀请应重新发送。复制该账户的真实 User UID，在 Supabase SQL Editor 执行：

```sql
update public.qh_profiles
set role = 'owner', admission_status = 'approved'
where id = 'REPLACE_WITH_YOUR_ACTUAL_AUTH_USER_UUID';
```

确认只更新一行；不要按“第一个注册的人”自动授予权限。之后在留岸“我的账户”中绑定验证器，完成六位验证码验证，再进入管理后台配置 AI。

站长只能有一个，网页不提供将自己降权或封禁的入口。若验证器丢失，由项目持有者通过 Supabase 官方账户管理恢复，不提供公开后门。

## 7. 管理员填写 AI

站长完成 MFA 后，进入管理后台 AI 设置，选择供应商、模型和接口地址，输入供应商 API Key，先测试再保存启用。保存后只显示已配置状态和末四位，不显示明文密钥。

聊天、社区审核和连接测试共享配额，每次供应商请求前原子预留一次调用。Harness 每轮通常最多三次，逐次检查余额；额度不足时不发送下一次请求，未复核草稿不会展示，危机与边界仍有固定安全兜底。失败或取消也消耗已预留的调用额度。每日额度按 UTC 重置；它是调用次数限制，不是服务商实际账单金额的精确上限。可在后台设置单用户和全站每日额度，紧急时关闭 AI。

## 8. 上线验收

- 用两个普通账号验证：看不到彼此的草稿；不能编辑或删除他人的帖子；未审核内容不会出现在社区。
- 包括站长在内的帖子、评论提交后均进入 AI 审核，通过后发布；不确定、模型异常及额度耗尽保留待人工复核。其他管理员不能审核自己的内容；站长人工处理本人内容需要 MFA 和理由。
- 修改已发布帖子后，访客仍看到旧的已审核版本，直到新版本通过。
- 普通用户调用管理接口、伪造角色、直接读取数据库表或修改审核结果，都应失败。
- 社区管理员不能读取 AI 密钥、修改站长或授予角色。禁言与封禁由后端执行。
- 管理员未完成 MFA 时，所有管理读写接口都应失败。
- 检查浏览器网络与响应：没有供应商 Key；聊天只发到本站后台；退出后未完成请求不能继续显示旧账户数据。
- 测试邮箱邀请、确认、密码找回，以及验证器登录。测试真实模型时会使用供应商额度。
- 备份数据库，明确帖子、举报、操作记录的保留策略；默认没有 AI 聊天内容表，模型供应商仍可能按其政策保留请求。

GitHub 的 MIT / CC BY-SA 授权只覆盖项目自身材料。用户帖子不自动采用仓库许可，发布页面告知内容会进入社区及审核流程。

## 当前边界

本版提供社区收藏与屏蔽管理，不提供私信、通知推送或云端聊天同步。社区采用 AI 审核与人工复核，没有真人实时监测或自动救援。尚未配置真实 Supabase 时，不能把本地测试描述成云端部署验收。

## AI 审核升级

审计整改新增 `202610030004_audit_remediation.sql`，在既有个人中心迁移之后执行。它统一管理读取 MFA、模型调用配额、分页、内容抹除、外键与保留清理；部署顺序为备份 → dry-run → 新迁移 → 同提交 Edge → 邮件模板 → 同提交前端。旧迁移不改写。

若历史项目通过 SQL Editor 手动应用迁移、没有 `supabase_migrations.schema_migrations`，先对照生产结构、函数、约束、索引和触发器与历史迁移确认完全一致，再登记基线。无法建立数据库端口连接时，可以使用 Supabase CLI 2.119.0 的 `db query --linked --project-ref … --file …` 管理 API 通路，在同一事务中应用新增迁移并登记版本；不要把完整历史初始化脚本重跑到已有数据库。上线前必须保留一致的数据/结构备份并在克隆中演练。

审核申诉的一键处理升级使用 `202610030001_integrated_resolution.sql`。管理员可通过申诉并恢复帖子或回应，同时结案；举报下架与结案也在同一事务中完成。权限、MFA 与操作说明仍由后端检查，内容变更后不能使用旧申诉直接恢复新版或私密草稿。

现有已应用 `202610020002_owner_publish.sql` 的项目，只需应用新增的 `202610020003_ai_moderation.sql`，随后部署最新版 `api` 函数，最后发布前端。不要在生产项目重复执行旧版完整初始化脚本。

社区条例位于 `community-rules.html`，规则版本为 `2026-10-03-v2`。发帖、回复及提交修改使用当前启用的 AI 供应商和服务端密钥。后台“审核模型”留空时沿用聊天模型；指定时必须是同一供应商支持的模型。连接测试只验证聊天模型，不能证明审核模型已可用。

审核只发送本次提交与必要的社区上下文，不发送私人 AI 对话或账户资料。请求失败、无可用配置、格式异常或判断不明时不自动发布，管理员可在审核队列处理。审核快照在保留期内不可变；删除对应内容时立即抹除，30 天后清空正文和上下文。旧版本结果不能覆盖新编辑、删除或人工决定。AI 不自动封禁账户。

## 邮件链接升级

浏览器拒绝包含 access_token/refresh_token 的隐式片段。站内发起的邮箱验证和密码恢复使用 PKCE，应在发起请求的浏览器里打开邮件。邀请与跨浏览器恢复可在 Supabase 邮件模板使用如下链接（type 按模板改为 invite / recovery / signup / magiclink）：

`{{ .SiteURL }}?token_hash={{ .TokenHash }}&type=invite`

仓库内四种邮件正文位于 `supabase/templates/`，`supabase/config.toml` 指向对应文件。`supabase config diff` 仅展示可比较的配置字段；`supabase config push` 会读取并上传邮件正文。生产注册开放前先确认自定义 SMTP 可投递，保留邮箱验证；受邀使用阶段可以暂时关闭生产注册。

模板链接应直接指向正式根路径（带 quiet-harbor/），不要先跳到 Auth 的默认 verify URL 再生成片段。页面先显示明确确认，确认后调用 verifyOtp；邀请不会自动渲染设置密码。真实邀请、验证和恢复邮件必须在测试项目验收后再上线，旧片段邮件需重新发送。

## 可追溯部署与数据保留

在 GitHub 的 backend-production 环境设置 Secrets SUPABASE_ACCESS_TOKEN、SUPABASE_DB_PASSWORD，以及 Variables SUPABASE_PROJECT_REF、PUBLIC_SUPABASE_URL、PUBLIC_SITE_ORIGIN。手动触发 backend 工作流；它先运行 SQL/浏览器/语法/Deno 检查，再迁移和部署，将源提交与 UTC 构建时间写入 Edge。GET /functions/v1/api/health 只返回提交、时间和 schema 版本，不含账户或配置。工作流保存函数版本列表和部署验收记录。Pages 只有在后端提交匹配时才发布。

启用 pg_cron 的项目由迁移安装每日 02:17 UTC 的清理任务；未启用时请启用该扩展并添加同一任务，或用服务端调度每天执行 select public.qh_cleanup()。API 访问也会触发每日一次的兜底清理，但不能代替无人访问时的定时任务。审核正文/上下文与举报申诉快照保留 30 天，用量/通知 90 天，操作记录 180 天。已超过保留期的未完成审核失效，过期申诉快照不能用于一键恢复。

删除帖子和回应会抹除正文、修订与关联审核记录；站长可在用户管理中依据用户请求永久抹除账户。账户抹除保留日配额的全站已用总数，防止删除重建绕过当日额度。备份中的数据由备份期限控制：上线前配置自动备份最多 30 天，并登记删除请求，恢复备份后重新执行抹除；若供应商套餐无法满足该期限，应在社区条例明确实际期限再开放使用。

构建生成 dist/security-headers.json 与 dist/_headers，预览服务下发 frame-ancestors 'none' 与 X-Frame-Options: DENY。GitHub Pages 不支持这类响应头文件，需要代理或其他主机才能提供响应头级保护；前端嵌入检查仅作为补充。Docker 构建需要传入公开参数 PUBLIC_SUPABASE_URL、PUBLIC_SUPABASE_ANON_KEY；AI Key 与服务端凭据仍仅放 Supabase Secrets。
