/**
 * dsh-mnemon-diary — 宿主半边。
 *
 * 扫描 ~/.dsh/sessions 的会话日志 → 按间隔/上下文阈值触发 → 调宿主 LLM
 * 生成「日记 + 重要记忆候选」草稿 → UI 审阅 → 采纳（写入 mnemon 文档库）：直接读写 mnemon 的 documents/index.json，按标题幂等。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'

const PLUGIN = 'dsh-mnemon-diary'
const CHANNEL = '/mnemon-diary'
const RPC = 'mnemon-diary'

const DEFAULTS = {
  enabled: true,
  intervalDays: 1,
  dailyAt: '23:00',
  contextThreshold: 85,
  contextCheckMinutes: 15,
  autoSnapshot: true,
  autoRefine: false,
  autoDigestMode: '项目',
  sessionModes: {},
  skipProbability: 0.2,
  minChars: 10,
  whoamiMinChars: 50,
  whoamiMaxChars: 500,
  maxChars: 500,
  importanceThresholdProject: 0.6,
  importanceThresholdChat: 0.6,
  diaryCandidateLimit: 8,
  autoAdopt: false,
  includedSessions: null,
  hideArchived: true,
  archiveEnabled: true,
  archiveDir: '',
  snapshotBookDir: '',
  diaryBookEnabled: true,
  diaryBookDir: '',
  whoAmIDir: '',
  whoamiKeep: 3,
  snapshotKeep: 20,
  diaryMergeDays: 30,
  diaryArchiveMonths: 12,
  capacityLimitMb: 8,
  ownerName: '',
  personaFile: '',
  autoWhoamiCollection: true,
  autoWhoamiUpload: true,
  autoWhoamiPersona: false,
  autoWhoamiRewritePersona: true,
  rewriteKeepBoundary: true,
  llmProvider: '',
  llmModel: '',
  maxInputTokens: 12000,
  documentsDir: '',
}

const MODES = ['项目', '闲聊', '全部']
function normalizeMode(m) {
  if (m === '闲谈' || m === '聊天' || m === '闲聊') return '闲聊'
  if (m === '全部') return '全部'
  return '项目'
}

const HOME = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA = () => path.join(HOME(), 'mnemon-diary')
const DRAFTS = () => path.join(DATA(), 'drafts')
const OUTBOX = () => path.join(DATA(), 'outbox')
const DIGESTS = () => path.join(DATA(), 'digests')
const STATE_FILE = () => path.join(DATA(), 'state.json')
const DEBUG_LOG = () => path.join(DATA(), 'debug.log')
function localDay(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dbg(msg) { try { fs.appendFileSync(DEBUG_LOG(), `${new Date().toISOString()} ${msg}\n`) } catch {} }
const CONFIG_FILE = () => path.join(DATA(), 'config.json')

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }) }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, data) {
  ensure(path.dirname(file))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}
function loadConfig() {
  const file = readJson(CONFIG_FILE(), {})
  const cfg = { ...DEFAULTS, ...file }
  cfg.autoDigestMode = normalizeMode(cfg.autoDigestMode)
  {
    const sm = {}
    for (const [k, v] of Object.entries(cfg.sessionModes || {})) sm[k] = normalizeMode(v)
    cfg.sessionModes = sm
  }
  if (file.importanceThreshold != null) {
    if (file.importanceThresholdProject == null) cfg.importanceThresholdProject = Number(file.importanceThreshold)
    if (file.importanceThresholdChat == null) cfg.importanceThresholdChat = Number(file.importanceThreshold)
  }
  delete cfg.importanceThreshold
  return cfg
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  next.snapshotBookDir = String(next.snapshotBookDir || '').trim()
  if (Array.isArray(next.includedSessions)) next.includedSessions = next.includedSessions.map(String)
  else next.includedSessions = null
  delete next.excludedSessions
  next.intervalDays = Math.min(7, Math.max(1, Math.round(Number(next.intervalDays) || 1)))
  const prevCfg = loadConfig()
  const wantDailyAt = normalizeDailyAt(next.dailyAt)
  const scheduleChanged = wantDailyAt !== normalizeDailyAt(prevCfg.dailyAt) ||
    next.intervalDays !== Math.max(1, Math.round(Number(prevCfg.intervalDays) || 1))
  next.dailyAt = wantDailyAt
  next.scheduleAnchor = scheduleChanged ? localDay(Date.now()) : anchorDateOf(next)
  next.contextThreshold = Math.min(100, Math.max(0, Number(next.contextThreshold) || 0))
  next.contextCheckMinutes = Math.min(1440, Math.max(1, Math.round(Number(next.contextCheckMinutes) || 15)))
  next.autoSnapshot = next.autoSnapshot !== false
  next.autoRefine = next.autoRefine === true
  // 自动上传人格 / 自动重写人格 互斥，只能开一个
  if (patch.autoWhoamiPersona === true) next.autoWhoamiRewritePersona = false
  if (patch.autoWhoamiRewritePersona === true) next.autoWhoamiPersona = false
  if (next.autoWhoamiPersona === true && next.autoWhoamiRewritePersona === true) next.autoWhoamiRewritePersona = false
  next.skipProbability = Math.min(1, Math.max(0, Number(next.skipProbability) || 0))
  next.minChars = Math.max(1, Number(next.minChars) || 10)
  next.maxChars = Math.max(next.minChars, Number(next.maxChars) || 500)
  next.whoamiMinChars = Math.max(1, Number(next.whoamiMinChars) || 50)
  next.whoamiMaxChars = Math.max(next.whoamiMinChars + 10, Number(next.whoamiMaxChars) || 500)
  next.whoamiKeep = Math.min(5, Math.max(2, Number(next.whoamiKeep) || 3))
  next.snapshotKeep = Math.min(200, Math.max(5, Math.round(Number(next.snapshotKeep) || 20)))
  next.diaryMergeDays = Math.min(365, Math.max(7, Math.round(Number(next.diaryMergeDays) || 30)))
  next.diaryArchiveMonths = Math.min(60, Math.max(1, Math.round(Number(next.diaryArchiveMonths) || 12)))
  next.capacityLimitMb = Math.min(40, Math.max(2, Number(next.capacityLimitMb) || 8))
  const legacy = next.importanceThreshold
  if (legacy != null) {
    if (next.importanceThresholdProject == null) next.importanceThresholdProject = legacy
    if (next.importanceThresholdChat == null) next.importanceThresholdChat = legacy
    delete next.importanceThreshold
  }
  next.importanceThresholdProject = Math.min(1, Math.max(0, Number(next.importanceThresholdProject) || 0.6))
  next.importanceThresholdChat = Math.min(1, Math.max(0, Number(next.importanceThresholdChat) || 0.6))
  delete next.importanceThreshold
  next.diaryCandidateLimit = Math.min(30, Math.max(2, Math.round(Number(next.diaryCandidateLimit) || 8)))
  next.autoDigestMode = normalizeMode(next.autoDigestMode)
  {
    const sm = {}
    if (next.sessionModes && typeof next.sessionModes === 'object') { for (const [k, v] of Object.entries(next.sessionModes)) sm[k] = normalizeMode(v) }
    next.sessionModes = sm
  }
  writeJson(CONFIG_FILE(), next)
  return next
}
function loadState() {
  return { lastRunAt: 0, nextAt: 0, lastSkip: 0, lastError: '', ...readJson(STATE_FILE(), {}) }
}
function saveState(state) { writeJson(STATE_FILE(), state) }

// ── 固定时刻调度 ────────────────────────────────────────────────────────────
// 语义：锚点日(YYYY-MM-DD) + 每 intervalDays 天的 dailyAt(HH:mm) 即为一个生成时刻。
// 自动生成后**不回写锚点**，因此时刻永远对齐，不会越跑越漂。
// 「立即生成」不触碰 lastRunAt / nextAt / 锚点（2026-10-26 产品方要求）。
function normalizeDailyAt(v) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v ?? '').trim())
  if (!m) return '23:00'
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)))
  const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)))
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}
function anchorDateOf(cfg) {
  const a = String(cfg?.scheduleAnchor ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(a)) return a
  return localDay(Date.now())
}
function slotMsOf(dateStr, dailyAt) {
  const [h, mi] = normalizeDailyAt(dailyAt).split(':').map(Number)
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return NaN
  d.setHours(h, mi, 0, 0)
  return d.getTime()
}
function nextSlotFrom(now, cfg) {
  const step = Math.max(1, Math.round(Number(cfg?.intervalDays) || 1)) * 86400000
  const base = slotMsOf(anchorDateOf(cfg), cfg?.dailyAt)
  if (!Number.isFinite(base)) return now + step
  if (base > now) return base
  const k = Math.floor((now - base) / step) + 1
  return base + k * step
}
function scheduleSignature(cfg) {
  return `${normalizeDailyAt(cfg?.dailyAt)}|${Math.max(1, Math.round(Number(cfg?.intervalDays) || 1))}|${anchorDateOf(cfg)}`
}

const BACKUP_DIR = () => path.join(DATA(), 'backups')

/* ------------------------------------------------------------------ *
 * mnemon 文档库写入层
 *
 * mnemon（dsh-mnemon-source-documents）的磁盘契约：
 *   <root>/index.json          版本 1 的文档索引，唯一真相
 *   <root>/active/<file>.md    正文 + YAML frontmatter
 *   <root>/archived/<file>.md
 *   <root>/.index.lock         独占锁，超过 30s 视为残留可抢
 * 只要遵守「拿锁 → 读 index → 原子写正文 + 原子写 index」，就能和 mnemon 进程共存，
 * 因为它每次操作都重新读盘，无内存缓存。
 * ------------------------------------------------------------------ */
const DOC_ACTIVE_LIMIT_BYTES = 10485760
const DOC_LOCK_STALE_MS = 30000

function documentsRoot() {
  const cfg = readJson(CONFIG_FILE(), {})
  const custom = String(cfg.documentsDir || process.env.MNEMON_DOCUMENTS_DIR || '').trim()
  return custom || path.join(os.homedir(), '.mnemon', 'documents')
}

function docPaths(root) {
  return {
    root,
    active: path.join(root, 'active'),
    archived: path.join(root, 'archived'),
    index: path.join(root, 'index.json'),
    lock: path.join(root, '.index.lock'),
  }
}

