# dsh-mnemon-diary

为 [DSH](https://github.com/deepseek-ai) 的 `dsh-mnemon` 增加「每日日记 + 重要记忆筛选 + 草稿审阅」的伴生插件。

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
- 每次生成/删除都会重建唯一合集 `whoAmIDir/我是谁.md`（`> 共 N 篇` + 按日期倒序的 `## 日期` 小节）
- 点「上传记忆」把**整份合集**写进 mnemon 文档（标题固定为 `我是谁`，只保留一份、逐次更新 revision+1）
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

```bash
# 1) 依赖写进 profile
cd ~/.dsh/profiles/desktop
# package.json 的 dependencies 加 "dsh-mnemon-diary": "file:/Users/po/dsh/vendor/dsh-mnemon-diary"
# dsh.profile.bundles 加 "dsh-mnemon-diary"
pnpm install

# 2) 重启 DSH（或重载 web 端插件）
```

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
