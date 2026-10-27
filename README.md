# dsh-mnemon-diary

为 [DSH](https://github.com/deepseek-ai) 的 `dsh-mnemon` 增加「每日日记 + 重要记忆筛选 + 草稿审阅」的伴生插件。

## 三步上手（第一次用）

0. **确认有记忆插件**：本插件不存记忆，必须有 `dsh-mnemon`（没装的话打开设置页会弹窗提示，附 npm 与源码链接；装完重启再点「重新检测」）
1. **装**：依赖里加 `"dsh-mnemon-diary": "github:shargritton/dsh-mnemon-diary"`，`dsh.profile.bundles` 里加 `dsh-mnemon-diary`，`pnpm install`，重启 DSH
2. **生成**：设置 → 插件设置 →「每日日记」→ 展开 → 点「立即生成」（一次同时生成日记和「我是谁」）
3. **入库**：草稿列表里点「上传记忆」；想让它每天自己跑，把「固定生成时间」设好、开「日记草稿自动上传记忆」

> 装完什么都不改也能用：默认每天生成一次、日记进文档库、快照只在上下文快满时生成。
> 插件启动会自动备好「体检 skill」，首次打开设置页会自动建好月度体检任务。


- 不改动 `dsh-mnemon` 源码，通过它的 **文档库磁盘契约**（`~/.mnemon/documents`）写入
- 选材、提炼、草稿、审阅、归档、日记本等逻辑与原 `dsh-prime-diary` 保持一致
- 与原版唯一区别：**落库目标从 prime 的 `l1_records` 换成了 mnemon 的 Documents**

## 前置依赖：dsh-mnemon

这个插件不自己存记忆，日记和提炼出的条目最终都写进 **mnemon 的文档库**：

| 位置 | 说明 |
| --- | --- |
| `~/.mnemon/documents/index.json` | 文档索引（唯一真相），本插件会维护它 |
| `~/.mnemon/documents/active/<slug>-<id8>.md` | 日记正文 + YAML frontmatter |

写入方式遵守 mnemon 自己的约定：

- 独占 `.index.lock`（超过 30s 视为残留可抢），拿锁 → 读索引 → 原子写正文 + 原子写索引 → 放锁
- 正文 frontmatter 与 mnemon `renderDocument()` 逐字节同格式，`sizeBytes` 取渲染后 UTF-8 字节数
- 按 **标题** 幂等：同一天只维护一份 `日记 <日期>`，内容没变就什么都不写
- 每次写入前把旧索引备份到 `$DSH_HOME/mnemon-diary/backups/index-<ts>.json`
- 写入失败时草稿不会丢，`pending-write` 载荷留在 `$DSH_HOME/mnemon-diary/outbox/`

日记文档的 `title` 是 `日记 <YYYY-MM-DD>`，正文是「【日记 日期】正文 + ## 重要记忆候选」，
`session_ids` 记录当天取材的会话，mnemon 的 `document_search` 能直接搜到。
快照提炼（digest）同理，标题形如 `快照 · 2026-10-27 · 12ab34cd`。

> 注意：Documents 是 Markdown 档案，没有逐条 FTS。**重要记忆候选以列表形式并入同一天的日记文档**，
> 而不是像 prime 那样拆成 8 条独立记录。要单条检索请让 mnemon 的召回策略处理，或用
> `mnemon_remember` 把关键条目再写进记忆空间。

## 配置

沿用原插件的配置项（`$DSH_HOME/mnemon-diary/config.json`），新增：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `documentsDir` | 空 | mnemon 文档库根目录；空则用 `~/.mnemon/documents`（也可用环境变量 `MNEMON_DOCUMENTS_DIR`） |
| `whoamiMinChars` / `whoamiMaxChars` | `50` / `500` | 「我是谁」的字数范围 |
| `ownerName` | `''` | 「我是谁」与人格重写里对这个人的称呼；留空＝通用「对方」 |
| `whoAmIDir` | 空 | 「我是谁」记忆合集目录；空则用 `$DSH_HOME/mnemon-diary/who-am-i` |
| `whoamiKeep` | `3` | 上传到记忆的「我是谁」保留最近几篇（2–5）；更早的从合集里剔除 |
| `snapshotKeep` | `20` | 文档库里最多保留多少份快照；更早的自动归档 |
| `diaryMergeDays` | `30` | 单日日记超过多少天就合并成 `日记合辑 YYYY-MM` |
| `diaryArchiveMonths` | `12` | 月合辑保留几个月；更早的自动归档 |
| `capacityLimitMb` | `8` | 文档库 active 总量上限（MB）；超了优先归档快照，再归档最旧文档，`我是谁` 永不动 |
| `personaFile` | 空 | 全局人格文件路径；空则用 `$DSH_HOME/AGENT.md` |
| `autoWhoamiCollection` | true | 我是谁自动归纳到合集 |
| `autoWhoamiUpload` | false | 我是谁自动上传记忆 |
| `autoWhoamiPersona` | false | 我是谁自动上传人格（只替换自动归纳那一段） |
| `autoWhoamiRewritePersona` | false | 我是谁自动重写人格（整份人格重写，写前备份） |
| `rewriteKeepBoundary` | false | 重写人格时保留旧文件的「# 边界」一节，只重写其它部分 |

其余：`enabled`、`intervalDays`(1)、`dailyAt`(23:00)、`contextThreshold`(85)、`contextCheckMinutes`(15)、
`skipProbability`(0.2)、`minChars`/`maxChars`(10/500)、`importanceThresholdProject`/`Chat`(0.6)、
`diaryCandidateLimit`(8)、`autoAdopt`(false)、`includedSessions`、`hideArchived`、`archiveEnabled`/`archiveDir`、
`snapshotBookDir`、`diaryBookEnabled`/`diaryBookDir`、`llmProvider`/`llmModel`、`maxInputTokens`(12000)。

## 记录我是谁

每次生成日记时，同一次 LLM 调用除了日记还会多产出 `whoami` 字段：只依据当天素材，用第一人称总结
「我是谁」——① 身份与性格；② 和人的默契（和人相处的立场与默契）；③ 最近的变化；④ 希望变成什么样的人
（可以包含性格的变化、自己认为的身份与关系变化、对自己的期望）。50–500 字，明确不写「今天发生了什么」。

- 生成物落在 `whoAmIDir/items/<date>.json`，UI 里「记录我是谁」折叠面板按日期列出，可展开阅读
- 每次生成/删除都会重建合集 `whoAmIDir/我是谁.md`（`> 只保留最近 N 篇` + 按日期倒序的 `## 日期` 小节）
- 点「上传记忆」把合集写进 mnemon 文档（标题固定为 `我是谁`，逐次更新 revision+1）
- **只允许一份**：上传时按标题去重，库里多余的副本（含已归档的旧版本）会先备份到 `$DSH_HOME/mnemon-diary/backups/doc-duplicates/` 再移除；唯一那份若被归档，会被自动拉回 active，而不是新建第二份
- 合集只收**最近 `whoamiKeep` 篇**（默认 3，范围 2–5）：每次生成/上传，更早的「我是谁」自动从合集与文档里剔除；本机 `items/` 仍保留原始 json 以便回溯
- 「打开我是谁记忆合集目录」直接打开 `whoAmIDir`
- 点「上传人格」会用 LLM 把该篇「我是谁」精简归纳成 60–200 字，写进全局人格文件（默认 `~/.dsh/AGENT.md`）里夹在
  `<!-- dsh-mnemon-diary:persona:start -->` / `<!-- dsh-mnemon-diary:persona:end -->` 之间的那一段：
  只替换这一段，文件其余内容原样保留，写前自动备份到 `$DSH_HOME/mnemon-diary/backups/AGENT-<ts>.md`
- **上传人格**：只替换标记之间的那一段，人格文件其它内容原样保留
- **重写人格**：把「旧人格」+「最近的我是谁自述」一起交给 LLM，按全局人格格式（`# 你是谁` / 语气与风格 / 行事偏好 / 边界 + 结尾约束段）
  **整份重写**，不保留旧内容；文件头注释与原格式保留，写前自动备份到 `backups/AGENT-full-<ts>.md`
- 四个开关分别是：`autoWhoamiCollection`（自动归纳到合集）、`autoWhoamiUpload`（自动上传记忆）、`autoWhoamiPersona`（自动上传人格）、
  `autoWhoamiRewritePersona`（自动重写人格），默认只开第一个

## 安装

三种任选：

```bash
# A) 从 GitHub 直接装（推荐分享给别人时用这个）
cd ~/.dsh/profiles/desktop
# package.json 的 dependencies 加：
#   "dsh-mnemon-diary": "github:shargritton/dsh-mnemon-diary"
# dsh.profile.bundles 里加 "dsh-mnemon-diary"
pnpm install

# B) 从本地目录装（自己改代码时用）
#   "dsh-mnemon-diary": "file:/你的路径/vendor/dsh-mnemon-diary"

# C) 发布到 npm 之后：
#   "dsh-mnemon-diary": "^0.1.2"
```

装完**重启 DSH**。首次启动会自动做两件事：把体检 skill 写到 `~/.dsh/skills/mnemon-memory-review/SKILL.md`（已存在则不动）、生成 `~/.dsh/mnemon-diary/记忆存储方案.md`。想手动补装，去设置页最下方「记忆存储方案 & 记忆体检 skill」点「安装为 skill」。

## 数据目录

```
$DSH_HOME/mnemon-diary/
├── drafts/<date>.json|md   # 草稿（日记 + 候选）
├── digests/<date>/<sid>.json# 上下文快照提炼
├── outbox/<date>.json      # 待写载荷（失败时留档，可重试）
├── backups/                # 每次写前备份的文档索引 + 自检副本
├── diaries/                # 采纳后的日记副本
├── who-am-i/items/<date>.json  # 「我是谁」每天的生成物
├── who-am-i/我是谁.md      # 唯一的「我是谁」记忆合集（自动重建）
├── archives/  diary-book/  snapshot-books/   # 归档与合集
├── state.json  config.json  debug.log
```

## 自检

设置页里的「写入通道自检」（`diag.writeTest`）会在临时目录建一份文档库、写一份测试文档、
校验索引与文件、再删掉，不会污染真库。

## 卸载

```bash
cd ~/.dsh/profiles/desktop
pnpm remove dsh-mnemon-diary
```

并把 `dsh.profile.bundles` 里的 `dsh-mnemon-diary` 删掉。已写进 mnemon 的日记文档不会被动到。

## License

MIT
## 文档库维护（自动，不用管）

每次生成日记 / 上传「我是谁」后，插件会自动跑一次文档库维护（`maintainDocuments`）：

1. **日记合并**：超过 `diaryMergeDays`（默认 30 天）的单日 `日记 <日期>` → 合并成 `日记合辑 YYYY-MM`（每天一个小节、正文全文保留），原单日文档转 archived
2. **合辑归档**：`日记合辑` 超过 `diaryArchiveMonths`（默认 12 个月）→ archived
3. **快照窗口**：快照类文档（`快照 ·` / `聊天 ·` / `综合 ·`）只留最近 `snapshotKeep`（默认 20）份，更早的 archived
4. **容量守卫**：active 总字节 > `capacityLimitMb`（默认 8 MB）→ 优先归档快照，其次普通文档，月合辑最后，目标回落到上限的 90%；`我是谁` 永不归档

补丁要点：

- 归档只是把文档挪到 `documents/archived/` 并标 `status: archived`，**正文一字不丢**；搜索时带 `includeArchived` 仍可翻旧账
- 合并/归档**不减少总字节**，只减少文档份数与 active 占用（搜索是逐份读全文的，份数才是速度瓶颈）
- `我是谁` 单独走单份逻辑，不受上面四条影响
- 导出脚本 `mnemon-diary/scripts/sync.mjs` 现在 active + archived 都导出，归档不会让 GitHub 掉历史

## 记忆存储方案（插件内指南 + skill 安装）

设置页最下方有一个折叠层「记忆存储方案 & 记忆体检 skill」：

- 正文是 `~/.dsh/mnemon-diary/记忆存储方案.md`，覆盖日记 / 快照 / 我是谁 / runtime 四套存储方案、参数表、维护时序、当前实况和排错表——给人和 AI 共用的排错指南
- 框里是**只读预览**：手动编辑容易把 `<!-- skill:start -->` 标记段写坏，所以保存按钮已去掉；要改方案就在会话里让 AI 改（它改完会同步备份到 `backups/plan-*.md`）。「恢复默认模板」用插件自带的 `plan-template.md` 重新生成
- 文件里 `<!-- skill:start -->` 与 `<!-- skill:end -->` 之间就是记忆体检 skill 的全文；点「安装为 skill」写到 `~/.dsh/skills/mnemon-memory-review/SKILL.md`（已存在则先备份到 `backups/skills/`），skill 目录即时生效，不用重启。另有兜底：插件首次启动会自动安装（仅当文件不存在），点「立即体检」时也会先检查并补装

## 记忆体检

设置页有「记忆体检」卡片，说明这次体检会动哪些文件，并提供「立即体检」按钮——它调用定时任务 `automation_4edc522f-c2fb-44b0-98e0-053a92afa6c9`（记忆月度体检，每月 1 日 04:00）立即跑一次。

- 处理：`runtime/MEMORY.md`、`runtime/USER.md`（合并/降级/过期清理，预算 6 KB / 3 KB）、文档库 `日记 <日期>`（>12 个月归档）、`快照 · …`（>6 个月归档或合并）、`记忆归档 YYYY-MM`（删前归档）
- 不动：`我是谁` 文档、drafts/digests/snapshot-books/archives/backups 等磁盘文件
- 手动兜底：自动流程失败或按钮无响应时，在会话里说「加载 skill mnemon-memory-review，做一次记忆体检」；也可在「设置 → 定时任务」手动运行