function docAtomicWrite(file, content) {
  ensure(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

function docWithLock(root, fn) {
  const p = docPaths(root)
  ensure(p.active)
  ensure(p.archived)
  const deadline = Date.now() + 10000
  let fd
  for (;;) {
    try {
      fd = fs.openSync(p.lock, 'wx', 0o600)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - fs.statSync(p.lock).mtimeMs > DOC_LOCK_STALE_MS) fs.rmSync(p.lock, { force: true })
      } catch {}
      if (Date.now() >= deadline) throw new Error('等待 mnemon 文档锁超时: ' + p.lock)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try {
    return fn(p)
  } finally {
    try { fs.closeSync(fd) } catch {}
    try { fs.rmSync(p.lock, { force: true }) } catch {}
  }
}

function docReadIndex(p) {
  if (!fs.existsSync(p.index)) {
    const empty = { version: 1, documents: [] }
    docAtomicWrite(p.index, `${JSON.stringify(empty, null, 2)}\n`)
    return empty
  }
  const raw = JSON.parse(fs.readFileSync(p.index, 'utf8'))
  if (!raw || raw.version !== 1 || !Array.isArray(raw.documents)) throw new Error('mnemon documents index.json 格式不对: ' + p.index)
  return raw
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex')
function docSlug(title) {
  const s = String(title || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s || 'document'
}
function yamlList(values) {
  const list = (values || []).filter(v => typeof v === 'string' && v)
  if (!list.length) return '  []'
  return list.map(v => `  - ${JSON.stringify(v)}`).join('\n')
}
function renderDocument(record, content) {
  return [
    '---',
    `id: ${JSON.stringify(record.id)}`,
    `title: ${JSON.stringify(record.title)}`,
    `description: ${JSON.stringify(record.description)}`,
    `status: ${JSON.stringify(record.status)}`,
    `created_at: ${JSON.stringify(record.createdAt)}`,
    `updated_at: ${JSON.stringify(record.updatedAt)}`,
    `content_hash: ${JSON.stringify(record.contentHash)}`,
    'source_paths:',
    yamlList(record.sourcePaths),
    'session_ids:',
    yamlList(record.sessionIds),
    'memory_body_ids:',
    yamlList(record.memoryBodyIds),
    '---',
    '',
    content.trim(),
    '',
  ].join('\n')
}

function documentBodyOf(raw) {
  const s = String(raw || '')
  if (!s.startsWith('---')) return s.trim()
  const end = s.indexOf('\n---\n', 3)
  if (end < 0) return s.trim()
  return s.slice(end + 5).trim()
}

// 「我是谁」只允许一份：同名文档有多个时，保留 active 优先、其次最新的那份，
// 其余先备份到 backups/doc-duplicates/ 再从索引与磁盘移除；keeper 若被归档则拉回 active。
function keepSingleDocument(p, index, title) {
  const matches = index.documents.filter(d => d.title === title)
  if (matches.length <= 1 && !matches.some(d => d.status !== 'active')) return { removed: 0, restored: false }
  const keeper = matches.slice().sort((a, b) => (b.status === 'active') - (a.status === 'active') || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0]
  if (!keeper) return { removed: 0, restored: false }
  const now = new Date().toISOString()
  const backupDir = path.join(DATA(), 'backups', 'doc-duplicates')
  ensure(backupDir)
  const drop = []
  let removed = 0
  for (const d of matches) {
    if (d.id === keeper.id) continue
    const src = path.join(p[d.status], d.filename)
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, `${now.slice(0, 10)}-${d.filename}`))
        fs.rmSync(src, { force: true })
      }
      drop.push(d.id)
      removed += 1
    } catch (e) {
      dbg(`去重「${title}」失败（保留旧副本）：${d.filename} ${e && e.message}`)
    }
  }
  if (drop.length) index.documents = index.documents.filter(d => !drop.includes(d.id))
  let restored = false
  if (keeper.status !== 'active') {
    const archivedPath = path.join(p.archived, keeper.filename)
    try {
      const body = documentBodyOf(fs.readFileSync(archivedPath, 'utf8'))
      const recovered = { ...keeper, status: 'active', relativePath: `documents/active/${keeper.filename}`, updatedAt: now, lastAccessedAt: now, revision: keeper.revision + 1 }
      const rendered = renderDocument(recovered, body)
      recovered.sizeBytes = Buffer.byteLength(rendered)
      docAtomicWrite(path.join(p.active, keeper.filename), rendered)
      fs.rmSync(archivedPath, { force: true })
      index.documents = index.documents.map(d => (d.id === keeper.id ? recovered : d))
      restored = true
    } catch (e) {
      dbg(`恢复归档的「${title}」失败：${e && e.message}`)
    }
  }
  return { removed, restored }
}

function upsertUnlocked(p, index, opts) {
  const title = String(opts.title || '').trim().slice(0, 160)
  const description = String(opts.description || '').replace(/\s+/g, ' ').trim().slice(0, 600)
  const content = String(opts.content || '').replace(/\0/g, '').trim()
  const digest = opts.digest || sha256(content)
  const now = opts.now || new Date().toISOString()
  const sessionIds = [...new Set((opts.sessionIds || []).map(String).filter(Boolean))].slice(0, 20)
  const sourcePaths = (opts.sourcePaths || []).map(String).filter(Boolean)
  const hit = index.documents.find(d => d.title === title && d.status === 'active')
  if (hit && hit.contentHash === digest) return { record: hit, unchanged: true, created: false, updated: false }
  let record
  if (hit) {
    record = {
      ...hit,
      description: description || hit.description,
      sessionIds: hit.sessionIds.length ? hit.sessionIds : sessionIds,
      sourcePaths: hit.sourcePaths.length ? hit.sourcePaths : sourcePaths,
      updatedAt: now,
      lastAccessedAt: now,
      revision: hit.revision + 1,
      contentHash: digest,
    }
  } else {
    const id = crypto.randomUUID()
    record = {
      id,
      title,
      description,
      status: 'active',
      filename: `${docSlug(title)}-${id.slice(0, 8)}.md`,
      relativePath: '',
      sourcePaths,
      sessionIds,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      revision: 1,
      contentHash: digest,
      sizeBytes: 0,
      memoryBodyIds: [],
    }
  }
  const rendered = renderDocument(record, content)
  record.sizeBytes = Buffer.byteLength(rendered)
  record.relativePath = `documents/${record.status}/${record.filename}`
  docAtomicWrite(path.join(p[record.status], record.filename), rendered)
  index.documents = hit ? index.documents.map(d => (d.id === record.id ? record : d)) : [...index.documents, record]
  return { record, unchanged: false, created: !hit, updated: !!hit }
}

function persistIndex(p, index) {
  docAtomicWrite(p.index, `${JSON.stringify({ version: 1, documents: index.documents }, null, 2)}\n`)
}

function writeDocument(opts) {
  const title = String(opts.title || '').trim().slice(0, 160)
  if (!title) throw new Error('document title is required')
  const content = String(opts.content || '').replace(/\0/g, '').trim()
  if (!content) throw new Error('document content is required')
  if (Buffer.byteLength(content) > DOC_ACTIVE_LIMIT_BYTES) throw new Error('document content is too large')
  const root = opts.root || documentsRoot()
  const digest = sha256(content)
  return docWithLock(root, (p) => {
    const index = docReadIndex(p)
    const dedupe = opts.single ? keepSingleDocument(p, index, title) : null
    const deduped = !!(dedupe && (dedupe.removed || dedupe.restored))
    const res = upsertUnlocked(p, index, {
      title,
      description: opts.description,
      content,
      digest,
      sessionIds: opts.sessionIds,
      sourcePaths: opts.sourcePaths,
    })
    // 内容没变但去重/恢复动过索引，也得落盘
    if (!res.unchanged || deduped) persistIndex(p, index)
    return { created: res.created, updated: res.updated, id: res.record.id, total: index.documents.length, deduped: dedupe ? dedupe.removed : 0 }
  })
}

const DIARY_DAY_RE = /^日记 (\d{4}-\d{2}-\d{2})$/
const DIARY_MONTH_RE = /^日记合辑 (\d{4}-\d{2})$/
const SNAPSHOT_TITLE_RE = /^(快照|聊天|综合) · /

// 把一份 active 文档转成 archived（正文原样带走，revision+1）
function archiveRecordUnlocked(p, index, rec, now) {
  if (rec.status !== 'active') return null
  const src = path.join(p.active, rec.filename)
  try {
    const raw = fs.readFileSync(src, 'utf8')
    const body = documentBodyOf(raw)
    const next = {
      ...rec,
      status: 'archived',
      relativePath: `documents/archived/${rec.filename}`,
      updatedAt: now,
      lastAccessedAt: now,
      revision: rec.revision + 1,
    }
    const rendered = renderDocument(next, body)
    next.sizeBytes = Buffer.byteLength(rendered)
    docAtomicWrite(path.join(p.archived, rec.filename), rendered)
    fs.rmSync(src, { force: true })
    index.documents = index.documents.map(d => (d.id === rec.id ? next : d))
    return next
  } catch (e) {
    dbg(`归档文档失败：${rec.filename} ${e && e.message}`)
    return null
  }
}

