# 记忆存储方案（v1 · 2026-10-28）

> 这份文件由 dsh-mnemon-diary 插件维护，设置页最下方「记忆存储方案 & 记忆体检 skill」折叠层可以直接改、可以恢复默认。
> 写给两个人：给你（使用者）看懂"东西都存在哪、什么时候会消失"，也给我（AI）在聊天记录丢失后照着排错。

## 0. 一句话总览

- 记忆分**三层**：runtime 提示词（每轮注入，最贵）、Documents 文档库（按需检索）、普通磁盘（不进模型）
- 有三个**生成物**：日记（每天发生了什么）、快照（一段会话的浓缩）、我是谁（我是谁、和人的关系）
- 所有写入都要走「草稿 → 上传记忆 → 文档库」这道门，**插件从不直接往 runtime 里塞记忆**
- 归档 ≠ 删除：归档只是把文档挪进 `archived/`，正文一字不丢

## 1. 存储在哪（路径事实）

| 路径 | 内容 | 进上下文吗 |
| --- | --- | --- |
| `~/.mnemon/runtime/MEMORY.md` | 长期工作记忆（项目/环境/决定） | 每轮注入 |
| `~/.mnemon/runtime/USER.md` | 用户画像（偏好/习惯/关系） | 每轮注入 |
| `~/.mnemon/documents/index.json` | 文档索引（id/标题/大小/hash） | 不进 |
| `~/.mnemon/documents/active/` | 活跃文档正文 | 只有被检索时读 |
| `~/.mnemon/documents/archived/` | 归档文档 | 只有 `includeArchived` 时读 |
| `~/.dsh/mnemon-diary/drafts/` | 每日草稿（日记+候选） | 不进 |
| `~/.dsh/mnemon-diary/diary-book/` | 日记合集 Markdown | 不进 |
| `~/.dsh/mnemon-diary/snapshot-books/` | 快照合集 | 不进 |
| `~/.dsh/mnemon-diary/who-am-i/` | 我是谁 items + 合集 | 不进 |
| `~/.dsh/mnemon-diary/backups/` | AGENT / index / 去重 / 人格备份 | 不进 |
| `~/.dsh/mnemon-diary/debug.log` | 插件日志（排错先看它） | 不进 |

硬事实：Documents 的 **active 总量硬上限 10,485,760 字节**（约 10 MB），满了写入直接报错；搜索是**逐份读全文**，没有 FTS，所以**份数**比体积更影响速度（1000 份约 60–90 ms）。

## 2. 日记方案（每天发生了什么）

- **生成**：按 `intervalDays`（默认 1 天）+ 固定时间 `dailyAt`（默认 23:00）自动跑，或设置页「立即生成」手动跑；`skipProbability` 有 20% 概率偷懒跳过
- **取材**：会话日志 `session.v4.jsonl.zstd`，取上次运行到现在的时间窗，只要 user/assistant 文本；`minChars/maxChars` 决定日记长度（默认 10–500 字）
- **产物**：`drafts/<date>.json|.md` —— 日记正文 + 「重要记忆候选」最多 `diaryCandidateLimit` 条（默认 8，按项目/闲聊门槛 0.6/0.6 过滤）
- **采纳**：点「上传记忆」→ 写成文档 `日记 <date>`。按**标题幂等**：同一天多次生成不会多份，内容 hash 相同直接跳过
- **正文**：`【日记 YYYY-MM-DD】` + 正文 + `## 重要记忆候选` 编号列表（中文类型标签 + 重要度）
- **维护**（自动）：单日日记超过 `diaryMergeDays`（30 天）→ 合并成 `日记合辑 YYYY-MM`（一天一小节，原文照搬），单日转 archived；合辑超过 `diaryArchiveMonths`（12 个月）→ archived
- **导出**：`mnemon-diary/scripts/sync.mjs` 把日记导出到私有仓库 GitHub `shargritton/mnemon-diary`；**active 和 archived 都导**，所以归档不会让远端缺历史
- **体积**：约 2.8 KB/天 ≈ 1 MB/年；合并/归档后 active 里常年只留最近 30 天 + 最近 12 个月合辑

## 3. 快照方案（一段会话的浓缩）

