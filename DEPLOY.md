# 留岸 2.0：Supabase 部署步骤

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

可选的浏览器联调脚本是 `node scripts/browser-check.cjs`，运行前启动预览并在本机准备 Playwright 与 Chromium。脚本可通过 `PLAYWRIGHT_MODULE` 指向已安装的 Playwright 模块，通过 `PLAYWRIGHT_CHANNEL=msedge` 使用已安装的 Edge。它只在测试中拦截请求，不会创建真实用户或帖子；截图保存在 `test-results/browser/`。

## 2. 创建 Supabase 项目

在自己的 Supabase 账号下创建项目。记录 Project URL 和 publishable key（旧项目也可使用 anon key）。这两个值可以公开；`service_role`、`sb_secret_`、数据库密码及 AI API Key 都不能放进前端或 Git 仓库。

Auth 配置：

- Site URL 填正式网页地址 `https://crystalxhorizon.github.io/quiet-harbor/`。
- Redirect URLs 添加正式网页地址；本地测试时另加 `http://127.0.0.1:4177/`。不要配置任意域名通配跳转。
- 首版建议关闭公开注册，通过 Auth 用户管理发送邀请。前端的 `inviteOnly` 仅控制注册入口，真正的注册限制在 Supabase Auth 中设置。
- 启用邮箱确认，配置发送验证、邀请、找回密码邮件的 SMTP。先测试实际收信及重置密码流程，再开放用户使用。
- 启用 TOTP MFA。已绑定验证器的账户，密码登录后必须完成二次验证才能读取应用数据；审核、禁言、封禁、修改 AI 设置及角色等管理修改操作始终要求二次验证。

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

也可以把 `supabase/.env.example` 复制为被 Git 忽略的 `supabase/.env.local`，在本机填好以上值后执行 `npx supabase secrets set --env-file supabase/.env.local`。根目录的 `.env.example` 属于旧版服务器，新版不使用其中的 `APP_ACCESS_TOKEN` 或个人 AI Key 配置。

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
- `PUBLIC_INVITE_ONLY`：`true`（默认）或 `false`。开放注册时同时修改 Supabase Auth 注册策略。

构建会拒绝 service_role JWT 和 `sb_secret_` 私钥。GitHub Actions 只在 `main` 且前两项配置齐全时发布；功能分支只检查代码并生成预览构建包。

先在测试环境验证，再将 `feature/community-backend` 合并到 `main`。数据库和函数先就绪，最后切换前端；不要让正式前端先进入无法登录的状态。

## 6. 初始化站长

确认第 5 步的新前端已可访问，再在 Auth 用户管理邀请自己的邮箱，完成邀请链接的账户设置。不要把邀请发往尚无新版登录功能的旧页面；已有过期邀请应重新发送。复制该账户的真实 User UID，在 Supabase SQL Editor 执行：

```sql
update public.qh_profiles
set role = 'owner'
where id = 'REPLACE_WITH_YOUR_ACTUAL_AUTH_USER_UUID';
```

确认只更新一行；不要按“第一个注册的人”自动授予权限。之后在留岸“我的账户”中绑定验证器，完成六位验证码验证，再进入管理后台配置 AI。

站长只能有一个，网页不提供将自己降权或封禁的入口。若验证器丢失，由项目持有者通过 Supabase 官方账户管理恢复，不提供公开后门。

## 7. 管理员填写 AI

站长完成 MFA 后，进入管理后台 AI 设置，选择供应商、模型和接口地址，输入供应商 API Key，先测试再保存启用。保存后只显示已配置状态和末四位，不显示明文密钥。

每个 AI 对话请求先原子扣除一轮额度，再运行 Harness（通常最多三次模型请求）。失败或取消也消耗本轮额度，避免重试绕过限制。每日额度按 UTC 重置；它是调用次数限制，不是服务商实际账单金额的精确上限。可在后台设置单用户和全站每日额度，紧急时关闭 AI。

## 8. 上线验收

- 用两个普通账号验证：看不到彼此的草稿；不能编辑或删除他人的帖子；未审核内容不会出现在社区。
- 帖子、评论提交后由另一管理员审核；禁止审核自己的内容，因此站长要发布帖子时也需要邀请另一位管理员。
- 修改已发布帖子后，访客仍看到旧的已审核版本，直到新版本通过。
- 普通用户调用管理接口、伪造角色、直接读取数据库表或修改审核结果，都应失败。
- 社区管理员不能读取 AI 密钥、修改站长或授予角色。禁言与封禁由后端执行。
- 管理员未完成 MFA 时，审核、账户处置、AI 配置和角色变更等修改应失败。
- 检查浏览器网络与响应：没有供应商 Key；聊天只发到本站后台；退出后未完成请求不能继续显示旧账户数据。
- 测试邮箱邀请、确认、密码找回，以及验证器登录。测试真实模型时会使用供应商额度。
- 备份数据库，明确帖子、举报、操作记录的保留策略；默认没有 AI 聊天内容表，模型供应商仍可能按其政策保留请求。

GitHub 的 MIT / CC BY-SA 授权只覆盖项目自身材料。用户帖子不自动采用仓库许可，发布页面告知内容会进入社区及审核流程。

## 当前边界

本版提供社区收藏与屏蔽管理，不提供私信、通知推送或云端聊天同步。社区审核由管理员处理，没有真人实时监测或自动救援。尚未配置真实 Supabase 时，不能把本地测试描述成云端部署验收。