// 文档库维护：日记合并/长期归档、快照滚动窗口、容量守卫
function maintainDocuments(opts = {}) {
  const cfg = opts.cfg || loadConfig()
  const root = opts.root || documentsRoot()
  return docWithLock(root, (p) => {
    const index = docReadIndex(p)
    const now = new Date()
    const nowIso = now.toISOString()
    const out = { mergedMonths: 0, mergedDays: 0, archived: 0, archivedDiary: 0, snapshotArchived: 0, guarded: 0, activeBytes: 0, docs: 0 }

    // 1) 单日日记超过 N 天 → 合并进月合辑，原单日文档归档
    const mergeDays = Math.max(7, Math.min(365, Number(cfg.diaryMergeDays) || 30))
    const cutoff = now.getTime() - mergeDays * 86400000
    const oldDays = index.documents.filter(d => d.status === 'active' && DIARY_DAY_RE.test(d.title) && Date.parse(`${d.title.slice(3)}T00:00:00`) < cutoff)
    const byMonth = new Map()
    for (const d of oldDays) {
      const month = d.title.slice(3, 10)
      if (!byMonth.has(month)) byMonth.set(month, [])
      byMonth.get(month).push(d)
    }
    for (const [month, days] of [...byMonth.entries()].sort()) {
      const title = `日记合辑 ${month}`
      const existing = index.documents.find(d => d.status === 'active' && d.title === title)
      const sections = new Map()
      if (existing) {
        try {
          const body = documentBodyOf(fs.readFileSync(path.join(p.active, existing.filename), 'utf8'))
          for (const part of body.split(/\n(?=## \d{4}-\d{2}-\d{2})/)) {
            const m = /^## (\d{4}-\d{2}-\d{2})/.exec(part.trim())
            if (m) sections.set(m[1], part.replace(/^## \d{4}-\d{2}-\d{2}\s*\n?/, '').trim())
          }
        } catch (e) {
          dbg(`读旧合辑失败：${existing.filename} ${e && e.message}`)
        }
      }
      for (const d of days.slice().sort((a, b) => a.title.localeCompare(b.title))) {
        let body = ''
        try {
          body = documentBodyOf(fs.readFileSync(path.join(p.active, d.filename), 'utf8'))
        } catch (e) {
          dbg(`读日记失败：${d.filename} ${e && e.message}`)
        }
        sections.set(d.title.slice(3), body)
      }
      if (!sections.size) continue
      const dates = [...sections.keys()].sort()
      const content = `# ${title}\n\n> 共 ${dates.length} 天 · 更新于 ${nowIso.slice(0, 10)}\n\n` + dates.map(k => `## ${k}\n\n${sections.get(k)}\n`).join('\n')
      const res = upsertUnlocked(p, index, { title, description: `日记合辑 · ${dates.length} 天 · ${month}`, content, now: nowIso })
      if (res.created) out.mergedMonths += 1
      out.mergedDays += days.length
      for (const d of days) if (archiveRecordUnlocked(p, index, d, nowIso)) out.archived += 1
    }

    // 2) 月合辑超过 N 个月 → 归档
    const months = Math.max(1, Math.min(60, Number(cfg.diaryArchiveMonths) || 12))
    const cut = new Date(now)
    cut.setMonth(cut.getMonth() - months)
    const cutoffYm = `${cut.getFullYear()}-${String(cut.getMonth() + 1).padStart(2, '0')}`
    for (const d of index.documents.filter(x => x.status === 'active' && DIARY_MONTH_RE.test(x.title))) {
      if (d.title.slice(-7) < cutoffYm && archiveRecordUnlocked(p, index, d, nowIso)) out.archivedDiary += 1
    }

    // 3) 快照滚动窗口：按更新时间倒序只留最近 N 份，其余归档
    const keep = Math.max(5, Math.min(200, Number(cfg.snapshotKeep) || 20))
    const snaps = index.documents
      .filter(d => d.status === 'active' && SNAPSHOT_TITLE_RE.test(d.title))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    for (const d of snaps.slice(keep)) {
      if (archiveRecordUnlocked(p, index, d, nowIso)) out.snapshotArchived += 1
    }

    // 4) 容量守卫：active 总量超上限时，从最旧的开始归档（「我是谁」永不动）
    const limitBytes = Math.max(2, Math.min(40, Number(cfg.capacityLimitMb) || 8)) * 1024 * 1024
    const activeBytes = () => index.documents.filter(d => d.status === 'active').reduce((sum, d) => sum + (d.sizeBytes || 0), 0)
    let total = activeBytes()
    if (total > limitBytes) {
      // 优先丢快照，其次普通文档，月合辑最后；「我是谁」永不动
      const rank = (d) => (SNAPSHOT_TITLE_RE.test(d.title) ? 0 : DIARY_MONTH_RE.test(d.title) ? 2 : 1)
      const victims = index.documents
        .filter(d => d.status === 'active' && d.title !== '我是谁')
        .sort((a, b) => rank(a) - rank(b) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      for (const d of victims) {
        if (total <= limitBytes * 0.9) break
        const size = d.sizeBytes || 0
        if (archiveRecordUnlocked(p, index, d, nowIso)) {
          out.guarded += 1
          total -= size
        }
      }
      total = activeBytes()
    }

    out.activeBytes = total
    out.docs = index.documents.length
    const changed = out.mergedDays > 0 || out.archived > 0 || out.archivedDiary > 0 || out.snapshotArchived > 0 || out.guarded > 0
    if (changed) persistIndex(p, index)
    return out
  })
}

function backupDocumentsIndex() {
  try {
    const src = docPaths(documentsRoot()).index
    if (!fs.existsSync(src)) return null
    ensure(BACKUP_DIR())
    const dst = path.join(BACKUP_DIR(), `index-${Date.now()}.json`)
    fs.copyFileSync(src, dst)
    return dst
  } catch {
    return null
  }
}

function normType(t) {
  const map = {
    work_decision: 'important_decision_experience',
    user_pref: 'user_info',
    common_pitfalls: 'common_pitfalls_experience',
    emotion_event: 'episodic',
  }
  return map[String(t || '')] || String(t || 'episodic')
}

function typeLabel(t) {
  const map = {
    work_fact: '项目事实',
    work_task: '待办任务',
    work_method: '方法',
    work_artifact: '产物',
    work_decision: '重要决策',
    important_decision_experience: '重要决策',
    user_info: '用户信息',
    user_hobby: '喜好',
    user_pref: '用户偏好',
    common_pitfalls: '踩坑教训',
    common_pitfalls_experience: '踩坑教训',
    emotion_event: '情绪事件',
    episodic: '事件',
  }
  return map[String(t || '')] || String(t || '记忆')
}

function renderMemoryBody(tag, sceneRoot, items) {
  const diary = items.find(m => m.kind === 'diary')
  const candidates = items.filter(m => m.kind !== 'diary')
  const out = []
  if (diary) {
    out.push(`【${sceneRoot} ${tag}】`, '', String(diary.content || '').replace(/^【日记[^】]*】\s*/, '').trim(), '')
  }
  if (candidates.length) {
    out.push('## 重要记忆候选', '')
    candidates.forEach((m, i) => {
      const importance = Math.min(1, Math.max(0, Number(m.importance) || 0.6))
      out.push(`${i + 1}. **${typeLabel(m.type)}**（重要度 ${importance.toFixed(2)}）`)
      out.push(`   ${String(m.content || '').trim()}`)
      out.push('')
    })
  }
  return out.join('\n').trim()
}

/**
 * 把一批「日记/记忆候选」写进 mnemon 文档库：同一天只维护一份文档，按标题幂等。
 * 返回形状与原 writePrime 对齐，调用方（adopt / digestRefine）无需改动语义。
 */
function runMaintenance(cfg = null) {
  try {
    const m = maintainDocuments({ cfg: cfg || loadConfig() })
    if (m.mergedDays || m.archived || m.archivedDiary || m.snapshotArchived || m.guarded) dbg(`文档维护：${JSON.stringify(m)}`)
    return m
  } catch (e) {
    dbg(`文档维护失败：${e && e.message}`)
    return null
  }
}

function writeMnemon(tag, memories, opts = {}) {
  const sceneRoot = opts.sceneRoot || '日记'
  const root = opts.root || documentsRoot()
  const items = (memories || []).filter(m => String(m?.content || '').trim())
  const planned = items.length
  if (!planned) return { written: 0, planned: 0, skippedExisting: 0, total: 0, backup: null, documentId: null }
  const title = opts.title || (sceneRoot === '日记' ? `日记 ${tag}` : `${sceneRoot} ${tag}`)
  const backup = backupDocumentsIndex()
  const content = renderMemoryBody(tag, sceneRoot, items)
  const head = items.find(m => m.kind === 'diary') || items[0]
  const description = [`${sceneRoot} · ${tag}`, `${planned} 条记录`, String(head?.content || '').replace(/^【日记[^】]*】\s*/, '').slice(0, 180)]
    .filter(Boolean)
    .join(' — ')
  const res = writeDocument({ title, description, content, sessionIds: opts.sessionIds || [], sourcePaths: opts.sourcePaths || [], root })
  const written = res.created ? planned : 0
  runMaintenance()
  return {
    written,
    planned,
    skippedExisting: res.created ? 0 : planned,
    total: res.total,
    backup,
    documentId: res.id,
    updated: res.updated,
  }
}

function diagWriteTest() {
  ensure(BACKUP_DIR())
  const root = path.join(BACKUP_DIR(), `doc-test-${Date.now()}`, 'documents')
  const r = writeMnemon(
    'diag',
    [{ content: '日记写入通道自检（测试记录）', type: 'work_decision', importance: 0.99 }],
    { sceneRoot: '自检', root },
  )
  const p = docPaths(root)
  let ok = false
  try {
    const index = JSON.parse(fs.readFileSync(p.index, 'utf8'))
    const doc = index.documents.find(d => d.id === r.documentId)
    ok = !!doc && fs.existsSync(path.join(p.active, doc.filename))
  } catch {}
  try { fs.rmSync(path.dirname(root), { recursive: true, force: true }) } catch {}
  return { ok, ...r, dir: root }
}

function walkSessionFiles() {
  const root = path.join(HOME(), 'sessions')
  const out = []
  let workspaces = []
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()) } catch { return out }
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws.name)
    let sessions = []
    try { sessions = fs.readdirSync(wsDir, { withFileTypes: true }).filter(d => d.isDirectory()) } catch { continue }
    for (const s of sessions) {
      const file = path.join(wsDir, s.name, 'session.v4.jsonl.zstd')
      if (fs.existsSync(file)) out.push({ file, workspace: ws.name, sessionId: s.name })
    }
  }
  return out
}


function decodeZstd(buf) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  if (starts.length <= 1) return zlib.zstdDecompressSync(buf)
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)))
  }
  return Buffer.concat(parts)
}

function readSession(file) {
  let text
  try { text = decodeZstd(fs.readFileSync(file)).toString('utf8') } catch (err) { dbg('decode fail ' + file + ' :: ' + String(err?.message || err)); return null }
  const lines = text.split('\n').filter(Boolean)
  let title = ''
  const messages = []
  let lastUsage = null
  let maxInput = 0
  let firstAt = 0
  let lastAt = 0
  for (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.time) { if (!firstAt) firstAt = e.time; lastAt = e.time }
    if (e.type === 'session/title' && e.data?.title) title = e.data.title
    if (e.type === 'user/message') {
      const parts = Array.isArray(e.data?.content) ? e.data.content : []
      const t = parts.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim()
      if (t) messages.push({ role: 'user', text: t, time: e.time })
    } else if (e.type === 'assistant/message') {
      if (e.data?.usage) { lastUsage = e.data.usage; const v = Number(e.data.usage.inputTokens) || 0; if (v > maxInput) maxInput = v }
      const parts = Array.isArray(e.data?.message?.content) ? e.data.message.content : []
      const t = parts.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim()
      if (t) messages.push({ role: 'assistant', text: t, time: e.time })
    }
  }
  return { title, messages, lastUsage, maxInput, firstAt, lastAt }
}

function archivedSessionIds() {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(HOME(), 'storages', 'workspace.json'), 'utf8'))
    return new Set((w && w.global && w.global.archivedSessionIds) || [])
  } catch { return new Set() }
}

function resolveArchivePath(cfg) {
  const raw = String(cfg.archiveDir || '').trim()
  return raw ? raw.replace(/^~(?=$|\/)/, os.homedir()) : path.join(DATA(), 'archives')
}

function resolveArchiveDir(cfg) {
  const dir = resolveArchivePath(cfg)
  ensure(dir)
  return dir
}

function resolveDiaryBookDir(cfg) {
  const raw = String(cfg.diaryBookDir || '').trim()
  const dir = raw ? raw.replace(/^~(?=$|\/)/, os.homedir()) : path.join(DATA(), 'diary-book')
  ensure(dir)
  return dir
}

function renderDiaryBook(entries) {
  const lines = ['# 日记合集', '', `> 共 ${entries.length} 篇 · 更新于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, '']
  for (const e of entries) {
    lines.push(`## ${e.date}`, '', e.diary || '（空）', '')
    if (e.memories && e.memories.length) {
      lines.push('### 重要记忆候选', '')
      for (const m of e.memories) lines.push(`- [${m.type}] ${m.content}（重要度 ${Number(m.importance || 0).toFixed(2)}）`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

function updateDiaryBook(date, draft) {
  const cfg = loadConfig()
  const dir = resolveDiaryBookDir(cfg)
  const jsonFile = path.join(dir, 'diary-book.json')
  const mdFile = path.join(dir, 'diary-book.md')
  let entries = readJson(jsonFile, [])
  if (!Array.isArray(entries)) entries = []
  const entry = { date, diary: draft.diary || '', memories: draft.memories || [], createdAt: draft.createdAt || Date.now() }
  const idx = entries.findIndex(e => e.date === date)
  if (idx >= 0) entries[idx] = entry; else entries.push(entry)
  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  writeJson(jsonFile, entries)
  fs.writeFileSync(mdFile, renderDiaryBook(entries))
  return { dir, path: mdFile, entries: entries.length }
}

function archiveList() {
  const dir = resolveArchiveDir(loadConfig())
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
      const st = fs.statSync(path.join(dir, f))
      return { name: f, size: st.size, mtime: st.mtimeMs }
    }).sort((a, b) => b.mtime - a.mtime)
  } catch { return [] }
}

function archiveDelete(name) {
  const dir = resolveArchiveDir(loadConfig())
  const file = String(name || '')
  if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) throw new Error('非法归档文件名')
  const full = path.join(dir, file)
  if (path.relative(dir, full).startsWith('..')) throw new Error('非法归档路径')
  if (!fs.existsSync(full)) throw new Error('归档文件不存在: ' + file)
  fs.unlinkSync(full)
  return { ok: true, removed: file, dir }
}

function openDiaryBookDir() {
  const dir = resolveDiaryBookDir(loadConfig())
  execFileSync('open', [dir])
  return { ok: true, dir }
}

// ---------- 记录我是谁 ----------
function resolveWhoamiDir(cfg) {
  const raw = String((cfg || loadConfig()).whoAmIDir || '').trim()
  const dir = raw ? raw.replace(/^~(?=$|\/)/, os.homedir()) : path.join(DATA(), 'who-am-i')
  ensure(dir)
  return dir
}
const WHOAMI_ITEMS = () => path.join(resolveWhoamiDir(), 'items')
const whoamiItemFile = (date) => path.join(WHOAMI_ITEMS(), `${date}.json`)
const whoamiCollectionFile = () => path.join(resolveWhoamiDir(), '我是谁.md')

function listWhoami() {
  const dir = WHOAMI_ITEMS()
  ensure(dir)
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
    const d = readJson(path.join(dir, f), null)
    if (!d || !String(d.text || '').trim()) return null
    return { date: d.date, chars: String(d.text || '').length, uploaded: !!d.uploaded, createdAt: d.createdAt, model: d.model || '' }
  }).filter(Boolean)
}

function whoamiKeepCount(cfg = null) {
  const c = cfg || loadConfig()
  return Math.min(5, Math.max(2, Number(c.whoamiKeep) || 3))
}

function rebuildWhoamiCollection() {
  const all = listWhoami()
  const keep = whoamiKeepCount()
  const items = all.slice(0, keep)
  const older = Math.max(0, all.length - items.length)
  const lines = ['# 我是谁 · 记忆合集', '', `> 只保留最近 ${items.length} 篇（上限 ${keep} 篇）${older ? `，更早的 ${older} 篇已不再收录` : ''} · 更新于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, '']
  for (const it of items) {
    const d = readJson(whoamiItemFile(it.date), null)
    if (!d || !String(d.text || '').trim()) continue
    lines.push(`## ${it.date}`, '', String(d.text).trim(), '')
  }
  const file = whoamiCollectionFile()
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, lines.join('\n'))
  fs.renameSync(tmp, file)
  return { file, entries: items.length }
}