- **触发**：每 `contextCheckMinutes`（15 分钟）检查一次上下文占用，≥ `contextThreshold`（90%）就自动快照；也可以在「会话素材」里对某一行手动「生成快照」
- **内容**：会话摘要 + 最多 30 条重要条目（摘要 + 重要条目 = 临时精简上传记忆）
- **落库**：文档 `快照 · <日期> · <会话短 id>`——**每个 日期×会话 一份**，这就是份数暴涨的根源
- **维护**（自动）：只留最近 `snapshotKeep`（20）份，更早的转 archived
- **可选**：`archiveEnabled` 会把整段原始会话打包进 `archives/`（用来恢复记忆，占磁盘、不建议上传记忆）

## 4. 我是谁方案（我是谁、和人的关系）

- **生成**：每次生成日记时一起生成；内容规范：身份与性格 / 对「<使用者称呼>」的立场与默契 / 最近的变化 / 希望变成什么样的人；字数 `whoamiMinChars–whoamiMaxChars`（默认 50–500）；**明确不写今天发生了什么**
- **落库**：文档 `我是谁` **永远只有一份**——
  1. 标题查重 + 内容 hash 幂等
  2. `keepSingleDocument` 兜底：同名的旧文档先备份到 `backups/doc-duplicates/` 再删；如果唯一那份在 archived 里，会被拉回 active
- **正文**：合集只收最近 `whoamiKeep` 篇（默认 3，范围 2–5），更早的从合集里剔除；`who-am-i/items/` 仍保留原始 json 以便回溯
- **写人格**：`上传人格` 只替换 `~/.dsh/AGENT.md` 里 persona 标记段（其余内容原样不动）；`重写人格` 用旧人格 + 最近 10 篇「我是谁」整份重写（先备份 `backups/AGENT-full-*.md`；开「保留边界」时 `# 边界` 原样接回）；两者互斥，只能开一个
- **自动**：`autoWhoamiUpload`（上传记忆）、`autoWhoamiCollection`（自动归纳合集）、`autoWhoamiRewritePersona`（自动重写人格）默认开，`autoWhoamiPersona`（只替换段落）默认关

## 5. runtime 记忆方案（每轮注入的那两份）

- `MEMORY.md`：项目/环境/决定/教训；预算 ≤ 6 KB、15–40 条
- `USER.md`：用户身份/偏好/习惯/关系；预算 ≤ 3 KB、8–20 条
- 这两份**每轮都进上下文**，所以最贵；写之前先想「这句以后还会用到吗」
- 体检：见第 9 节 skill；月度自动化 `记忆月度体检（mnemon）`（每月 1 日 04:00，deepseek-flash）会按它跑

## 6. 参数表（默认值）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `intervalDays` | 1 | 几天生成一次日记 |
| `dailyAt` | 23:00 | 每天固定生成时刻 |
| `skipProbability` | 0.2 | 偷懒概率 |
| `minChars` / `maxChars` | 10 / 500 | 日记字数范围 |
| `diaryCandidateLimit` | 8 | 日记的重要候选上限 |
| `importanceThresholdProject/Chat` | 0.5 / 0.4 | 项目/闲聊内容入库门槛 |
| `contextThreshold` | 90 | 上下文占用超过多少 % 触发快照 |
| `contextCheckMinutes` | 15 | 多久检查一次上下文 |
| `snapshotKeep` | 20 | 快照保留份数，更早归档 |
| `diaryMergeDays` | 30 | 单日日记几天后并成月合辑 |
| `diaryArchiveMonths` | 12 | 月合辑保留几个月 |
| `capacityLimitMb` | 8 | active 总量上限（MB），超了先归档快照 |
| `whoamiMinChars` / `whoamiMaxChars` | 50 / 500 | 我是谁字数范围 |
| `whoamiKeep` | 3 | 我是谁合集保留最近几篇（2–5） |
| `ownerName` | 空 | 使用者称呼；空则写「对方」 |
| `documentsDir` | 空 | 文档库根目录；空则 `~/.mnemon/documents` |

## 7. 维护时序（每次写入后自动跑）

1. **日记合并** → 2. **合辑归档** → 3. **快照窗口** → 4. **容量守卫**

