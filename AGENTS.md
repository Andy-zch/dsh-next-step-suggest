L2 模块地图
next-step-suggest/
L2 | 父级: ../AGENTS.md

本目录是一个 DSH bundle 包，同时是一个开源仓库的根（`Andy-zch/dsh-next-step-suggest`）。`package.json` 的 `dsh` 字段既是 host 插件清单也是 client 插件清单，`cordis.patch.yml` 决定它在 profile 的 Loader 树里长在哪一行。当前版本 0.4.1，包名 `dsh-next-step-suggest`。

成员清单

package.json: bundle 清单与 npm 元数据；声明 `dsh.bundle.patch` 与 `dsh.client`（platform=web、immediately、inject ui-conversation 保序），另含 license/repository/homepage/bugs/keywords
cordis.patch.yml: Loader patch，insert 一行 `next-step-suggest`，name 必须是包名 `dsh-next-step-suggest`；该行的 `config:` 是本插件的唯一配置入口
index.js: Host 半边，导出 `apply(ctx, config)`；注册 `POST /api/next-step` 与 `/api/next-step/stats`；先跑规则（`ruleCandidate`：进行中待办 > 待办 > 激活计划，语言由 `detectLanguage` 判定），未命中才组装 `<transcript>` + `<context>` 问模型；提示词问「下一步该推进什么」；默认 1 条候选，撞车重试一次，纯虚词由 `isVacuous()` 丢弃，按 `(sessionId, seq)` 缓存 5 分钟，失败静默
client.js: Client 半边，向 `conversation.input.overlay` 注册 `next-step-ghost`；单条灰字投影、`Tab` 接受、`Esc` 本回合闭嘴、**条件式触发**（空闲 + `draft.trim()` 为空 + 输入机非 adjudicating/submitting + 无在显建议）+ 四道闸门、延迟 1.2 秒浮现、同卡片归属判定、会话隔离、跳闸原因写 `[next-step] skip:`、`role=status` 播报、show/accept/dismiss 上报 stats
locale/en.json: 英文 `meta.title` 与 `meta.description`，插件页读取
locale/zh.json: 中文同上，跟随 locale 偏好 `zh`
icon.svg: 原创图标（键帽 + 方向箭头 + 三点），插件页与插件行使用
README.md: 英文主说明，GitHub 首页；含触发条件、配置、设计说明、已知限制
README.zh.md: 中文说明，给中文用户
CHANGELOG.md: Keep a Changelog 格式的版本变更记录，0.1.0 → 0.4.1
LICENSE: MIT

约束

- 两侧文件头部必须带 L3 四行契约，改动后同步本文件。
- 配置不经过 schemastery：link 安装的包解析不到 profile 的 peer，`apply(ctx, config)` 直接接收行配置，由 `resolveSettings()` 收口。不要在 package.json 里加 schemastery 依赖。
- `client.js` 只能在 `apply(ctx)` 里注册资源；组件内不得写宿主 DOM。对 `[data-composer-placeholder]` 只做读取与 CSS 遮蔽，且遮蔽规则仅在单 composer 时注入。
- 键位仲裁必须同时满足：灰字可见、目标可编辑、`sharesCard(root, target)` 为真、非输入法组合态。少一个就会双写或抢键。
- 任何异步结果落地前必须校验 `sessionIdRef.current`：归属不符就整段丢弃，包括日志与频率计数。换会话的 effect 要先 abort 在飞请求并清掉待显示定时器。
- 频率常量集中在 `client.js` 顶部（`RETRY_GAP_MS` / `MIN_INTERVAL_MS` / `MAX_PER_SESSION` / `DISMISS_STREAK_LIMIT` / `ACCEPT_COOLDOWN_MS` / `SHOW_DELAY_MS`）；调频率只改常量，不动结构。
- 触发必须是**条件式**且幂等：空闲 + 草稿空 + 无在显建议 + 未到闸门 → 请求。不要改回「回合结束边沿」。
- 草稿判空一律用 `draft.trim() === ''`；输入机忙碌只认 `phase === 'adjudicating' || phase === 'submitting'`。
- 任何新增文件先加进本清单，再加进 `package.json` 的 `files`；改版本必须同时改 `CHANGELOG.md`。
- 改完代码要 `remove_bundle` + `install_bundle`：宿主模块有 ESM 缓存，刷新页面只换客户端。
- 开源相关：`*.log` 不进版本库（`.gitignore` 已覆盖）。0.4.1 起插件不再写任何文件；不要再引入诊断落盘通道，排障靠 console 的 `[next-step] skip:`。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