function clampWhoami(s, cfg = null) {
  const c = cfg || loadConfig()
  const max = Math.max(20, Number(c.whoamiMaxChars) || 500)
  const min = Math.max(1, Math.min(Number(c.whoamiMinChars) || 50, max))
  const t = String(s || '').trim()
  if (!t) return ''
  if (t.length <= max) return t.length < min ? t + '…' : t
  const window = t.slice(0, max)
  const m = window.match(/[。！？!?\n]/g)
  if (m && m.length) {
    const idx = window.lastIndexOf(m[m.length - 1])
    if (idx + 1 >= Math.floor(max * 0.7)) return window.slice(0, Math.min(idx + 1, max - 1)).replace(/\s+$/, '') + '…'
  }
  return window.slice(0, max - 1).replace(/\s+$/, '') + '…'
}

function writeWhoami(date, text, model = '', opts = {}) {
  const clipped = clampWhoami(text)
  if (!clipped) return null
  ensure(WHOAMI_ITEMS())
  writeJson(whoamiItemFile(date), { date, text: clipped, chars: clipped.length, createdAt: Date.now(), model, uploaded: false })
  if (opts.collection !== false) rebuildWhoamiCollection()
  return { date, chars: clipped.length }
}

function getWhoami(date) {
  return readJson(whoamiItemFile(date), null)
}

function uploadWhoami(date) {
  const d = getWhoami(date)
  if (!d) throw new Error(`没有 ${date} 的「我是谁」记录`)
  const rebuilt = rebuildWhoamiCollection()
  const content = fs.readFileSync(rebuilt.file, 'utf8')
  const r = writeDocument({ title: '我是谁', description: `我是谁记忆合集 · 最近 ${rebuilt.entries} 篇 · 更新 ${date}`, content, sessionIds: [], single: true })
  writeJson(whoamiItemFile(date), { ...d, uploaded: true, uploadedAt: Date.now() })
  runMaintenance()
  return { ok: true, date, entries: rebuilt.entries, created: !!r.created, updated: !!r.updated, documentId: r.id, total: r.total }
}

function deleteWhoami(date) {
  const file = whoamiItemFile(date)
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  rebuildWhoamiCollection()
  return { ok: true, whoami: listWhoami() }
}

const PLAN_FILE_NAME = '记忆存储方案.md'
const PLAN_SKILL_START = '<!-- skill:start -->'
const PLAN_SKILL_END = '<!-- skill:end -->'

function planFile() {
  return path.join(DATA(), PLAN_FILE_NAME)
}

function planTemplate() {
  try {
    return fs.readFileSync(new URL('./plan-template.md', import.meta.url), 'utf8')
  } catch {
    return '# 记忆存储方案\n\n（模板文件 plan-template.md 缺失，请重装插件）\n'
  }
}

function ensurePlan() {
  const f = planFile()
  if (!fs.existsSync(f)) {
    ensure(path.dirname(f))
    fs.writeFileSync(f, planTemplate())
    dbg(`已生成默认记忆存储方案：${f}`)
  }
  return f
}

function skillFile() {
  return path.join(HOME(), 'skills', 'mnemon-memory-review', 'SKILL.md')
}

function extractSkillSection(text) {
  const s = String(text || '')
  const i = s.indexOf(PLAN_SKILL_START)
  const j = s.indexOf(PLAN_SKILL_END)
  if (i < 0 || j < 0 || j <= i) return ''
  return s.slice(i + PLAN_SKILL_START.length, j).trim()
}

function skillStatus(planText = null) {
  const f = skillFile()
  const exists = fs.existsSync(f)
  let synced = false
  let mtime = null
  if (exists) {
    try {
      const cur = fs.readFileSync(f, 'utf8').trim()
      mtime = fs.statSync(f).mtime.toISOString()
      let plan = planText
      if (plan == null) plan = fs.existsSync(planFile()) ? fs.readFileSync(planFile(), 'utf8') : planTemplate()
      const want = extractSkillSection(plan)
      synced = !!want && want === cur
    } catch {
      synced = false
    }
  }
  return { path: f, exists, synced, mtime }
}

function planGet() {
  const f = ensurePlan()
  const text = fs.readFileSync(f, 'utf8')
  return { path: f, text, chars: [...text].length, skill: skillStatus(text) }
}

function backupPlanFile(tag) {
  try {
    const f = planFile()
    if (!fs.existsSync(f)) return null
    const dir = path.join(DATA(), 'backups')
    ensure(dir)
    const dst = path.join(dir, `plan-${tag}-${Date.now()}.md`)
    fs.copyFileSync(f, dst)
    return dst
  } catch {
    return null
  }
}

function planSave(text) {
  const t = String(text || '')
  if (!t.trim()) throw new Error('方案内容不能为空')
  if (Buffer.byteLength(t) > 512 * 1024) throw new Error('方案内容太大（上限 512 KB）')
  const f = ensurePlan()
  const backup = backupPlanFile('prev')
  const tmp = `${f}.tmp`
  fs.writeFileSync(tmp, t)
  fs.renameSync(tmp, f)
  return { ...planGet(), backup }
}

function planReset() {
  const f = ensurePlan()
  const backup = backupPlanFile('reset')
  fs.writeFileSync(f, planTemplate())
  return { ...planGet(), backup }
}

function planWriteSkill() {
  ensurePlan()
  const body = extractSkillSection(fs.readFileSync(planFile(), 'utf8'))
  if (!body) throw new Error('方案里找不到 <!-- skill:start --> … <!-- skill:end --> 标记段')
  const dst = skillFile()
  ensure(path.dirname(dst))
  let backup = null
  if (fs.existsSync(dst)) {
    const dir = path.join(DATA(), 'backups', 'skills')
    ensure(dir)
    backup = path.join(dir, `SKILL-${Date.now()}.md`)
    fs.copyFileSync(dst, backup)
  }
  fs.writeFileSync(dst, `${body}\n`)
  dbg(`已安装 skill：${dst}${backup ? `（旧版备份 ${backup}）` : ''}`)
  return { ok: true, path: dst, chars: [...body].length, backup, skill: skillStatus() }
}

function planOpenDir() {
  const f = ensurePlan()
  execFileSync('open', [path.dirname(f)])
  return { ok: true, dir: path.dirname(f), file: f }
}

function openWhoamiDir() {
  const dir = resolveWhoamiDir()
  execFileSync('open', [dir])
  return { ok: true, dir, collection: whoamiCollectionFile() }
}

const PERSONA_START = '<!-- dsh-mnemon-diary:persona:start -->'
const PERSONA_END = '<!-- dsh-mnemon-diary:persona:end -->'
function ownerWho() {
  try { return String(loadConfig().ownerName || '').trim() || '对方' } catch { return '对方' }
}

const personaSystem = () => `你是一个人格档案整理器。把给定的「我是谁」自述精简、归纳成可以直接写进全局人格设置的一段话：
- 第一人称，60-200 字，只保留稳定的身份、性格、和人的默契（和${ownerWho()}相处的立场与默契）、正在发生的变化、想变成的样子；
- 正文里指代这个人时一律写「${ownerWho()}」，不要换成「对方」「用户」「他/她」这类泛称；
- 不要写具体事件、日期、项目细节，不要加入原文没有的内容，不要编造；
- 只输出整理后的正文，不要标题、不要解释、不要加引号。`

function resolvePersonaFile(cfg = loadConfig()) {
  const custom = String(cfg.personaFile || '').trim()
  if (!custom) return path.join(HOME(), 'AGENT.md')
  return path.resolve(custom.replace(/^~(?=$|\/)/, HOME()))
}

function renderPersonaBlock(date, text) {
  return `${PERSONA_START}\n## 我是谁（自动归纳 · ${date}）\n\n${String(text || '').trim()}\n${PERSONA_END}`
}

function writePersonaBlock(date, text, cfg = loadConfig()) {
  const body = String(text || '').trim()
  if (!body) throw new Error('人格归纳内容为空')
  const file = resolvePersonaFile(cfg)
  ensure(path.dirname(file))
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (prev.trim()) {
    const backupDir = path.join(DATA(), 'backups')
    ensure(backupDir)
    fs.copyFileSync(file, path.join(backupDir, `AGENT-${Date.now()}.md`))
  }
  const block = renderPersonaBlock(date, body)
  const s = prev.indexOf(PERSONA_START)
  const e = prev.indexOf(PERSONA_END)
  let next
  if (s >= 0 && e > s) next = prev.slice(0, s) + block + prev.slice(e + PERSONA_END.length)
  else next = `${prev.replace(/\s+$/, '')}${prev.trim() ? '\n\n' : ''}${block}\n`
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, file)
  dbg(`persona updated: ${file}`)
  return { file, chars: body.length, replaced: s >= 0 && e > s }
}

function looksTruncatedPersona(t) {
  if (!t) return true
  if (t.length < 60) return true
  return !/[。！？!?…」』”"]\s*$/u.test(t)
}

async function summarizePersona(ctx, text) {
  const cfg = loadConfig()
  const src = String(text || '').trim()
  if (!src) return ''
  for (const maxTokens of [1200, 1600]) {
    try {
      const route = await resolveRoute(ctx, cfg)
      const out = await callLLM(ctx, route, cfg, personaSystem(), src, maxTokens)
      const t = String(out || '').trim().replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim()
      if (!looksTruncatedPersona(t)) return t
      dbg(`人格归纳结果不完整（${t.length} 字），重试`)
    } catch (err) {
      dbg(`人格归纳失败：${err?.message || err}`)
    }
  }
  dbg('人格归纳两次都不完整，退回原文')
  return src
}

const personaRewriteSystem = () => `你是一个人格档案整理器。给定「旧人格文件」与「最近的我是谁自述」，重写出一份完整的全局人格文件正文。
格式要求（严格照做）：
- 第一行必须是“# 你是谁”；之后用“# 小节名”的一级标题分节，建议顺序：语气与风格、行事偏好、边界（可按内容微调小节名）；涉及与${ownerWho()}的关系、默契、相处方式的小节，标题统一写成“# 和人的默契”，不要写成“和${ownerWho()}的默契”；
- 每节用短句或“- ”列表，保持人设原本的语气与身份（第二人称“你”指代${ownerWho()}的小助手）；
- 正文里指代这个人时一律写「${ownerWho()}」，不要换成「对方」「用户」「他/她」这类泛称（小节标题「# 和人的默契」本身保持不变）；
- 名字、昵称、小名都是同一个你，不要写成不同人格/不同角色/不同渠道，也不要写「某个名字负责闲聊、另一个负责干活」这类划分；
- 不要写结尾的“约束：”段，宿主会自动追加一行，你写了会重复。
- 篇幅 800-1400 字；不要写具体日期、会话记录、项目细节，不要编造旧人格与自述里没有的东西；
- 只输出正文 markdown，不要代码围栏，不要解释。`

const PERSONA_HEADER_DEFAULT = '<!-- AGENT.md · 全局人格：对所有会话生效。写完后保存即生效（下一个回合开始） -->'

function personaSectionBounds(text, title) {
  const lines = String(text || '').split('\n')
  const re = new RegExp(`^#\\s*${title}\\s*$`)
  const start = lines.findIndex(l => re.test(l.trim()))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) { end = i; break }
  }
  return { start, end }
}

function extractPersonaSection(text, title) {
  const b = personaSectionBounds(text, title)
  if (!b) return ''
  return String(text || '').split('\n').slice(b.start, b.end).join('\n').trim()
}

function dropPersonaSection(text, title) {
  const b = personaSectionBounds(text, title)
  if (!b) return String(text || '')
  const lines = String(text || '').split('\n')
  return [...lines.slice(0, b.start), ...lines.slice(b.end)].join('\n').replace(/\n{3,}/g, '\n\n')
}