守卫的取舍顺序：**快照 → 普通文档 → 月合辑**；`我是谁` 永不动；目标是回落到上限的 90%。
手动触发：`POST http://127.0.0.1:<GUI 端口>/mnemon-diary/docs.maintain`；看状态用 `docs.stats`。

## 8. 当前实况（怎么查，别抄数字）

这节不写死数字——每台机器、每一天都不一样。要看自己的实况，用下面两种方式之一：

- 设置页「记忆存储方案 & 记忆体检 skill」上方各卡片的状态行；
- 或 `POST http://127.0.0.1:<GUI 端口>/mnemon-diary/docs.stats`，返回 `{docs, active, archived, activeBytes, keep}`；
  `activeBytes / 10485760` 就是占用比例。

重点看四样：**文档份数、active 总字节、runtime 的 MEMORY/USER 字节数、已开的开关**（`autoAdopt`、`autoWhoamiUpload`、`autoWhoamiCollection`、`autoWhoamiPersona`、`autoWhoamiRewritePersona`、`rewriteKeepBoundary`）。

## 9. 排错指南（聊天记录丢了就靠这节）

| 症状 | 先查什么 |
| --- | --- |
| 刚写的文档搜不到 | mnemon 的 Documents 在**每轮开头钉住 readGrant**，新写入要下一轮才可见，不是写失败 |
| 归档的文档搜不到 | 检索要带 `includeArchived: true` |
| 按钮报 `unknown endpoint: xxx` | 前端新、后端旧——重启 DSH（client.js 刷新页面即可，index.js 必须重启） |
| 界面上改了没反应 | 刷新页面；还是不行就看重启后的 debug.log 有没有 `apply start` |
| 上传后文档数没增加 | 正常：标题幂等 + 内容 hash 相同会跳过，返回 `created:false, updated:false` |
| 出现两份同名文档 | 「我是谁」有单份兜底会自动清理，其余类型允许同名；看 `index.json` 与 `backups/doc-duplicates/` |
| 报 `Would exceed active document capacity` | 调 `docs.stats` 看 activeBytes；等守卫跑，或手动 `docs.maintain`，或调小 `snapshotKeep` |
| 人格文件被改坏 | 用 `backups/AGENT-*.md` / `AGENT-full-*.md` 还原 |
| 索引坏了/丢文档 | 用 `backups/index-*.json` 恢复 |
| 想看插件在干嘛 | `~/.dsh/mnemon-diary/debug.log` |
| 想确认后端在不在 | `curl http://127.0.0.1:<端口>/mnemon-diary/overview -X POST -H 'content-type: application/json' -d '{"rpcId":"1","payload":{}}'` |

RPC 端点：`overview`、`config.get/set`、`drafts.list/get`、`draft.generate/adopt/discard`、`diag.writeTest`、`diag.context`、`archive.run/open/list/delete`、`diarybook.open`、`digest.*`、`whoami.list/get/upload/delete/openDir/uploadPersona/rewritePersona`、`docs.maintain`、`docs.stats`、`plan.get/save/reset/writeSkill/openDir`。

## 10. 记忆体检 skill 原文

下面的标记段就是 `~/.dsh/skills/mnemon-memory-review/SKILL.md` 的全部内容。

安装有四道保险，按顺序自动兜底：

1. **插件首次启动**自动安装（目标文件不存在才装，已存在绝不覆盖）
2. 这个折叠层的按钮「**安装为 skill**」（旧版先备份到 `backups/skills/`）
3. 点「**立即体检**」前自动检查：skill 不存在就先装好，再排体检任务
4. 体检自动化本身：加载 skill 失败时，按自动化提示里的内置规则照跑，并在报告开头注明「skill 缺失」

所以**没装 skill 也不会报错**：最多是 Skill 工具加载不到，人工点一下上面的按钮，或者重启一次插件就补上了。
改这里的文字 = 改 skill，下次安装即生效。

<!-- skill:start -->
---
name: mnemon-memory-review
description: 每月一次的记忆体检（mnemon 版）：合并重复、删过期低价值条目、把被删内容归档进 Documents、控制 MEMORY.md/USER.md 体量。当用户说「整理记忆/精简记忆/记忆体检」，或月度维护自动化触发时使用。
---

