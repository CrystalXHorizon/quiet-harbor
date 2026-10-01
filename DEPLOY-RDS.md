# 留岸：阿里云 RDS Supabase 部署

此部署使用同一套业务代码；云端兼容性须按本文验收后确认。阿里云实例不能直接使用托管 Supabase 的 `supabase link` / `db push` 流程。

## 1. 开通测试项目

当前准备配置：项目 `quiet-harbor`、杭州、PostgreSQL 18、高可用通用型 2 核 4G、50GB、1个月，勾选 Supabase 和沙箱与边缘函数。账户页面显示首月试用合计0元，自动续费关闭；以最终订单为准，试用结束前重新核对续费价格。

由项目持有者确认三项服务关联角色授权，并在阿里云页面亲自设置 Dashboard 密码和数据库密码。密码不要放入仓库或聊天。开通完成后等待实例运行。

## 2. 配置 HTTPS 与访问范围

RDS 默认提供 HTTP 地址。正式网页需要浏览器信任的 HTTPS 地址，必须先配置与后端地址匹配的 CA 证书，再填写前端配置。使用自己的域名时，先核对 DNS、证书和服务路由是否支持该域名。不要发布自签名证书地址，也不要把凭据通过 HTTP 发送。

核对 RDS Supabase 的访问白名单是否同时影响公共应用 API 与管理页面。管理入口及数据库只允许实际需要的来源；若平台无法分别限制管理入口和公共 API，应先解决访问隔离，再开放社区。不要照抄 `0.0.0.0/0` 到数据库或管理入口。

## 3. 准备部署文件

```sh
npm run build:rds
```

生成被 Git 忽略的 `.supabase/rds-deploy/`：

- `quiet-harbor.sql`：在新项目的 SQL Editor 执行完整数据库迁移。先检查没有其他应用的同名 `qh_` 表；执行失败时检查错误，不强行覆盖。
- `api.ts`：已打包的单文件 Deno 函数，不依赖本地相对导入，适用于阿里云 Agent Runtime 的网页代码编辑器。名称设为 `api`。

这些文件不含凭据，也不会被前端 `dist/` 发布。

## 4. 服务端函数

在实例“沙箱和边缘函数”查看 Agent Runtime 地址。使用已配置的 HTTPS 入口，在 Functions 新建名为 `api` 的函数，粘贴 `api.ts` 内容。

在 Secrets 核对平台提供的 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。`SUPABASE_URL` 必须能从函数访问 Auth 和 REST API，并且对应同一实例。不要把 Service Key 放入前端。

增加 `ALLOWED_ORIGINS=https://crystalxhorizon.github.io`，以及32字节随机值标准 Base64 编码的 `AI_ENCRYPTION_KEY`。生成与备份方式参见 [DEPLOY.md](DEPLOY.md)。自定义供应商需要时再配置 `AI_ALLOWED_HOSTS`。

先保留平台默认的 JWT 验证，核对它是否接受用户访问令牌；如平台与签名算法不兼容，再经项目持有者确认调整网关设置。函数内部通过 Auth 验证每个访问令牌的逻辑必须保留。

## 5. 接入与验收

按 [DEPLOY.md](DEPLOY.md) 设置 Auth 的站点、精确跳转地址、邀请策略、邮件 SMTP、TOTP MFA，并初始化真实用户 UUID 的 owner。阿里云控制台的 Dashboard 密码与留岸用户账户密码不同。

前端仅配置公开的 HTTPS 项目 URL 和 Anon Key。先在本地或测试页验证：

1. SDK 的 `/auth/v1`、`/rest/v1` 和 `/functions/v1/api` 路由可达，CORS 与证书正常。
2. 邮件邀请、确认、找回密码、TOTP 绑定与二次验证可用。
3. 迁移中的用户触发器、RPC、RLS 与 `service_role` 权限生效；用户不能直接读取业务表或内部 RPC。
4. 部署后的 `api` 函数拒绝未登录请求，管理修改拒绝缺少 AAL2 的请求；两账户隔离及审核流程通过。
5. 站长在后台填写供应商 Key，完整 Harness 在实际运行时限制内完成；浏览器只调用本站后端，响应不含密钥。

全部通过后再合并并切换正式 GitHub Pages。当前代码检查与模拟测试不等于阿里云实机验收。

## 官方参考

- [RDS Supabase](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/supabase/)
- [边缘函数与 Secrets](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/using-sandboxes-and-edge-functions)
- [配置 SSL 与 HTTPS](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/configure-ssl-and-enable-https-access-for-rds-supabase)