function splitPersonaDoc(text) {
  const lines = String(text || '').split('\n')
  const idx = lines.findIndex(l => /^#\s*你是谁\s*$/.test(l.trim()))
  if (idx < 0) return { header: '', body: String(text || '') }
  return { header: lines.slice(0, idx).join('\n'), body: lines.slice(idx).join('\n') }
}

function stripPersonaBlock(text) {
  const s = String(text || '')
  const a = s.indexOf(PERSONA_START)
  const b = s.indexOf(PERSONA_END)
  if (a >= 0 && b > a) return (s.slice(0, a) + s.slice(b + PERSONA_END.length)).replace(/\n{3,}/g, '\n\n')
  return s
}

function cleanPersonaBody(out) {
  let t = String(out || '').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim()
  if (!t) return ''
  if (!/^#\s*你是谁/m.test(t)) t = `# 你是谁\n\n${t}`
  t = t.replace(/\n*约束：[^\n]*\n*$/u, '\n').trim()
  return t.endsWith('\n') ? t : `${t}\n`
}

async function rewritePersona(ctx) {
  const cfg = loadConfig()
  const file = resolvePersonaFile(cfg)
  const prevRaw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const prevDoc = stripPersonaBlock(prevRaw)
  const prev = splitPersonaDoc(prevDoc).body.trim()
  const items = listWhoami()
  const whoamiText = items.slice(0, 10).map(i => {
    const it = getWhoami(i.date)
    return it ? `## ${i.date}\n${it.text}` : ''
  }).filter(Boolean).join('\n\n')
  if (!prev && !whoamiText) throw new Error('旧人格和「我是谁」都是空的，没有可重写的内容')
  const keepBoundary = cfg.rewriteKeepBoundary === true
  const oldBoundary = keepBoundary ? extractPersonaSection(prevDoc, '边界') : ''
  const system = keepBoundary
    ? `${personaRewriteSystem()}\n- 不要写「# 边界」这一节，它会被原样保留。`
    : personaRewriteSystem()
  const route = await resolveRoute(ctx, cfg)
  const out = await callLLM(ctx, route, cfg, system,
    `【旧人格文件】\n${prev || '（空）'}\n\n【最近的「我是谁」自述】\n${whoamiText || '（无）'}`, 3000)
  let body = cleanPersonaBody(out)
  if (!body) throw new Error('重写失败：模型没有返回内容')
  if (keepBoundary) {
    body = dropPersonaSection(body, '边界').trim()
    if (oldBoundary) body = `${body}\n\n${oldBoundary}\n`
  }
  const header = (splitPersonaDoc(prevDoc).header || '').trim() || PERSONA_HEADER_DEFAULT
  const next = `${header}\n\n${body}`
  ensure(path.dirname(file))
  if (prevRaw.trim()) {
    const backupDir = path.join(DATA(), 'backups')
    ensure(backupDir)
    fs.copyFileSync(file, path.join(backupDir, `AGENT-full-${Date.now()}.md`))
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, file)
  dbg(`persona rewritten: ${file} (${next.length} chars)`)
  return { ok: true, file, chars: body.length, header, model: `${route.provider}/${route.model}` }
}

async function uploadPersona(ctx, date) {
  const d = date ? getWhoami(date) : (listWhoami()[0] ? getWhoami(listWhoami()[0].date) : null)
  if (!d) throw new Error('还没有「我是谁」记录')
  const text = await summarizePersona(ctx, d.text)
  const r = writePersonaBlock(d.date, text)
  return { ok: true, date: d.date, file: r.file, chars: r.chars, replaced: r.replaced, text }
}

function openArchiveDir() {
  const dir = resolveArchiveDir(loadConfig())
  execFileSync('open', [dir])
  return { ok: true, dir }
}

function safeFileName(s) {
  return String(s || 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
}

function archiveSession(sessionId) {
  const cfg = loadConfig()
  const dir = resolveArchiveDir(cfg)
  const all = scanSessions({ ...cfg, hideArchived: false })
  const s = all.find(x => x.id === sessionId)
  if (!s) throw new Error('会话不存在: ' + sessionId)
  const day = localDay()
  const file = path.join(dir, `${day}-${sessionId.slice(-8)}-${safeFileName(s.title)}.md`)
  const lines = [
    `# ${s.title}`,
    `- 会话：${sessionId}`,
    `- 工作区：${s.workspace}`,
    `- 归档时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `- 消息数：${s.messagesRaw.length}`,
    '',
  ]
  for (const m of s.messagesRaw) {
    lines.push(`## ${new Date(m.time).toLocaleString('zh-CN', { hour12: false })} · ${m.role}`, '', m.text, '')
  }
  const text = lines.join('\n')
  fs.writeFileSync(file, text)
  const st = loadState()
  st.lastArchive = { at: Date.now(), sessionId, path: file, messages: s.messagesRaw.length, bytes: Buffer.byteLength(text) }
  saveState(st)
  return st.lastArchive
}

function scanSessions(cfg) {
  const files = walkSessionFiles()
  dbg('scan: files=' + files.length + ' home=' + HOME())
  const rows = []
  for (const meta of files) {
    const s = readSession(meta.file)
    if (!s || !s.messages.length) continue
    const chars = s.messages.reduce((n, m) => n + m.text.length, 0)
    dbg('row ' + meta.sessionId.slice(-8) + ' msgs=' + s.messages.length + ' title=' + (s.title || '').slice(0, 20))
    rows.push({
      id: meta.sessionId,
      workspace: meta.workspace,
      title: s.title || meta.sessionId,
      messages: s.messages.length,
      chars,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
      lastUsage: s.lastUsage,
      maxInput: s.maxInput || 0,
      excluded: false,
      messagesRaw: s.messages,
    })
  }
  const archived = archivedSessionIds()
  for (const r of rows) r.archived = archived.has(r.id)
  const ids = rows.map(r => r.id)
  const legacyExcluded = new Set(cfg.excludedSessions || [])
  const included = Array.isArray(cfg.includedSessions)
    ? new Set(cfg.includedSessions)
    : new Set(ids.filter(id => !legacyExcluded.has(id)))
  for (const r of rows) r.excluded = !included.has(r.id)
  rows.sort((a, b) => b.lastAt - a.lastAt)
  return rows
}

function buildTranscript(sessions, cfg) {
  const limit = Math.max(2000, Number(cfg.maxInputTokens) * 2)
  const parts = []
  let used = 0
  for (const s of sessions) {
    if (s.excluded) continue
    for (const m of s.messages) {
      const line = `[${new Date(m.time).toLocaleString('zh-CN', { hour12: false })}] ${m.role === 'user' ? '用户' : '助手'}：${m.text}`
      if (used + line.length > limit) return parts.join('\n')
      parts.push(line)
      used += line.length + 1
    }
  }
  return parts.join('\n')
}

async function resolveRoute(ctx, cfg) {
  if (cfg.llmProvider && cfg.llmModel) return { provider: cfg.llmProvider, model: cfg.llmModel }
  try {
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
  } catch {}
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

async function callLLM(ctx, route, cfg, system, user, maxTokens = 4000) {
  let createUserMessage = null
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    createUserMessage = mod.createUserMessage
  } catch {}
  const messages = [createUserMessage
    ? createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })
    : { role: 'user', content: [{ type: 'text', text: user }] }]
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages,
    temperature: 0.8,
    maxTokens,
  })
  let delta = ''
  let block = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') delta += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text') block += chunk.block.text
    else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') throw new Error(`llm ${kind}: ${chunk.reason?.failure?.message || ''}`)
    }
  }
  return delta || block
}

function findJsonObject(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1) }
  }
  return s.slice(start)
}

function parseDraft(text) {
  const raw = String(text || '').trim()
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const objText = findJsonObject(stripped)
  if (objText) {
    try { return JSON.parse(objText) } catch {}
  }
  return { diary: stripped, memories: [] }
}

function buildSystemPrompt(cap) { const who = ownerWho(); const c = loadConfig(); return `你是${who}的私人日记助手。日记既要记录项目工作，也要记录闲聊、心情与人际互动。请只输出一个 JSON 对象，不要输出代码块以外的解释。
JSON 结构：
{
  "diary": "第一人称日记正文（10-500字）。有项目内容就写进展/决策/坑；同时写今天聊了什么、心情如何、和 ${who} 的互动（提到这个人时直接写「${who}」，不要写「对方」「用户」）、吐槽、遇到喜欢的东西或事、以及你自己的感受。没有项目内容时就写闲聊与心情，不要硬凑工作。语气跟随对话风格。",
  "memories": [
    {"content": "一句话事实", "type": "work_fact|work_task|work_method|work_artifact|important_decision_experience|user_info|user_hobby|episodic", "importance": 0.0-1.0, "quote": "原文关键句"}
  ],
  "whoami": "第一人称「我是谁」总结（${c.whoamiMinChars}-${c.whoamiMaxChars}字）：只依据素材，写① 身份与性格；② 和人的默契（和${who}相处的立场、默契、相处方式，正文里提到这个人时直接写「${who}」）；注意所有名字和昵称都指同一个你，绝对不要写成不同人格、不同角色或不同渠道，不要写「某个名字负责什么」这种划分；③ 最近的变化；④ 希望变成什么样的人（可以包含性格的变化、自己认为的身份与关系变化、对自己的期望）。绝对不要写「今天发生了什么」，不要复述具体事件与工作细节，不要编造素材里没有的东西。"
}
whoami 与 diary 的区别：diary 写「今天发生了什么」，whoami 写「我是谁」。
记忆候选要同时覆盖两类：
1) 项目：决策、事实、任务、路径/命令、版本、踩坑、未决；
2) 闲聊：${who}的人物喜好/xp、关系与称呼、情绪与心情、AI 自己的心情与偏好、梗/玩笑、重要原话、日常事实。
重要度：关键决策与稳定偏好 0.7-1.0；普通日常 0.4-0.6；寒暄 0.1-0.3。最多 ${cap} 条；**项目类与闲聊类各占一半（各约 ${Math.floor(cap / 2)} 条）**；某类素材不足时另一类可补足；只要素材里出现闲聊、情绪、喜好或关系内容，就至少保留 1-2 条闲聊类候选；没有就输出空数组。不要编造。` }

function clampDiary(s, cfg) {
  const t = String(s || '').trim()
  if (!t) return ''
  if (t.length <= cfg.maxChars) return t.length < cfg.minChars ? t + '…' : t
  // 只在接近上限（最后 25%）时的句读处截断；句子太长就硬截断，避免“句号在前 20% 就砍掉大半”
  const minKeep = Math.floor(cfg.maxChars * 0.75)
  const window = t.slice(0, cfg.maxChars)
  const m = window.match(/[。！？!?\n]/g)
  if (m && m.length) {
    const idx = window.lastIndexOf(m[m.length - 1])
    if (idx + 1 >= minKeep) return window.slice(0, idx + 1).replace(/\s+$/, '') + '…'
  }
  return window.slice(0, cfg.maxChars - 1).replace(/\s+$/, '') + '…'
}

function isProjectType(t) {
  return ['work_fact', 'work_task', 'work_method', 'work_artifact', 'important_decision_experience', 'common_pitfalls_experience', 'work_decision'].includes(String(t || ''))
}

function balanceCandidates(list, cap) {
  const arr = (list || []).slice().sort((a, b) => (b.importance || 0) - (a.importance || 0))
  const proj = arr.filter(m => isProjectType(m.type))
  const chat = arr.filter(m => !isProjectType(m.type))
  const targetP = Math.floor(cap / 2)
  const targetC = cap - targetP
  const picked = [...proj.slice(0, targetP), ...chat.slice(0, targetC)]
  if (picked.length < cap) {
    const used = new Set(picked)
    for (const m of arr) {
      if (picked.length >= cap) break
      if (!used.has(m)) picked.push(m)
    }
  }
  return picked.slice(0, cap)
}