# 月度记忆体检（mnemon）

目标：像人一样会忘——只留还重要的，删掉前先归档，体量控制在预算内。

## 硬预算

| 文件 | 目标 | 硬上限 | 条目数建议 |
| --- | --- | --- | --- |
| `runtime/MEMORY.md` | ≤ 6 KB | 10 KB（插件自动压缩） | 15–40 条 |
| `runtime/USER.md` | ≤ 3 KB | 10 KB | 8–20 条 |

超预算时按下面的「遗忘顺序」处理，不要靠插件自动压缩（它只是搬到本地归档，不判断价值）。
真实路径：`~/.mnemon/runtime/MEMORY.md`、`~/.mnemon/runtime/USER.md`、`~/.mnemon/documents/`。

## 遗忘顺序（从轻到重）

1. **去重合并**：同主题多条 → 合成一条自足表述，`replace` 保留信息最全的那条，其余 `remove`
2. **降级**：还在但近期没用的 `critical` → `normal`；`normal` 且已结案 → `low`
3. **过期清理**：临时进度、已完成任务日志、已被推翻的结论、「待确认」但已落定的状态 → 归档后删
4. **时效淘汰**：`low` 且 > 30 天没被用到 → 归档后删；`normal` 且 > 120 天没被用到 → 合并进同主题条目或归档后删
5. **永不动**：用户明确要求记住的（含「记住」「别忘」「永远」）、安全/权限规则、人格与身份相关、`critical` 标记的用户偏好——除非用户本人撤回

## 不被删除的判据

只要满足任一条就留：
- 会改变我的行为（规则、偏好、禁忌、工具用法）
- 复用价值高（路径、命令、配置、踩过的坑）
- 用户主动提过的人/关系/长期目标
- 无法重新推导（服务地址、口令线索、环境怪癖）

可以删的典型：一次性的进度、已完成的计划、聊过就过的情绪、能一眼从代码/文档看出来的事实、和已有 skill 重复的操作指南。

## 归档（必做，先于删除）

删条目前，把原文整段写进一份文档：

```
mnemon_document_create(
  title: "记忆归档 2026-10",
  description: "本月体检里被归档的记忆原文（2026-10）",
  content: "## 2026-10-27 · MEMORY 轨\n<原文>\n\n## …"
)
```

- 一个月一份，同名则 `mnemon_document_manage` 更新（追加到正文末尾）
- 归档失败就**不要删**——宁可留着，也不做不可逆操作
- 每季度可以把三个月归档合并成季度文档（`mnemon_document_manage` 更新 + 归档旧的），只为省地方，不强制

## 文档库同步整理（顺手做）

- `日记 <日期>` / `日记合辑 YYYY-MM`：插件已自动做（单日 >30 天并成月合辑、合辑 >12 个月自动归档），体检时只需确认合辑完整、别重复归档
- `快照 · …`：插件已按「只留最近 20 份」自动归档；体检时确认 active 里的快照数量没爆，多出来的再 archive
- `我是谁`：始终只保留**一份文档**，正文是最近 `whoamiKeep` 篇（默认 3，范围 2–5，插件自动滚动剔除更早的）；不要另建历史存档文档，也不要把旧「我是谁」搬进来

## 流程

1. **读现状**：两个 runtime 文件的条目数/字节数、documents 的份数与总量（`mnemon_document_search` 空查询可列最近文档）
2. **列草案**：逐条给 (a) 留 (b) 合并到 X (c) 归档并删 (d) 降级，先写清单再动手
3. **先归档，后删除**：一个月的归档文档写好并确认成功后，才执行 `remove`
4. **报告**：条数 前→后、字节数 前→后、归档 N 条、合并 N 组、跳过 N 条（含理由）
5. 若为自动化运行，报告直接输出到会话末尾即可，不额外建文件

## 反例（别这样）

- 不读原文就删；只凭标题猜内容
- 把用户说「记住」的东西当旧事清掉
- 为了数字好看硬删——宁可超预算，也不丢关键规则
- 一天跑两次；两次体检至少隔 25 天
<!-- skill:end -->