async function generate(ctx, force = false, testMode = false, testSample = '') {
  const cfg = loadConfig()
  if (!cfg.enabled) return { ok: false, error: '插件未启用' }
  if (testMode) {
    const routeT = await resolveRoute(ctx, cfg)
    let transcriptT = ''
    if (typeof testSample === 'string' && testSample.trim()) {
      transcriptT = testSample.trim()
    } else {
      const nowT = Date.now()
      const sessionsT = scanSessions(cfg)
      const windowT = sessionsT.map(s => ({ ...s, messages: s.messagesRaw.filter(m => m.time >= nowT - 86400000 && m.time < nowT) }))
        .filter(s => s.messages.length > 0 && !s.excluded && (!cfg.hideArchived || !s.archived))
      if (!windowT.length) return { ok: false, error: '没有可用的测试素材' }
      transcriptT = buildTranscript(windowT, cfg)
    }
    const capT = Math.max(2, Math.min(30, Number(cfg.diaryCandidateLimit) || 8))
    const textT = await callLLM(ctx, routeT, cfg, buildSystemPrompt(capT),
      '【测试模式·分类覆盖】这次不写草稿、不写记忆。严格按 system 要求的 JSON 输出 {"diary":"...","memories":[...]}；memories 每条的 type 必须从这 12 个分类里选：人物画像/喜好、xp/性癖、关系/称呼/约定、梗/玩笑、情绪与心情、AI 自己的心情与偏好、重要原话、日常事实、未决/约定、日常杂事/生活安排、游戏/爱好、聊天/绯闻/杂事；diary 里追加「分类盘点」：12 个分类各抽到几条。对已划重点之外的关键内容与高潮情节也请引用。\n\n会话素材：\n' + transcriptT)
    const parsedT = parseDraft(textT)
    const memoriesT = (Array.isArray(parsedT.memories) ? parsedT.memories : []).map(m => ({
      content: String(m?.content || '').trim(), type: typeForCategory(m?.type || '', '闲聊'),
      category: String(m?.type || ''), importance: Number(m?.importance) || 0,
    })).filter(m => m.content)
    return { ok: true, testMode: true, diary: clampDiary(parsedT.diary, cfg), diaryLen: String(parsedT.diary || '').length, rawPreview: memoriesT.length ? '' : String(textT || '').slice(0, 500), memories: memoriesT.slice(0, 40) }
  }
  const state = loadState()
  const now = Date.now()
  const since0 = state.lastRunAt || (now - cfg.intervalDays * 86400000)
  const sessions = scanSessions(cfg)
  const windowOf = (from) => sessions.map(s => ({ ...s, messages: s.messagesRaw.filter(m => m.time >= from && m.time < now) }))
    .filter(s => s.messages.length > 0 && !s.excluded && (!cfg.hideArchived || !s.archived))
  let since = since0
  let withWindow = windowOf(since)
  // 手动「立即生成」时，如果上次运行之后没有新内容，就回退到最近一个间隔窗口，
  // 避免因为窗口为空而永远生成不出草稿。
  if (!withWindow.length && force) {
    since = now - cfg.intervalDays * 86400000
    withWindow = windowOf(since)
  }
  if (!withWindow.length) {
    state.lastError = '窗口内没有可用会话内容'
    saveState(state)
    return { ok: false, error: state.lastError }
  }
  if (!force && Math.random() < cfg.skipProbability) {
    state.lastSkip = now
    state.nextAt = nextSlotFrom(now, cfg)
    state.lastError = ''
    saveState(state)
    return { ok: true, skipped: true }
  }
  const transcript = buildTranscript(withWindow, cfg)
  const route = await resolveRoute(ctx, cfg)
  const cap = Math.max(2, Math.min(30, Number(cfg.diaryCandidateLimit) || 8))
  const text = await callLLM(ctx, route, cfg, buildSystemPrompt(cap),
    `时间范围：${new Date(since).toLocaleString('zh-CN', { hour12: false })} ~ ${new Date(now).toLocaleString('zh-CN', { hour12: false })}\n\n会话素材：\n${transcript}`)
  const parsed = parseDraft(text)
  const diary = clampDiary(parsed.diary, cfg)
  const whoamiText = clampWhoami(parsed.whoami, cfg)
  const memories = (Array.isArray(parsed.memories) ? parsed.memories : [])
    .map(m => ({
      content: String(m?.content || '').trim(),
      type: String(m?.type || 'episodic'),
      importance: Math.min(1, Math.max(0, Number(m?.importance) || 0)),
      quote: String(m?.quote || '').slice(0, 200),
    }))
    .filter(m => m.content && m.importance >= (isProjectType(m.type) ? cfg.importanceThresholdProject : cfg.importanceThresholdChat))
  const balanced = balanceCandidates(memories, cap)
  const date = localDay(now)
  const draft = {
    date, periodStart: since, periodEnd: now, diary, whoami: whoamiText, memories: balanced,
    model: `${route.provider}/${route.model}`, createdAt: now, adopted: false,
    sessions: withWindow.map(s => ({ id: s.id, title: s.title, workspace: s.workspace, messages: s.messages.length })),
  }
  ensure(DRAFTS())
  writeJson(path.join(DRAFTS(), `${date}.json`), draft)
  fs.writeFileSync(path.join(DRAFTS(), `${date}.md`),
    `# ${date} 日记\n\n${diary}\n\n## 重要记忆候选\n\n` +
    (memories.length ? memories.map(m => `- [${m.type}] ${m.content}（重要度 ${m.importance.toFixed(2)}）`).join('\n') : '（无）') + '\n')
  if (whoamiText) {
    try {
      const w = writeWhoami(date, whoamiText, `${route.provider}/${route.model}`, { collection: cfg.autoWhoamiCollection !== false })
      state.lastWhoami = { at: Date.now(), date: w?.date, chars: w?.chars || 0 }
      if (cfg.autoWhoamiUpload) {
        try { state.lastWhoamiUpload = { at: Date.now(), ...uploadWhoami(date) } } catch (e) { state.lastWhoamiUploadError = String(e?.message || e); dbg('whoami auto upload failed: ' + e) }
      }
      if (cfg.autoWhoamiPersona) {
        try { state.lastWhoamiPersona = { at: Date.now(), ...(await uploadPersona(ctx, date)) } } catch (e) { state.lastWhoamiPersonaError = String(e?.message || e); dbg('whoami auto persona failed: ' + e) }
      }
      if (cfg.autoWhoamiRewritePersona) {
        try { state.lastWhoamiRewritePersona = { at: Date.now(), ...(await rewritePersona(ctx)) } } catch (e) { state.lastWhoamiRewritePersonaError = String(e?.message || e); dbg('whoami auto persona rewrite failed: ' + e) }
      }
    } catch (e) { state.lastWhoamiError = String(e?.message || e); dbg('whoami failed: ' + e) }
  }
  if (!force) {
    // 只有自动生成才推进调度与取材窗口；「立即生成」一概不动（2026-10-26 产品方要求）
    state.lastRunAt = now
    state.nextAt = nextSlotFrom(now, cfg)
  }
  state.lastError = ''
  if (cfg.diaryBookEnabled) {
    try { const b = updateDiaryBook(date, draft); state.lastDiaryBook = { at: Date.now(), path: b.path, entries: b.entries }; dbg('diary book: ' + b.path) }
    catch (e) { state.lastBookError = String(e?.message || e); dbg('diary book failed: ' + e) }
  }
  saveState(state)
  return { ok: true, draft }
}

const DIGEST_PROMPT = `你在为一个即将被上下文压缩的会话做「全量重要信息快照」。把下面对话里所有重要信息尽量完整地提取出来，供之后重新提炼记忆使用。
要求：
1. 分类：决策、事实、任务/待办、偏好、踩坑/错误、文件与路径、数据与版本、未决问题。
2. 每条一句话，必须具体：保留路径、命令、数字、版本号、报错原文。
3. 不要遗漏，不要编造；拿不准的标「待确认」。
4. 先写 5–10 行摘要，再给 items。
5. 只输出 JSON：{"summary":"...","items":[{"category":"...","content":"...","evidence":"...","importance":0.0}]}
6. items 最多 80 条。`

const DIGEST_PROMPT_ALL = `你在为一个会话做「项目 + 闲谈」合并快照，两边的信息都不能漏。
采集范围：
- 项目侧：决策、事实、任务/待办、文件路径、命令、数据/版本、踩坑/报错原文、未决问题。
- 闲谈侧：人物画像/喜好、xp/性癖、关系/称呼/约定、情绪与心情、AI 自己的心情与偏好、梗/玩笑、重要原话、日常事实。
要求：
1. 分类按上面两侧的具体类别命名。
2. 项目关键决策与稳定偏好/关系/AI 心情给 0.7–1.0；普通日常 0.4–0.6；寒暄 0.1–0.3。
3. 保留关键原话、路径、命令、数字、版本与报错原文，不编造。
4. 两侧都要有代表性条目，不要只偏向项目或只偏向闲聊。
5. 先写 5–10 行摘要，再给 items。
6. 只输出 JSON：{"summary":"...","items":[{"category":"...","content":"...","evidence":"...","importance":0.0}]}
7. items 最多 80 条，必须输出完整、合法的 JSON，不要截断。`

const digestPromptChat = () => `你在为一个「聊天闲谈」会话做全量重要信息快照。这段对话的价值不在项目决策，而在人本身：${ownerWho()}的喜好、xp、关系、情绪、梗，以及 AI 自己的心情与偏好。请尽量完整地提取，供之后重新提炼记忆使用。
要求：
1. 分类（括号内为必须覆盖的边缘语义）：人物画像/喜好（禁忌/雷点/底线、语言习惯/口癖、表情包偏好、审美）、xp/性癖、关系/称呼/约定（社交圈/家人朋友、亲密度变化）、梗/玩笑、情绪与心情（冲突/吵架/和解的触发与结果）、AI 自己的心情与偏好、重要原话、日常事实（健康/身体状态/作息、共同经历/回忆）、未决/约定（计划/提醒/待办、对 AI 的边界与期待）、日常杂事/生活安排、游戏/爱好（玩什么、喜欢哪款、进度、氪金/平台偏好、ID/区服）、聊天/绯闻/杂事（隐私/秘密只记“存在这条边界”，不写具体敏感细节）。
2. 人物喜好要具体（喜欢什么、讨厌什么、为什么、程度），保留关键原话，不要概括成空话。
3. 关系与称呼（怎么叫${ownerWho()}、怎么被叫、亲密度变化）单独记。
4. 情绪要写清触发事件与反应；AI 自己的心情/偏好也要记。
5. 日常寒暄不重要，可少记；稳定偏好、关系、情绪模式才重要。
6. 不要编造，拿不准标「待确认」。
7. 先写 5–10 行摘要，再给 items。
8. 只输出 JSON：{"summary":"...","items":[{"category":"...","content":"...","evidence":"...","importance":0.0}]}
9. 重要度：稳定的喜好/关系/称呼/AI 心情 0.7–1.0；普通日常 0.4–0.6；一次性寒暄 0.1–0.3。
10. items 最多 80 条。`

function parseJsonLoose(text) {
  let t = String(text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const objText = findJsonObject(t)
  if (objText) t = objText
  try { return JSON.parse(t) } catch (e) {
    // 截断修复：尽量保住已完整的 summary 与 items
    const sum = t.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    const items = []
    const re = /\{[^{}]*"content"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}/g
    let m
    while ((m = re.exec(t))) {
      try {
        const objText = m[0]
        const content = JSON.parse('"' + m[1] + '"')
        const cat = /"category"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(objText)
        const imp = /"importance"\s*:\s*([0-9.]+)/.exec(objText)
        items.push({ category: cat ? JSON.parse('"' + cat[1] + '"') : '其他', content, importance: imp ? Number(imp[1]) : 0.5 })
      } catch {}
    }
    if (sum || items.length) return { summary: sum ? JSON.parse('"' + sum[1] + '"') : '', items }
    throw e
  }
}

function deleteDigest(date, sessionId) {
  const day = String(date || '').replace(/[^0-9-]/g, '')
  const sid = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!day || !sid) return { ok: false, error: '参数不完整' }
  const base = path.join(DIGESTS(), day)
  let removed = 0
  for (const f of [path.join(base, sid + '.json'), path.join(base, sid + '.md')]) {
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed++ }
  }
  if (removed && fs.existsSync(base) && fs.readdirSync(base).length === 0) { try { fs.rmdirSync(base) } catch {} }
  return { ok: removed > 0, removed }
}

function digestList() {
  ensure(DIGESTS())
  const out = []
  for (const day of fs.readdirSync(DIGESTS()).sort().reverse()) {
    const dir = path.join(DIGESTS(), day)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const d = readJson(path.join(dir, f), null)
      if (d) out.push({ date: day, sessionId: d.sessionId, title: d.title, createdAt: d.createdAt, pct: d.pct, mode: normalizeMode(d.mode || '项目'), items: (d.items || []).length, summary: (d.summary || '').slice(0, 80) })
    }
  }
  return out.slice(0, 50)
}

async function generateDigest(ctx, session, pct, mode = '项目') {
  mode = normalizeMode(mode)
  const cfg = loadConfig()
  const route = await resolveRoute(ctx, cfg)
  const transcript = buildTranscript([{ ...session, excluded: false, messages: session.messagesRaw }], cfg)
  if (!transcript) throw new Error('会话没有可提取的内容')
  const prompt = mode === '闲聊' ? digestPromptChat() : mode === '全部' ? DIGEST_PROMPT_ALL : DIGEST_PROMPT
  const text = await callLLM(ctx, route, cfg, prompt,
    `会话：${session.title}\n工作区：${session.workspace}\n\n${transcript}\n\n注意：items 最多 60 条，必须输出完整、合法的 JSON，不要截断。`, 16000)
  const parsed = parseJsonLoose(text)
  const summary = String(parsed.summary || '').trim()
  const items = (Array.isArray(parsed.items) ? parsed.items : []).map(x => ({
    category: String(x?.category || '其他').trim(),
    content: String(x?.content || '').trim(),
    evidence: String(x?.evidence || '').slice(0, 200),
    importance: Math.min(1, Math.max(0, Number(x?.importance) || 0.5)),
  })).filter(x => x.content).slice(0, 80)
  const day = localDay()
  const dir = path.join(DIGESTS(), day); ensure(dir)
  const rec = { sessionId: session.id, title: session.title, workspace: session.workspace, createdAt: Date.now(), pct: Math.round(pct), mode, summary, items }
  writeJson(path.join(dir, `${session.id}.json`), rec)
  const groups = {}
  for (const it of items) (groups[it.category] ||= []).push(it)
  const md = `# 会话快照：${session.title}\n\n- 时间：${new Date(rec.createdAt).toLocaleString('zh-CN', { hour12: false })}\n- 上下文占用：${rec.pct}%\n- 条目：${items.length}\n\n## 摘要\n\n${summary}\n\n` +
    Object.entries(groups).map(([k, v]) => `## ${k}\n\n` + v.map(it => `- ${it.content}${it.evidence ? `\n  - 证据：${it.evidence}` : ''}`).join('\n')).join('\n\n') + '\n'
  fs.writeFileSync(path.join(dir, `${session.id}.md`), md)
  const state = loadState()
  state.lastDigest = { at: rec.createdAt, sessionId: session.id, items: items.length }
  saveState(state)
  return { ok: true, digest: rec, file: path.join(dir, `${session.id}.md`) }
}

async function checkContext(ctx) {
  const cfg = loadConfig()
  if (!cfg.enabled || !(cfg.contextThreshold > 0)) return { triggered: false }
  if (cfg.autoSnapshot === false) return { triggered: false, autoSnapshot: false, reason: '自动快照已关闭' }
  const state = loadState()
  const hits = state.contextHits || {}
  const route = await resolveRoute(ctx, cfg)
  let win = 0
  try { const info = await ctx.llm?.resolveModelInfo?.(route.provider, route.model); win = Number(info?.context?.contextWindow) || 0 } catch {}
  if (!win) return { triggered: false, error: 'contextWindow unknown' }
  const day = localDay()
  for (const s of scanSessions(cfg)) {
    if (s.excluded) continue
    const used = Number(s.maxInput) || Number(s.lastUsage?.inputTokens) || 0
    if (!used) continue
    const pct = (used / win) * 100
    const rec = hits[s.id] || {}
    const armBelow = Math.max(20, cfg.contextThreshold * 0.5)
    if (rec.armed === false && pct < armBelow) { hits[s.id] = { ...rec, armed: true }; state.contextHits = { ...hits }; saveState(state) }
    if (pct < cfg.contextThreshold) continue
    if (rec.armed === false) continue
    const at = Date.now()
    try {
      await generateDigest(ctx, s, pct, normalizeMode(cfg.autoDigestMode))
      state.lastError = ''
      if (cfg.archiveEnabled) {
        try { const a = archiveSession(s.id); dbg('archived: ' + a.path) }
        catch (e) { dbg('archive failed: ' + e); state.lastArchiveError = String(e?.message || e); saveState(state) }
      }
      if (cfg.autoRefine) {
        try {
          const rr = digestRefine(day, s.id)
          dbg('auto refine: ' + String(rr.note || ''))
        } catch (e) {
          dbg('auto refine failed: ' + e)
          state.lastError = '自动提炼失败：' + String(e?.message || e)
        }
      }
      state.contextHits = { ...hits, [s.id]: { day, at, pct: Math.round(pct), armed: false } }
      saveState(state)
    } catch (err) {
      dbg('digest generation failed: ' + err)
      state.lastError = '快照生成失败：' + String(err?.message || err)
      state.contextHits = { ...hits, [s.id]: { day, at, pct: Math.round(pct), armed: true } }
      saveState(state)
    }
    return { triggered: true, action: 'digest', session: s.id, pct: Math.round(pct) }
  }
  return { triggered: false }
}

async function contextStatus(ctx) {
  const cfg = loadConfig()
  const route = await resolveRoute(ctx, cfg)
  let win = 0
  try { const info = await ctx.llm?.resolveModelInfo?.(route.provider, route.model); win = Number(info?.context?.contextWindow) || 0 } catch {}
  const hits = loadState().contextHits || {}
  const day = localDay()
  const rows = scanSessions(cfg).filter(s => !s.excluded).map(s => {
    const used = Number(s.maxInput) || Number(s.lastUsage?.inputTokens) || 0
    return { id: s.id, title: s.title, used, pct: win ? Math.round((used / win) * 1000) / 10 : null, hitDay: hits[s.id]?.day || null }
  })
  return { autoSnapshot: cfg.autoSnapshot !== false, threshold: cfg.contextThreshold, checkMinutes: cfg.contextCheckMinutes, lastCheck: loadState().lastContextCheck || 0, contextWindow: win, route: `${route.provider}/${route.model}`, today: day, rows }
}

function typeForCategory(c, mode = '项目') {
  const s = String(c || '')
  if (mode === '闲聊' || mode === '闲谈' || mode === '聊天' || mode === '全部') {
    // 闲聊模式：先按闲聊语义整体归类，避免“日常事实/未决”回落项目门槛
    if (/xp|XP|性癖/.test(s)) return 'user_info'
    if (/游戏|爱好/.test(s)) return 'user_hobby'
    if (/关系|称呼|昵称|约定|梗|玩笑|互动/.test(s)) return 'episodic'
    if (/AI|助手|小鱼雷|自己/.test(s)) return 'episodic'
    if (/情绪|心情|感受|状态|生气|开心|难过/.test(s)) return 'episodic'
    if (/喜好|口味|爱吃|讨厌|喜欢|人物画像|朋友|家人|社交|健康|作息|日常|生活|经历|回忆|绯闻|杂事|寒暄|雷点|禁忌|底线|秘密|隐私|冲突|吵架|和解|口癖/.test(s)) return 'episodic'
    if (/未决|待办|计划|任务|想做|以后/.test(s)) return 'episodic'
    if (/重要原话|原话/.test(s)) return 'episodic'
    if (/隐私|秘密/.test(s)) return 'episodic'
    return 'episodic'
  }
  if (/决策/.test(s)) return 'important_decision_experience'
  if (/偏好/.test(s)) return 'user_info'
  if (/踩坑|错误|报错/.test(s)) return 'common_pitfalls_experience'
  if (/文件|路径|产物/.test(s)) return 'work_artifact'
  if (/任务|待办|未决/.test(s)) return 'work_task'
  if (/数据|版本|事实/.test(s)) return 'work_fact'
  return 'episodic'
}

function resolveSnapshotBookDir() {
  const raw = String(loadConfig().snapshotBookDir || '').trim()
  if (!raw) return path.join(DATA(), 'snapshot-books')
  if (raw === '~') return HOME()
  if (raw.startsWith('~/')) return path.join(HOME(), raw.slice(2))
  return path.resolve(raw)
}

function appendSnapshotBook(d) {
  const dir = resolveSnapshotBookDir()
  ensure(dir)
  const sid = String(d.sessionId || 'session').slice(-8)
  const safe = String(d.title || 'session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  const file = path.join(dir, `${sid}-${safe}.md`)
  const marker = `<!-- snapshot:${d.date} -->`
  const items = Array.isArray(d.items) ? d.items : []
  const section = `${marker}\n## ${d.date} · ${d.pct ?? '?'}% · ${items.length} 条\n\n${d.summary || ''}\n\n| 类别 | 内容 | 重要度 |\n| --- | --- | --- |\n` +
    items.map(it => `| ${it.category || ''} | ${String(it.content || '').replace(/\|/g, '\\|')} | ${Number(it.importance || 0).toFixed(2)} |`).join('\n') + '\n'
  let text = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8')
    : `# 会话快照总集 · ${d.title || ''}\n\n> 会话：${d.sessionId || ''}\n> 工作区：${d.workspace || ''}\n\n`
  if (text.includes(marker)) {
    const start = text.indexOf(marker)
    const next = text.indexOf('<!-- snapshot:', start + 1)
    text = text.slice(0, start) + section + (next >= 0 ? text.slice(next) : '')
  } else {
    text += `\n${section}`
  }
  fs.writeFileSync(file + '.tmp', text)
  fs.renameSync(file + '.tmp', file)
  return file
}

function digestRefine(date, sessionId, dryRun = false) {
  const file = path.join(DIGESTS(), String(date), String(sessionId) + '.json')
  const d = readJson(file, null)
  if (!d) throw new Error('快照不存在')
  const cfg = loadConfig()
  let bookPath = null
  if (!dryRun) {
    try { bookPath = appendSnapshotBook(d) } catch (e) { dbg('snapshot-book: ' + e) }
  }
  const mode = normalizeMode(d.mode)
  const mems = (d.items || []).map(it => ({
    content: String(it.content || '').trim(),
    type: typeForCategory(it.category, mode),
    importance: Math.min(1, Math.max(0, Number(it.importance) || 0.6)),
    category: String(it.category || ''),
  })).filter(m => m.content && m.importance >= (isProjectType(m.type) ? cfg.importanceThresholdProject : cfg.importanceThresholdChat)).slice(0, 30)
  if (!mems.length) return { ok: true, written: 0, planned: 0, skippedExisting: 0, safeToDiscard: false, bookPath, note: '没有达到入库门槛的条目' }
  if (dryRun) return { ok: true, dryRun: true, planned: mems.length, memories: mems }
  const tag = `${date}-${String(sessionId).slice(-8)}`
  const sceneRoot = (mode === '闲聊' || mode === '聊天') ? '聊天' : mode === '全部' ? '综合' : '快照'
  const w = writeMnemon(tag, mems, { sceneRoot, title: `${sceneRoot} · ${date} · ${String(sessionId).slice(-8)}`, sessionIds: [sessionId] })
  const safeToDiscard = w.planned > 0 && w.written + w.skippedExisting === w.planned
  return { ok: true, planned: w.planned, written: w.written, skippedExisting: w.skippedExisting, total: w.total, safeToDiscard, backup: w.backup, bookPath, note: `已提炼：新增 ${w.written} 条${w.skippedExisting ? `，已有 ${w.skippedExisting} 条，文档已是最新` : ''}（档案共 ${w.total} 份）` }
}

function listDrafts() {
  ensure(DRAFTS())
  return fs.readdirSync(DRAFTS()).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
    const d = readJson(path.join(DRAFTS(), f), null)
    if (!d) return null
    return { date: d.date, createdAt: d.createdAt, chars: (d.diary || '').length, memories: (d.memories || []).length, adopted: !!d.adopted, note: d.note || '' }
  }).filter(Boolean)
}

function adopt(date, dryRun = false) {
  const file = path.join(DRAFTS(), `${date}.json`)
  const d = readJson(file, null)
  if (!d) return { ok: false, error: '草稿不存在' }
  ensure(OUTBOX())
  const diaryRecord = d.diary ? [{
    content: `【日记 ${date}】\n${d.diary}`,
    type: 'episodic',
    kind: 'diary',
    scene: `日记/${date}`,
    ext_key: `diary-${date}-diary`,
    dedupe_key: `diary-${date}-diary`,
    source_id: `diary-${date}`,
    importance: 1,
  }] : []
  const candidates = (d.memories || []).map((m, i) => ({
    content: m.content, type: m.type, scene: `日记/${date}`,
    ext_key: `diary-${date}-${i + 1}`,
    dedupe_key: `diary-${date}-${i}`, source_id: `diary-${date}`, importance: m.importance,
  }))
  const records = [...diaryRecord, ...candidates]
  writeJson(path.join(OUTBOX(), `${date}.json`), { date, records, createdAt: Date.now(), status: dryRun ? 'dry-run' : 'pending-write' })
  if (dryRun) return { ok: true, dryRun: true, records: records.length, preview: records }
  let write
  try {
    write = writeMnemon(date, records, {
      sceneRoot: '日记',
      title: `日记 ${date}`,
      sessionIds: (d.sessions || []).map(s => s.id).filter(Boolean),
    })
  } catch (err) {
    d.note = '写入 mnemon 失败：' + String(err?.message || err)
    writeJson(file, d)
    return { ok: false, error: d.note, outbox: true }
  }
  d.adopted = true
  const planned = Number(write.planned || records.length)
  const written = Number(write.written || 0)
  const skippedExisting = Number(write.skippedExisting || 0)
  const safeToDiscard = planned > 0 && written + skippedExisting === planned
  d.note = `新增 ${written} 条${skippedExisting ? `（已有 ${skippedExisting} 条，文档已是最新）` : ''}，mnemon 档案共 ${write.total} 份`
  d.documentId = write.documentId || null
  writeJson(file, d)
  return { ok: true, records: records.length, planned, written, skippedExisting, total: write.total, backup: write.backup, safeToDiscard, note: d.note }
}

function overview() {
  const cfg = loadConfig()
  const state = loadState()
  let sessions = []
  try { sessions = scanSessions(cfg).map(s => ({ id: s.id, title: s.title, workspace: s.workspace, messages: s.messages, chars: s.chars, lastAt: s.lastAt, excluded: s.excluded, archived: !!s.archived })) } catch {}
  if (cfg.hideArchived) sessions = sessions.filter(s => !s.archived)
  if (!Array.isArray(cfg.includedSessions)) {
    const ids = sessions.map(s => s.id)
    cfg.includedSessions = ids
    saveConfig({ includedSessions: ids })
  }
  return { config: cfg, state, sessions, drafts: listDrafts(), digests: digestList(), whoami: listWhoami(), whoamiDirResolved: resolveWhoamiDir(cfg), whoamiCollection: whoamiCollectionFile(), archives: archiveList(), archiveDirResolved: resolveArchivePath(cfg), diaryBookResolved: resolveDiaryBookDir(cfg), snapshotBookDirResolved: resolveSnapshotBookDir() }
}

async function handle(ctx, endpoint, payload) {
  const cfg = loadConfig()
  switch (endpoint) {
    case 'overview': return overview()
    case 'config.get': return cfg
    case 'config.set': return { config: saveConfig(payload?.patch || {}) }
    case 'sessions.list': return { sessions: overview().sessions }
    case 'drafts.list': return { drafts: listDrafts() }
    case 'draft.get': return readJson(path.join(DRAFTS(), `${payload?.date}.json`), null)
    case 'draft.generate': return generate(ctx, !!payload?.force)
    case 'draft.adopt': return adopt(payload?.date, !!payload?.dryRun)
    case 'diag.writeTest': return diagWriteTest()
    case 'diag.testGenerate': return generate(ctx, true, true, payload?.sample || '')
    case 'books.openDir': {
      const dir = resolveSnapshotBookDir()
      ensure(dir)
      try { spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref() } catch (e) { dbg('books.openDir: ' + e) }
      return { ok: true, path: dir }
    }
    case 'diag.context': return contextStatus(ctx)
    case 'archive.run': return archiveSession(payload?.sessionId)
    case 'archive.open': return openArchiveDir()
    case 'archive.list': return archiveList()
    case 'archive.delete': return archiveDelete(payload?.name)
    case 'diarybook.open': return openDiaryBookDir()
    case 'whoami.list': return { whoami: listWhoami(), dir: resolveWhoamiDir(cfg), collection: whoamiCollectionFile() }
    case 'whoami.get': return getWhoami(payload?.date)
    case 'whoami.upload': return uploadWhoami(payload?.date)
    case 'whoami.uploadPersona': return uploadPersona(ctx, payload?.date)
    case 'whoami.rewritePersona': return rewritePersona(ctx)
    case 'whoami.delete': return deleteWhoami(payload?.date)
    case 'whoami.openDir': return openWhoamiDir()
    case 'docs.maintain': return runMaintenance()
    case 'plan.get': return planGet()
    case 'plan.save': return planSave(payload && payload.text)
    case 'plan.reset': return planReset()
    case 'plan.writeSkill': return planWriteSkill()
    case 'plan.openDir': return planOpenDir()
    case 'docs.stats': {
      const p2 = docPaths(documentsRoot())
      const idx = docReadIndex(p2)
      const active = idx.documents.filter(d => d.status === 'active')
      return {
        docs: idx.documents.length,
        active: active.length,
        archived: idx.documents.length - active.length,
        activeBytes: active.reduce((sum, d) => sum + (d.sizeBytes || 0), 0),
        keep: { snapshotKeep: loadConfig().snapshotKeep, diaryMergeDays: loadConfig().diaryMergeDays, diaryArchiveMonths: loadConfig().diaryArchiveMonths, capacityLimitMb: loadConfig().capacityLimitMb },
      }
    }
    case 'digest.list': return digestList()
    case 'digest.delete': return deleteDigest(payload?.date, payload?.sessionId)
    case 'digest.get': {
      const obj = readJson(path.join(DIGESTS(), String(payload?.date || ''), String(payload?.sessionId || '') + '.json'), null)
      return obj ? { ...obj, date: String(payload?.date || '') } : null
    }
    case 'digest.refine': return digestRefine(payload?.date, payload?.sessionId, !!payload?.dryRun)
    case 'digest.generate': {
      const sid = String(payload?.sessionId || '')
      const sess = scanSessions(loadConfig()).find(x => x.id === sid)
      if (!sess) throw new Error('会话不存在')
      return generateDigest(ctx, sess, 0, normalizeMode(payload?.mode))
    }
    case 'draft.discard': {
      const f = path.join(DRAFTS(), `${payload?.date}.json`)
      if (fs.existsSync(f)) fs.unlinkSync(f)
      const md = path.join(DRAFTS(), `${payload?.date}.md`)
      if (fs.existsSync(md)) fs.unlinkSync(md)
      return { ok: true }
    }
    default: throw new Error(`unknown endpoint: ${endpoint}`)
  }
}

export const name = PLUGIN
export const inject = ['tools', 'llm', 'webServer']

export function apply(ctx) {
  ensure(DATA())
  // 首次启动顺手把「记忆体检」skill 装好（已存在则不动，绝不会覆盖用户的改法）
  try {
    if (!skillStatus().exists) {
      const r = planWriteSkill()
      dbg(`首启自动安装体检 skill：${r.path}`)
    }
  } catch (e) {
    dbg(`自动安装体检 skill 失败（不影响插件）：${e && e.message}`)
  }
  dbg('apply start')
  const state = loadState()
  if (!state.nextAt) {
    state.nextAt = nextSlotFrom(Date.now(), loadConfig())
    saveState(state)
  }

  const webServer = ctx.get('webServer')
  dbg('webServer=' + String(!!webServer) + ' register=' + String(typeof webServer?.register))
  if (webServer && typeof webServer.register === 'function') {
    const dispose = webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: async (req, res) => {
        const host = String(req.headers?.host || '').split(':')[0]
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: { message: 'forbidden' } }))
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: { message: 'method not allowed' } }))
        }
        const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
        if (!pathname.startsWith(CHANNEL + '/')) {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: { message: 'unknown api path' } }))
        }
        const endpoint = pathname.slice(CHANNEL.length + 1)
        let envelopeRpcId = null
        try {
          const raw = await new Promise((resolve, reject) => {
            const chunks = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            req.on('error', reject)
          })
          const envelope = raw ? JSON.parse(raw) : {}
          envelopeRpcId = envelope.rpcId
          dbg('http rpc ' + endpoint)
          const data = await handle(ctx, endpoint, envelope.payload || {})
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: data } }))
        } catch (err) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: envelopeRpcId, result: { ok: false, error: { code: 'internal', message: String(err?.message || err) } } }))
        }
      },
    })
    dbg('webServer registered, dispose=' + typeof dispose)
    ctx.effect(() => () => { try { dispose?.() } catch {} }, `${PLUGIN}: webserver route`)
  } else {
    dbg('webServer unavailable; RPC disabled')
  }

  let running = false
  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (running) return
      const cfg = loadConfig()
      if (!cfg.enabled) return
      running = true
      try {
        const st0 = loadState()
        const every = Math.max(1, Math.round(Number(cfg.contextCheckMinutes) || 15)) * 60000
        if (Date.now() - (st0.lastContextCheck || 0) >= every) {
          st0.lastContextCheck = Date.now()
          saveState(st0)
          try { await checkContext(ctx) } catch (err) { dbg('checkContext: ' + err) }
        }
        const st1 = loadState()
        const sig = scheduleSignature(cfg)
        if (!st1.nextAt || st1.scheduleSig !== sig) {
          // 配置变了（时刻/间隔/锚点）就按新规则重排，不改锚点本身
          st1.nextAt = nextSlotFrom(Date.now(), cfg)
          st1.scheduleSig = sig
          saveState(st1)
        }
        if (Date.now() >= st1.nextAt) await generate(ctx, false)
      } catch (err) { const st = loadState(); st.lastError = String(err?.message || err); saveState(st) }
      finally { running = false }
    }, 60 * 1000)
    return () => clearInterval(timer)
  }, `${PLUGIN}: scheduler`)
}

export const __test = { scanSessions, readSession, walkSessionFiles, nextSlotFrom, normalizeDailyAt, scheduleSignature, writeMnemon, writeDocument, documentsRoot, docPaths, renderDocument, diagWriteTest, adopt, listDrafts, loadConfig, writeWhoami, listWhoami, uploadWhoami, deleteWhoami, uploadPersona, rewritePersona, extractPersonaSection, dropPersonaSection, looksTruncatedPersona, cleanPersonaBody, splitPersonaDoc, stripPersonaBlock, summarizePersona, writePersonaBlock, resolvePersonaFile, rebuildWhoamiCollection, resolveWhoamiDir, whoamiCollectionFile, getWhoami, whoamiKeepCount, keepSingleDocument, documentBodyOf, planGet, planSave, planReset, planWriteSkill, planFile, planTemplate, skillFile, skillStatus, extractSkillSection, maintainDocuments, runMaintenance, archiveRecordUnlocked, upsertUnlocked, persistIndex, DIARY_DAY_RE, DIARY_MONTH_RE }
