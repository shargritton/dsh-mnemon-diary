/**
 * dsh-mnemon-diary — 客户端半边。
 * Settings → 每日日记：配置、会话剔除、草稿查看/生成/采纳。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mnemon-diary',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    const S = {
      wrap: { padding: '10px 6px', fontSize: 13, lineHeight: 1.6, color: 'inherit', boxSizing: 'border-box' },
      card: { border: '1px solid rgba(127,127,127,.18)', borderRadius: 12, padding: 16, marginBottom: 16, background: 'rgba(127,127,127,.035)' },
      title: { fontWeight: 600, marginBottom: 12, letterSpacing: '.01em' },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 },
      label: { opacity: .7, minWidth: 112 },
      input: { width: 88, height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', boxSizing: 'border-box' },
      btn: { height: 30, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12.5 },
      btnPrimary: { height: 30, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(80,140,255,.55)', background: 'rgba(80,140,255,.12)', color: 'inherit', cursor: 'pointer', fontSize: 12.5 },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', fontWeight: 500, opacity: .7, padding: '8px 10px', borderBottom: '1px solid rgba(127,127,127,.22)', fontSize: 12 },
      td: { padding: '8px 10px', borderBottom: '1px solid rgba(127,127,127,.1)', verticalAlign: 'top' },
      err: { color: '#e5534b', whiteSpace: 'pre-wrap', margin: '6px 0' },
      ok: { color: '#2da44e', margin: '6px 0' },
      pre: { whiteSpace: 'pre-wrap', background: 'rgba(127,127,127,.08)', padding: 10, borderRadius: 8, maxHeight: 260, overflow: 'auto' },
      muted: { opacity: .6 },
    }

    function yes(v) { return v ? '是' : '否' }
    function fmtTime(ts) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—' }

    function Section(props) {
      const call = props.call
      const callAny = props.callAny
      const [ov, setOv] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [err, setErr] = useState('')
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState('')
      const [openDrafts, setOpenDrafts] = useState([])
      const [openDigests, setOpenDigests] = useState([])
      const [openWhoami, setOpenWhoami] = useState([])
      const [whoamiBusy, setWhoamiBusy] = useState('')
      const [whoamiProgress, setWhoamiProgress] = useState(null)
      const [whoamiTick, setWhoamiTick] = useState(0)
      const [digestBusy, setDigestBusy] = useState(null)
      const [digestElapsed, setDigestElapsed] = useState(0)
      const [digestStatus, setDigestStatus] = useState(null)
      const [genBusy, setGenBusy] = useState(false)
      const [genElapsed, setGenElapsed] = useState(0)
      const [genStatus, setGenStatus] = useState(null)
      const [adoptBusy, setAdoptBusy] = useState('')
      const [reviewInfo, setReviewInfo] = useState(null)
      const [reviewErr, setReviewErr] = useState('')
      const [reviewBusy, setReviewBusy] = useState(false)
      const [adoptElapsed, setAdoptElapsed] = useState(0)
      const [adoptStatus, setAdoptStatus] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [confirmBox, setConfirmBox] = useState(null)
      const [planText, setPlanText] = useState(null)
      const [planInfo, setPlanInfo] = useState(null)
      const [planBusy, setPlanBusy] = useState('')
      const [planMsg, setPlanMsg] = useState('')
      const [planErr, setPlanErr] = useState('')
      const [job, setJob] = useState(null)
      const [jobElapsed, setJobElapsed] = useState(0)

      async function load() {
        try {
          const d = await call('overview')
          setOv(d)
          setCfg(d.config)
          setErr('')
        } catch (e) { setErr(String(e && e.message || e)) }
      }
      useEffect(() => { load() }, [])

      const REVIEW_ID = 'automation_4edc522f-c2fb-44b0-98e0-053a92afa6c9'
      const REVIEW_NAME = '记忆月度体检（mnemon）'
      const REVIEW_PROMPT = [
        '执行每月一次的记忆体检（mnemon 记忆插件），让记忆像人一样会忘：只留还重要的，删前先归档。',
        '',
        '【第一步】调用 skill 工具加载技能 `mnemon-memory-review`，严格按它的预算、遗忘顺序和归档规则执行。',
        '如果加载失败（skill 未安装），不要慌：直接按本提示里的规则执行，并在报告开头注明「skill 缺失，按内置规则执行」。插件启动时会自动安装该 skill，正常情况下它应该在。',
        '',
        '【要点重申】',
        '1. 只通过 mnemon 工具改记忆：`mnemon_runtime_memory`（action=add/replace/remove；target=memory 或 user）。绝对不要直接编辑 ~/.mnemon/runtime/*.md。',
        '2. 预算：MEMORY.md ≤ 6KB 且 15–40 条；USER.md ≤ 3KB 且 8–20 条。超了才动手，没超就只做去重和过期清理。',
        '3. 顺序：去重合并 → 降级 → 过期清理（先写归档文档，确认成功后再 remove）→ 时效淘汰。critical 且属于用户明说「记住」的、安全/权限规则、人格身份，一律不动。',
        '4. 归档：删任何条目前，先把原文整段写入文档 `记忆归档 YYYY-MM`（用 `mnemon_document_create`；同名已存在就用 `mnemon_document_manage` 更新追加）。归档失败就不许删除。',
        '5. 顺手整理文档库（大部分插件已自动做，这里只做兜底确认）：`日记 <日期>` 超过 30 天应已并进 `日记合辑 YYYY-MM`、合辑超过 12 个月应已归档；`快照 · …` 只应留最近 20 份。发现漏做的用 `mnemon_document_manage` 补归档；`我是谁` 不动。',
        '6. 必须先读原文再判断，不许凭标题猜。',
        '',
        '【输出】结束时给一份简短报告：MEMORY/USER 条数与字节数（前→后）、归档 N 条、合并 N 组、降级 N 条、跳过 N 条（附理由）、当前总量与预算比例。报告直接写在回复末尾，不建额外文件。若本月无事可做，就回「本月无需调整」并给出当前条数与占用。'
      ].join('\n')

      let reviewId = REVIEW_ID
      function findReview(snap) {
        const list = (snap && snap.automations) || []
        return list.find(a => a.id === reviewId) || list.find(a => a.name === REVIEW_NAME) || null
      }
      // 首次使用（或任务被删）时自动建好这条月度体检，用户不用自己动手
      async function ensureReview() {
        const snap = await callAny('/dsh-automation', 'snapshot', { sessionId: 'settings' })
        const found = findReview(snap)
        if (found) { reviewId = found.id; return { def: found, created: false } }
        const r = await callAny('/dsh-automation', 'create', {
          sessionId: 'settings',
          input: {
            name: REVIEW_NAME,
            prompt: REVIEW_PROMPT,
            schedule: { kind: 'monthly', day: 1, time: '04:00' },
            timeZone: 'Asia/Shanghai',
            permission: 'danger-full-access',
            maxConcurrentRuns: 1
          }
        })
        const id = (r && r.id) || ''
        if (!id) throw new Error('创建体检任务失败：没有返回 id')
        reviewId = id
        const snap2 = await callAny('/dsh-automation', 'snapshot', { sessionId: 'settings' })
        return { def: findReview(snap2), created: true }
      }
      async function loadReview() {
        if (!callAny) { setReviewErr('当前页面拿不到定时任务服务，请刷新后重试'); return }
        try {
          const snap = await callAny('/dsh-automation', 'snapshot', { sessionId: 'settings' })
          let def = findReview(snap)
          if (!def) {
            // 打开设置页就顺手把体检任务备好，新手不用自己建
            try {
              const e = await ensureReview()
              def = e.def
            } catch (e) { setReviewErr('自动创建体检任务失败：' + String(e && e.message || e)) }
          }
          setReviewInfo(def || null)
          if (def) setReviewErr('')
        } catch (e) { setReviewErr(String(e && e.message || e)) }
      }
      useEffect(() => { loadReview() }, [])
      async function runReview() {
        setReviewBusy(true)
        let skillNote = ''
        try {
          // 体检要用的 skill 不存在时先自动装好，别让新会话空手跑
          try {
            const st = await call('plan.get')
            if (!st.skill || !st.skill.exists) {
              const w = await call('plan.writeSkill')
              skillNote = '已先自动安装体检 skill：' + w.path
              setPlanInfo(prev => ({ ...(prev || {}), skill: w.skill }))
            }
          } catch (e) {
            skillNote = '体检 skill 检查失败（不影响排队）：' + String(e && e.message || e)
          }
          // 任务不存在就现建一条（首次使用的情况），再排一次运行
          let createdNote = ''
          try {
            const e = await ensureReview()
            if (e.created) createdNote = '已自动创建「记忆月度体检（mnemon）」（每月 1 日 04:00）'
          } catch (e) {
            createdNote = '自动创建体检任务失败（不影响只跑这一次）：' + String(e && e.message || e)
          }
          const r = await callAny('/dsh-automation', 'run-now', { automationId: reviewId, sessionId: 'settings' })
          setDialog({
            title: '记忆体检已排队 ✅',
            lines: [skillNote, createdNote, 'runId：' + ((r && r.runId) || '（已提交）'), '它会在一个新会话里执行，跑完那份报告就是体检结果。'].filter(Boolean),
            hint: '如果两三分钟都没有新会话出现，说明自动流程没起来，请用下面的「手动体检」方案。'
          })
          setTimeout(() => { loadReview() }, 3000)
        } catch (e) {
          setDialog({
            title: '启动失败 ❌',
            lines: [String(e && e.message || e)],
            hint: '自动流程不可用时请手动体检：在任意会话里对我说「加载 skill mnemon-memory-review，做一次记忆体检」。'
          })
        } finally { setReviewBusy(false) }
      }
      useEffect(() => {
        if (!digestBusy) return
        setDigestElapsed(0)
        const t = setInterval(() => setDigestElapsed(v => v + 1), 1000)
        return () => clearInterval(t)
      }, [digestBusy])
      useEffect(() => {
        if (!job) { setJobElapsed(0); return }
        setJobElapsed(0)
        const t = setInterval(() => setJobElapsed(v => v + 1), 1000)
        return () => clearInterval(t)
      }, [job])

      useEffect(() => {
        if (!genBusy) return
        setGenElapsed(0)
        const t = setInterval(() => setGenElapsed(v => v + 1), 1000)
        return () => clearInterval(t)
      }, [genBusy])
      useEffect(() => {
        if (!adoptBusy) return
        setAdoptElapsed(0)
        const t = setInterval(() => setAdoptElapsed(v => v + 1), 1000)
        return () => clearInterval(t)
      }, [adoptBusy])
      useEffect(() => {
        if (!whoamiProgress) return
        const t = setInterval(() => setWhoamiTick(v => v + 1), 500)
        return () => clearInterval(t)
      }, [whoamiProgress])

      async function loadPlan() {
        setPlanErr('')
        try {
          const r = await call('plan.get')
          setPlanText(r.text)
          setPlanInfo({ path: r.path, chars: r.chars, skill: r.skill })
        } catch (e) { setPlanErr('读取方案失败：' + String(e && e.message || e)) }
      }
      function resetPlan() {
        setConfirmBox({
          title: '恢复默认方案？',
          text: '会用插件自带的方案模板覆盖当前「记忆存储方案.md」（旧版先备份到 backups/）。\n写进去的自定义内容会丢，确定吗？',
          onOk: async () => {
            setPlanBusy('reset'); setPlanMsg(''); setPlanErr('')
            try {
              const r = await call('plan.reset')
              setPlanText(r.text)
              setPlanInfo({ path: r.path, chars: r.chars, skill: r.skill })
              setPlanMsg('已恢复默认模板' + (r.backup ? '（旧版备份：' + r.backup + '）' : ''))
            } catch (e) { setPlanErr('恢复失败：' + String(e && e.message || e)) }
            finally { setPlanBusy('') }
          }
        })
      }
      async function installSkill() {
        setPlanBusy('skill'); setPlanMsg(''); setPlanErr('')
        try {
          const r = await call('plan.writeSkill')
          setPlanInfo(prev => ({ ...(prev || {}), skill: r.skill }))
          setDialog({
            title: '已安装记忆体检 skill ✅',
            lines: ['写入：' + r.path, '字数：' + r.chars, '旧版备份：' + (r.backup || '（原本没有，未覆盖）')],
            hint: 'skill 目录是即时扫描的，不用重启；下次说「记忆体检」我就能直接用。'
          })
        } catch (e) { setPlanErr('安装 skill 失败：' + String(e && e.message || e)) }
        finally { setPlanBusy('') }
      }
      useEffect(() => { if (planText != null && planInfo == null) loadPlan() }, [planText])

      async function save(patch) {
        setBusy('save'); setMsg('')
        try {
          const r = await call('config.set', { patch: patch || cfg })
          setCfg(r.config)
          setMsg('已保存')
          await load()
        } catch (e) { setErr(String(e && e.message || e)) } finally { setBusy('') }
      }
      async function generate() {
        if (genBusy) return
        setGenBusy(true)
        setGenStatus({ kind: 'busy', text: '正在生成日记…' })
        const t0 = Date.now()
        try {
          const r = await call('draft.generate', { force: true })
          const sec = Math.round((Date.now() - t0) / 1000)
          if (r && r.skipped) {
            setGenStatus({ kind: 'ok', text: `这次偷懒了：概率命中，未生成草稿（用时 ${sec}s）` })
            setDialog({ title: '这次偷懒了 😴', lines: ['概率命中，没有生成日记草稿。'], hint: '想补写的话再点一次「立即生成」。' })
          } else {
            const d = r && r.draft ? r.draft : r
            setGenStatus({ kind: 'ok', text: `日记已生成：${(d?.diary || '').length} 字 · ${(d?.memories || []).length} 条候选（用时 ${sec}s）` })
            setDialog({ title: '日记生成成功 ✅', lines: [`字数：${(d?.diary || '').length}`, `候选记忆：${(d?.memories || []).length} 条`, `用时：约 ${sec}s`], hint: '草稿已保存，可以去「日记草稿」里查看。' })
          }
          await load()
        } catch (e) {
          setGenStatus({ kind: 'err', text: '日记生成失败：' + String(e && e.message || e) })
          setDialog({ title: '日记生成失败 ❌', lines: [String(e && e.message || e)], hint: '检查配置/网络后可重试。' })
        } finally { setGenBusy(false) }
      }
      async function toggleDraft(date) {
        if (openDrafts.some(x => x.date === date)) {
          setOpenDrafts(openDrafts.filter(x => x.date !== date))
          return
        }
        try { const d = await call('draft.get', { date }); setOpenDrafts([...openDrafts, d]) }
        catch (e) { setErr(String(e && e.message || e)) }
      }
      async function adopt(date) {
        if (adoptBusy) return
        setAdoptBusy(date)
        setAdoptStatus({ kind: 'busy', text: '正在上传记忆…' })
        const t0 = Date.now()
        try {
          const r = await call('draft.adopt', { date })
          const sec = Math.round((Date.now() - t0) / 1000)
          const safe = r?.safeToDiscard !== false
          const skipped = Number(r?.skippedExisting || 0)
          const remaining = Math.max(0, Number(r?.planned || 0) - Number(r?.written || 0) - skipped)
          const extra = safe
            ? (skipped > 0 ? ` · 已有 ${skipped} 条，文档内容已是最新，可以放心删除草稿` : ' · 已全部写入 mnemon 档案，可以放心删除草稿')
            : ` · 还有 ${remaining} 条未写入，先别删草稿`
          setAdoptStatus({ kind: safe ? 'ok' : 'err', text: `已上传：新增 ${r?.written ?? 0} 条${skipped ? `（已有 ${skipped} 条）` : ''}，累计 ${r?.total ?? '?'} 条（用时 ${sec}s）${extra}` })
          const lines = [`计划写入：${r?.planned ?? 0} 条`, `本次新增：${r?.written ?? 0} 条`]
          if (skipped > 0) lines.push(`已是最新：${skipped} 条`)
          if (r?.total != null) lines.push(`累计入库：${r.total} 条`)
          lines.push(`用时：约 ${sec}s`)
          if (r?.backup) lines.push(`数据库备份：${r.backup}`)
          setDialog(safe
            ? { title: '上传成功 ✅', lines, hint: '草稿内容已进入记忆库，可以放心删除这份草稿。' }
            : { title: '上传完成（未全部写入）❌', lines: [...lines, `未写入：${remaining} 条`], hint: '还有条目没进记忆库，先别删草稿。' })
          await load()
        } catch (e) {
          setAdoptStatus({ kind: 'err', text: '上传失败：' + String(e && e.message || e) })
          setDialog({ title: '上传失败 ❌', lines: [String(e && e.message || e)], hint: '草稿没有删除，可以稍后重试。' })
        } finally { setAdoptBusy('') }
      }
      function askConfirm(text, onOk) { setConfirmBox({ text, onOk }) }

      function discard(date) {
        askConfirm(`确定删除草稿「${date}」？\n删除后不可恢复。`, async () => {
          try { await call('draft.discard', { date }); setMsg('草稿已删除'); setOpenDrafts(openDrafts.filter(x => x.date !== date)); await load() }
          catch (e) { setErr(String(e && e.message || e)) }
        })
      }

      async function toggleWhoami(date) {
        if (openWhoami.some(x => x.date === date)) {
          setOpenWhoami(openWhoami.filter(x => x.date !== date))
          return
        }
        try { const d = await call('whoami.get', { date }); setOpenWhoami([...openWhoami, d]) }
        catch (e) { setErr(String(e && e.message || e)) }
      }
      async function uploadWhoami(date) {
        if (whoamiBusy) return
        setWhoamiBusy(date)
        setWhoamiProgress({ date, kind: 'upload', started: Date.now() })
        try {
          const r = await call('whoami.upload', { date })
          setDialog({
            title: '已上传「我是谁」✅',
            lines: [`日期：${r.date}`, `记忆合集：共 ${r.entries} 篇`, `文档「我是谁」：${r.created ? '新建' : r.updated ? '更新' : '已是最新'}`],
            hint: '「我是谁」只保留一份文档，会随每次上传逐渐更新。',
          })
          await load()
        } catch (e) {
          setDialog({ title: '上传失败 ❌', lines: [String(e && e.message || e)], hint: '可以稍后重试。' })
        } finally { setWhoamiBusy(''); setWhoamiProgress(null) }
      }
      async function uploadPersona(date) {
        if (whoamiBusy) return
        setWhoamiBusy(date + '::persona')
        setWhoamiProgress({ date, kind: 'persona', started: Date.now() })
        try {
          const r = await call('whoami.uploadPersona', { date })
          setDialog({
            title: '已归纳进全局人格 ✅',
            lines: [`日期：${r.date}`, `人格文件：${r.file}`, `归纳后 ${r.chars} 字`],
            hint: '只更新文件里「我是谁（自动归纳）」那一段，其余人格设置原样保留，改前会自动备份。',
          })
          await load()
        } catch (e) {
          const why = String(e && e.message || e)
          setDialog({ title: '归纳失败 ❌', lines: [why], hint: /unknown endpoint/i.test(why) ? '插件后端还是旧代码（界面是热加载的，插件不会自动重载），重启 DSH 后再试。' : '可以稍后重试；每次写入前都会自动备份人格文件。' })
        } finally { setWhoamiBusy(''); setWhoamiProgress(null) }
      }
      function rewritePersona(date) {
        askConfirm('重写人格会把「旧人格」和「我是谁」一起重新总结，整份人格文件全部覆盖。\n写之前会自动备份，确认要重写吗？', async () => {
          if (whoamiBusy) return
          setWhoamiBusy(date + '::rewrite')
          setWhoamiProgress({ date, kind: 'rewrite', started: Date.now() })
          try {
            const r = await call('whoami.rewritePersona', { date })
            setDialog({
              title: '人格已重写 ✅',
              lines: [`人格文件：${r.file}`, `重写后 ${r.chars} 字`, `使用模型：${r.model || '默认'}`],
              hint: '整份人格已按新内容重写，旧版本已备份到 mnemon-diary/backups/。',
            })
            await load()
          } catch (e) {
            const why = String(e && e.message || e)
            setDialog({ title: '重写失败 ❌', lines: [why], hint: /unknown endpoint/i.test(why) ? '插件后端还是旧代码，重启 DSH 后再试。' : '旧人格没有被改动；可以稍后重试。' })
          } finally { setWhoamiBusy(''); setWhoamiProgress(null) }
        })
      }
      function deleteWhoami(date) {
        askConfirm(`确定删除「我是谁」记录「${date}」？\n只删这件生成物，已上传进记忆库的合集不受影响。`, async () => {
          try { await call('whoami.delete', { date }); setOpenWhoami(openWhoami.filter(x => x.date !== date)); setMsg('「我是谁」记录已删除'); await load() }
          catch (e) { setErr(String(e && e.message || e)) }
        })
      }

      async function toggleDigest(d) {
        const key = d.date + '::' + d.sessionId
        if (openDigests.some(x => x.date + '::' + x.sessionId === key)) {
          setOpenDigests(openDigests.filter(x => x.date + '::' + x.sessionId !== key))
          return
        }
        try { const dg = await call('digest.get', { date: d.date, sessionId: d.sessionId }); setOpenDigests([...openDigests, dg]) }
        catch (e) { setErr(String(e && e.message || e)) }
      }
      function deleteDigest(d) {
        askConfirm(`确定删除快照「${d.title || d.sessionId}」？\n只删快照文件，不会撤销已提炼的记忆。`, async () => {
        try {
          const r = await call('digest.delete', { date: d.date, sessionId: d.sessionId })
          if (r && r.ok === false) { setErr(r.error || '删除失败'); return }
          setOpenDigests(openDigests.filter(x => !(x.date === d.date && x.sessionId === d.sessionId)))
          setMsg('快照已删除')
          await load()
        } catch (e) { setErr(String(e && e.message || e)) }
        })
      }

      async function refineDigest(target) {
        const dg = target || null
        if (!dg) return
        setBusy('refine'); setJob({ label: '正在上传记忆…' }); setMsg(''); setErr('')
        try {
          const r = await call('digest.refine', { date: dg.date, sessionId: dg.sessionId })
          if (r && r.ok === false) {
            setDialog({ title: '上传失败 ❌', lines: [r.error || '未知错误'], hint: '快照没有删除，可以稍后重试。' })
          } else {
            const written = Number(r?.written || 0)
            const skipped = Number(r?.skippedExisting || 0)
            const planned = Number(r?.planned || 0)
            const remaining = Math.max(0, planned - written - skipped)
            const lines = [`计划写入：${planned} 条`, `本次新增：${written} 条`]
            if (skipped > 0) lines.push(`已是最新：${skipped} 条`)
            if (r?.total != null) lines.push(`该会话累计入库：${r.total} 条`)
            if (r?.backup) lines.push(`数据库备份：${r.backup}`)
            if (r?.bookPath) lines.push(`快照合集：${r.bookPath}`)
            const safe = r?.safeToDiscard !== false && remaining === 0
            setDialog(safe
              ? { title: '上传成功 ✅', lines, hint: skipped > 0 ? '全部条目都已在记忆库中，可以放心删除这条快照。' : '已经写进记忆库，可以放心删除这条快照。' }
              : { title: '上传完成（未全部写入）', lines: [...lines, `未写入：${remaining} 条`], hint: '还有条目未进入记忆库，建议先别删快照。' })
            await load()
          }
        } catch (e) {
          setDialog({ title: '上传失败 ❌', lines: [String(e && e.message || e)], hint: '快照没有删除，可以稍后重试。' })
        } finally { setBusy(''); setJob(null) }
      }
      function digestMarkdown(d) {
        const lines = []
        lines.push(`# 会话快照 · ${d.title || ''}`, '')
        lines.push(`- 日期：${d.date || ''}`)
        lines.push(`- 会话：${d.sessionId || ''}`)
        if (d.pct != null) lines.push(`- 上下文占用：${d.pct}%`)
        lines.push(`- 条目：${(d.items || []).length}`, '')
        lines.push('## 摘要', '', d.summary || '（空）', '')
        lines.push('## 要点', '', '| 类别 | 内容 | 重要度 |', '| --- | --- | --- |')
        for (const it of d.items || []) lines.push(`| ${it.category || ''} | ${String(it.content || '').replace(/\|/g, '\\|')} | ${Number(it.importance || 0).toFixed(2)} |`)
        return lines.join('\n')
      }
      function downloadText(name, text) {
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      async function exportDigest(d) {
        try {
          const full = d && Array.isArray(d.items) ? d : await call('digest.get', { date: d.date, sessionId: d.sessionId })
          const sid = String(full.sessionId || d.sessionId || '').slice(-8)
          const name = `mnemon-diary-snapshot-${full.date || d.date}-${sid}.md`
          downloadText(name, digestMarkdown(full))
          setMsg(`已导出：${name}`)
          setDialog({ title: '导出成功 ✅', lines: [`文件：${name}`], hint: '已保存到浏览器默认下载目录。' })
        } catch (e) { setErr(String(e && e.message || e)) }
      }

      async function setSessionMode(id, mode) {
        const next = { ...(cfg.sessionModes || {}), [id]: mode }
        setCfg({ ...cfg, sessionModes: next })
        try {
          const r = await call('config.set', { patch: { sessionModes: next } })
          if (r && r.config) setCfg(r.config)
        } catch (e) { setErr(String(e && e.message || e)) }
      }

      function deleteArchive(name) {
        askConfirm(`确定删除归档文件？\n${name}\n\n本地文件会一起删除，不可恢复。`, async () => {
          setBusy('archive-del'); setMsg(''); setErr('')
          try { const r = await call('archive.delete', { name }); setMsg(`已删除：${r.removed}`); await load() }
          catch (e) { setErr('删除失败：' + String(e && e.message || e)) }
          finally { setBusy('') }
        })
      }

      async function openDiaryBookDir() {
        try { const r = await call('diarybook.open'); setMsg(`已打开日记合集目录：${r.dir}`) }
        catch (e) { setErr('打开日记合集目录失败：' + String(e && e.message || e)) }
      }

      async function openArchiveDir() {
        try { const r = await call('archive.open'); setMsg(`已打开归档目录：${r.dir}`) }
        catch (e) { setErr('打开归档目录失败：' + String(e && e.message || e)) }
      }

      async function archiveNow(sessionId) {
        setBusy('archive'); setJob({ label: '正在归档完整会话…' }); setMsg(''); setErr('')
        try {
          const r = await call('archive.run', { sessionId })
          const mb = ((r?.bytes || 0) / 1048576).toFixed(2)
          setMsg(`已归档：${r.path}（${r.messages} 条，${mb} MB）`)
          setDialog({ title: '归档成功 ✅', lines: [`消息：${r.messages} 条`, `大小：${mb} MB`, `路径：${r.path}`], hint: '可以去「已生成归档」里查看或删除。' })
          await load()
        } catch (e) { setErr('归档失败：' + String(e && e.message || e)); setDialog({ title: '归档失败 ❌', lines: [String(e && e.message || e)], hint: '可重试，或检查归档目录权限。' }) }
        finally { setBusy(''); setJob(null) }
      }

      async function makeDigest(sessionId, mode) {
        const sess = (ov.sessions || []).find(x => x.id === sessionId)
        const title = sess ? sess.title : String(sessionId).slice(-8)
        setDigestBusy(sessionId)
        setDigestStatus({ kind: 'busy', text: `正在为「${title}」生成快照…` })
        const t0 = Date.now()
        try {
          const r = await call('digest.generate', { sessionId, mode })
          const n = r.digest?.items?.length || 0
          setDigestStatus({ kind: 'ok', text: `快照已生成：${n} 条（用时 ${Math.round((Date.now() - t0) / 1000)}s）` })
          if (r.digest) setOpenDigests(prev => [...prev, r.digest])
          await load()
        } catch (e) {
          setDigestStatus({ kind: 'err', text: '快照生成失败：' + String(e && e.message || e) })
        } finally { setDigestBusy(null) }
      }

      if (!ov || !cfg) return h('div', { style: S.wrap }, err ? h('div', { style: S.err }, err) : '加载中…')

      const included = new Set(Array.isArray(cfg.includedSessions) ? cfg.includedSessions : ov.sessions.filter(s => !s.excluded).map(s => s.id))
      const toggleSession = (id, on) => {
        const next = new Set(included)
        if (on) next.add(id); else next.delete(id)
        save({ includedSessions: Array.from(next) })
      }

      const cfgRow = (label, node) => h('div', { style: S.row }, h('span', { style: S.label }, label), node)

      function draftDetail(dd) {
        return h('div', { key: dd.date, style: { marginTop: 8, marginLeft: 18, paddingLeft: 12, borderLeft: '2px solid rgba(127,127,127,.25)' } },
          h('div', { style: S.title }, `${ov.drafts.findIndex(x => x.date === dd.date) + 1}. ${dd.date} 草稿`),
          h('div', { style: S.pre }, dd.diary || '（空）'),
          h('details', null,
            h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `重要记忆候选（${(dd.memories || []).length} 条，点此展开）`),
            h('table', { style: S.table },
              h('thead', null, h('tr', null, ['类型', '内容', '重要度'].map((t, i) => h('th', { key: i, style: S.th }, t)))),
              h('tbody', null, (dd.memories || []).map((m, i) => h('tr', { key: i },
                h('td', { style: S.td }, m.type),
                h('td', { style: S.td }, m.content),
                h('td', { style: S.td }, Number(m.importance).toFixed(2))))))))
      }
      function digestDetail(dg) {
        return h('div', { key: dg.date + '::' + dg.sessionId, style: { marginTop: 8, marginLeft: 18, paddingLeft: 12, borderLeft: '2px solid rgba(127,127,127,.25)' } },
          h('div', { style: S.title }, `${dg.title} 快照`),
          h('div', { style: S.pre }, dg.summary || '（空）'),
          h('details', null,
            h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `要点（${(dg.items || []).length} 条，点此展开）`),
            h('table', { style: S.table },
              h('thead', null, h('tr', null, ['类别', '内容', '重要度'].map((t, i) => h('th', { key: i, style: S.th }, t)))),
              h('tbody', null, (dg.items || []).map((it, i) => h('tr', { key: i },
                h('td', { style: S.td }, it.category),
                h('td', { style: S.td }, it.content),
                h('td', { style: S.td }, Number(it.importance).toFixed(2))))))))
      }

      return h('div', { style: S.wrap },

        adoptStatus ? h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: adoptStatus.kind === 'err' ? S.err : adoptStatus.kind === 'ok' ? S.ok : S.muted }, adoptStatus.text),
          adoptBusy ? h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden', marginTop: 8 } },
            h('div', { style: { height: '100%', width: `${Math.min(95, 10 + adoptElapsed * 4)}%`, background: '#4f8cff', transition: 'width 1s linear' } })) : null,
          adoptBusy ? h('div', { style: { ...S.muted, marginTop: 6 } }, `已等待 ${adoptElapsed}s，正在备份并上传记忆…`) : null) : null,

        job ? h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: S.muted }, job.label),
          h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden', marginTop: 8 } },
            h('div', { style: { height: '100%', width: `${Math.min(95, 8 + jobElapsed * 3)}%`, background: '#4f8cff', transition: 'width 1s linear' } })),
          h('div', { style: { ...S.muted, marginTop: 6 } }, `已等待 ${jobElapsed}s`)) : null,

        genStatus ? h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: genStatus.kind === 'err' ? S.err : genStatus.kind === 'ok' ? S.ok : S.muted }, genStatus.text),
          genBusy ? h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden', marginTop: 8 } },
            h('div', { style: { height: '100%', width: `${Math.min(95, 8 + genElapsed * 2)}%`, background: '#4f8cff', transition: 'width 1s linear' } })) : null,
          genBusy ? h('div', { style: { ...S.muted, marginTop: 6 } }, `已等待 ${genElapsed}s，通常需要 30–90 秒；完成后这里会显示结果`) : null) : null,

        digestStatus ? h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: digestStatus.kind === 'err' ? S.err : digestStatus.kind === 'ok' ? S.ok : S.muted }, digestStatus.text),
          digestBusy ? h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden', marginTop: 8 } },
            h('div', { style: { height: '100%', width: `${Math.min(95, 8 + digestElapsed * 2)}%`, background: '#4f8cff', transition: 'width 1s linear' } })) : null,
          digestBusy ? h('div', { style: { ...S.muted, marginTop: 6 } }, `已等待 ${digestElapsed}s，通常需要 30–90 秒；完成后这里会显示结果`) : null) : null,

        h('div', { style: { display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap' } },
        h('div', { style: { ...S.card, flex: '1 1 420px', minWidth: 340, marginBottom: 16 } },
          h('details', { open: true }, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '每日日记（点此展开）'),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px', margin: '4px 0 8px' } },
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, '立即生成（点一次，两项一起生成）'),
            h('div', { style: S.row },
              h('span', { style: S.muted }, `下次生成：${fmtTime(ov.state.nextAt)}　上次：${fmtTime(ov.state.lastRunAt)}${ov.state.lastSkip ? '　最近偷懒：' + fmtTime(ov.state.lastSkip) : ''}`),
              h('button', { style: S.btnPrimary, disabled: genBusy || !!busy, onClick: generate }, genBusy ? '生成中…' : '立即生成')),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: 6, lineHeight: 1.7 } },
              '包含两项：①【生成日记】今天发生了什么（心情、闲聊、项目进展与踩坑）；②【生成我是谁】我是谁、和人的默契、最近的变化。',
              h('br', null),
              '结果分别出现在下面「日记草稿」和「记录我是谁」面板里；日记要再点「上传记忆」才会写进记忆库。')),
          ov.state.lastError ? h('div', { style: S.err }, '最近错误：' + ov.state.lastError) : null,
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 2px', margin: '4px 0 8px' } },
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, '基础设置'),
          cfgRow('生成间隔（天）', h('select', { style: S.input, value: cfg.intervalDays, onChange: e => setCfg({ ...cfg, intervalDays: Number(e.target.value) }) },
            [1, 2, 3, 4, 5, 6, 7].map(n => h('option', { key: n, value: n }, n)))),
          cfgRow('固定生成时间', h('span', null,
            h('input', { style: S.input, type: 'time', value: cfg.dailyAt || '23:00', onChange: e => setCfg({ ...cfg, dailyAt: e.target.value }) }),
            h('span', { style: S.muted }, '　每 N 天在这一刻生成；改完保存会以今天为新锚点'))),
          cfgRow('偷懒概率', h('input', { style: S.input, type: 'number', step: 0.05, value: cfg.skipProbability, onChange: e => setCfg({ ...cfg, skipProbability: Number(e.target.value) }) })),
          cfgRow('日记字数范围', h('span', null,
            h('input', { style: S.input, type: 'number', value: cfg.minChars, onChange: e => setCfg({ ...cfg, minChars: Number(e.target.value) }) }),
            ' – ',
            h('input', { style: S.input, type: 'number', value: cfg.maxChars, onChange: e => setCfg({ ...cfg, maxChars: Number(e.target.value) }) }))),
          cfgRow('我是谁字数范围', h('span', null,
            h('input', { style: S.input, type: 'number', value: cfg.whoamiMinChars ?? 50, onChange: e => setCfg({ ...cfg, whoamiMinChars: Number(e.target.value) }) }),
            ' – ',
            h('input', { style: S.input, type: 'number', value: cfg.whoamiMaxChars ?? 500, onChange: e => setCfg({ ...cfg, whoamiMaxChars: Number(e.target.value) }) }))),
          cfgRow('项目内容入库门槛', h('input', { style: S.input, type: 'number', step: 0.05, min: 0, max: 1, value: cfg.importanceThresholdProject, onChange: e => setCfg({ ...cfg, importanceThresholdProject: Number(e.target.value) }) })),
          cfgRow('闲聊内容入库门槛', h('input', { style: S.input, type: 'number', step: 0.05, min: 0, max: 1, value: cfg.importanceThresholdChat, onChange: e => setCfg({ ...cfg, importanceThresholdChat: Number(e.target.value) }) })),
          cfgRow('文档库容量上限（MB，超了先归档快照）', h('input', { style: { ...S.input, width: 90 }, type: 'number', min: 2, max: 40, value: cfg.capacityLimitMb ?? 8, onChange: e => setCfg({ ...cfg, capacityLimitMb: Number(e.target.value) || 8 }) })),
          cfgRow('日记的重要候选上限（快照没有上限）', h('input', { style: S.input, type: 'number', min: 2, max: 30, value: cfg.diaryCandidateLimit, onChange: e => setCfg({ ...cfg, diaryCandidateLimit: Number(e.target.value) }) })),
          ),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 2px', margin: '4px 0 8px' } },
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, '日记自动化设置'),
          cfgRow('日记草稿自动上传记忆', h('input', { type: 'checkbox', checked: !!cfg.autoAdopt, onChange: e => setCfg({ ...cfg, autoAdopt: e.target.checked }) })),
          cfgRow('日记自动归纳到日记集合中', h('input', { type: 'checkbox', checked: cfg.diaryBookEnabled !== false, onChange: e => setCfg({ ...cfg, diaryBookEnabled: e.target.checked }) })),
          cfgRow('日记合集目录', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '默认 ~/.dsh/mnemon-diary/diary-book', value: cfg.diaryBookDir || '', onChange: e => setCfg({ ...cfg, diaryBookDir: e.target.value }) })),
          cfgRow('日记合并天数（超过就并成月合辑）', h('input', { style: { ...S.input, width: 90 }, type: 'number', min: 7, max: 365, value: cfg.diaryMergeDays ?? 30, onChange: e => setCfg({ ...cfg, diaryMergeDays: Number(e.target.value) || 30 }) })),
          cfgRow('日记合辑保留月数（更早的归档）', h('input', { style: { ...S.input, width: 90 }, type: 'number', min: 1, max: 60, value: cfg.diaryArchiveMonths ?? 12, onChange: e => setCfg({ ...cfg, diaryArchiveMonths: Number(e.target.value) || 12 }) })),
          ),
          h('div', { style: S.row }, h('button', { style: S.btn, disabled: !!busy, onClick: () => save() }, busy === 'save' ? '保存中…' : '保存配置')),
          msg ? h('div', { style: S.ok }, msg) : null,
          err ? h('div', { style: S.err }, err) : null)),

        h('div', { style: { ...S.card, flex: '1 1 320px', minWidth: 300, marginBottom: 16 } },
          h('details', { open: true }, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '我是谁（点此展开）'),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 2px', margin: '4px 0 8px' } },
          cfgRow('使用者称呼（和谁相处）', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '留空＝通用「对方」，例如填 popo', value: cfg.ownerName || '', onChange: e => setCfg({ ...cfg, ownerName: e.target.value }) })),
          h('div', { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 6, lineHeight: 1.6 } }, '「我是谁」与人格重写里提到的这个人就叫这个名字；留空时一律写「对方」，别人用这个插件不会带上你的名字。'),
          ),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 2px', margin: '4px 0 8px' } },
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, '我是谁自动化设置'),
          cfgRow('我是谁记忆合集目录', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '默认 ~/.dsh/mnemon-diary/who-am-i', value: cfg.whoAmIDir || '', onChange: e => setCfg({ ...cfg, whoAmIDir: e.target.value }) })),
          cfgRow('我是谁自动上传记忆', h('input', { type: 'checkbox', checked: cfg.autoWhoamiUpload === true, onChange: e => setCfg({ ...cfg, autoWhoamiUpload: e.target.checked }) })),
          cfgRow('我是谁自动归纳到合集', h('input', { type: 'checkbox', checked: cfg.autoWhoamiCollection !== false, onChange: e => setCfg({ ...cfg, autoWhoamiCollection: e.target.checked }) })),
          cfgRow('我是谁保留份数（2–5）', h('input', { style: { ...S.input, width: 90 }, type: 'number', min: 2, max: 5, value: cfg.whoamiKeep ?? 3, onChange: e => setCfg({ ...cfg, whoamiKeep: Math.min(5, Math.max(2, Number(e.target.value) || 3)) }) })),
          h('div', { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 6, lineHeight: 1.6 } }, '上传到记忆的「我是谁」只保留最近 N 篇，更早的会被剔掉；本机 items 目录仍留有原始记录。'),
          ),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 2px', margin: '4px 0 8px' } },
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, '人格自动写入（下面两项只能二选一）'),
            cfgRow('我是谁自动上传人格', h('input', { type: 'checkbox', checked: cfg.autoWhoamiPersona === true, disabled: cfg.autoWhoamiRewritePersona === true, onChange: e => setCfg({ ...cfg, autoWhoamiPersona: e.target.checked, ...(e.target.checked ? { autoWhoamiRewritePersona: false } : {}) }) })),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 6, lineHeight: 1.6 } }, '上传人格：只把「我是谁（自动归纳）」那一段写进人格文件，其它内容原样不动。'),
            cfgRow('我是谁自动重写人格', h('input', { type: 'checkbox', checked: cfg.autoWhoamiRewritePersona === true, disabled: cfg.autoWhoamiPersona === true, onChange: e => setCfg({ ...cfg, autoWhoamiRewritePersona: e.target.checked, ...(e.target.checked ? { autoWhoamiPersona: false } : {}) }) })),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 6, lineHeight: 1.6 } }, '重写人格：把旧人格＋「我是谁」一起重新总结，整份人格文件全部覆盖、不保留旧内容（写前自动备份）。'),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: -2, marginBottom: 8, lineHeight: 1.6 } }, '这两项只能开一个：勾上一个，另一个会自动关掉并变灰。'),
          ),
          cfgRow('重写人格时保留边界', h('input', { type: 'checkbox', checked: cfg.rewriteKeepBoundary === true, onChange: e => setCfg({ ...cfg, rewriteKeepBoundary: e.target.checked }) })),
          h('div', { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 6, lineHeight: 1.6 } }, '打开后重写人格时不动「# 边界」这一节：原样沿用旧文件里的安全边界，只重写身份、语气、行事偏好等其它内容。'),
          cfgRow('全局人格文件', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '默认 ~/.dsh/AGENT.md', value: cfg.personaFile || '', onChange: e => setCfg({ ...cfg, personaFile: e.target.value }) })),
          h('div', { style: S.row }, h('button', { style: S.btn, disabled: !!busy, onClick: () => save() }, busy === 'save' ? '保存中…' : '保存配置')))),

        h('div', { style: { ...S.card, flex: '1 1 420px', minWidth: 340, marginBottom: 16 } },
          h('details', { open: true }, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '快照与归档（点此展开）'),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px', margin: '4px 0 10px' } },
          h('div', { style: { ...S.muted, fontSize: 12, lineHeight: 1.8 } },
            h('div', null, '【快照】作用：精简的记忆（摘要 + 重要条目 = 临时精简上传记忆）'),
            h('div', { style: { marginTop: 4 } }, '【归档】作用：全部对话记录（用来恢复记忆 ~ 占内存 ~ 不建议上传记忆）'),
            h('div', { style: { marginTop: 4 } }, '触发方式：上下文快要满了的时候，手动保存最稳妥。'))),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 2px', margin: '4px 0 8px' } },
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, '生成的触发条件'),
          cfgRow('自动化的上下文阈值 %', h('input', { style: S.input, type: 'number', value: cfg.contextThreshold, onChange: e => setCfg({ ...cfg, contextThreshold: Number(e.target.value) }) })),
          cfgRow('自动化上下文检查间隔（分钟）', h('input', { style: S.input, type: 'number', min: 1, max: 1440, value: cfg.contextCheckMinutes, onChange: e => setCfg({ ...cfg, contextCheckMinutes: Number(e.target.value) }) })),
          ),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 2px', margin: '4px 0 8px' } },
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, '快照基础设置'),
          cfgRow('自动快照类型', h('select', { style: S.input, value: cfg.autoDigestMode || '项目', onChange: e => setCfg({ ...cfg, autoDigestMode: e.target.value }) },
            ['项目', '闲聊', '全部'].map(m => h('option', { key: m, value: m }, m)))),
          cfgRow('自动快照（阈值触发）', h('input', { type: 'checkbox', checked: cfg.autoSnapshot !== false, onChange: e => setCfg({ ...cfg, autoSnapshot: e.target.checked }) })),
          cfgRow('快照后自动上传记忆', h('input', { type: 'checkbox', checked: cfg.autoRefine === true, onChange: e => setCfg({ ...cfg, autoRefine: e.target.checked }) })),
          cfgRow('快照保留份数（更早的归档）', h('input', { style: { ...S.input, width: 90 }, type: 'number', min: 5, max: 200, value: cfg.snapshotKeep ?? 20, onChange: e => setCfg({ ...cfg, snapshotKeep: Number(e.target.value) || 20 }) })),
          cfgRow('快照合集目录', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '默认 ~/.dsh/mnemon-diary/snapshot-books', value: cfg.snapshotBookDir || '', onChange: e => setCfg({ ...cfg, snapshotBookDir: e.target.value }) })),
          ),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 2px', margin: '4px 0 8px' } },
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, '归档基础设置'),
          cfgRow('自动归档完整会话', h('input', { type: 'checkbox', checked: cfg.archiveEnabled !== false, onChange: e => setCfg({ ...cfg, archiveEnabled: e.target.checked }) })),
          cfgRow('归档合集目录', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '默认 ~/.dsh/mnemon-diary/archives', value: cfg.archiveDir || '', onChange: e => setCfg({ ...cfg, archiveDir: e.target.value }) })),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: -2, marginBottom: 8, lineHeight: 1.7 } }, '自动化归档是在自动化快照之后才生成的；平时手动点「生成快照」不会产生归档。'),
          ),
          h('div', { style: S.row }, h('button', { style: S.btn, disabled: !!busy, onClick: () => save() }, busy === 'save' ? '保存中…' : '保存快照设置')),
          msg ? h('div', { style: S.ok }, msg) : null,
          err ? h('div', { style: S.err }, err) : null))
        ),
        h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '会话素材（勾选 = 纳入日记）（点此展开）'),
          h('div', { style: { ...S.row, marginTop: 6 } }, h('button', { style: S.btn, onClick: () => save({ hideArchived: !cfg.hideArchived }) }, cfg.hideArchived ? '显示全部会话' : '隐藏已归档')),
          h('table', { style: S.table },
            h('thead', null, h('tr', null, ['纳入', '会话', '工作区', '消息', '字符', '最后活动', '快照'].map((t, i) => h('th', { key: i, style: S.th }, t)))),
            h('tbody', null, ov.sessions.map(s => h('tr', { key: s.id },
              h('td', { style: S.td }, h('input', { type: 'checkbox', checked: included.has(s.id), onChange: e => toggleSession(s.id, e.target.checked) })),
              h('td', { style: S.td, title: s.id }, s.title + (s.archived ? '（已归档）' : '')),
              h('td', { style: S.td, title: s.workspace }, s.workspace.replace(/^--|--$/g, '').slice(0, 28)),
              h('td', { style: S.td }, s.messages),
              h('td', { style: S.td }, s.chars),
              h('td', { style: S.td }, fmtTime(s.lastAt)),
              h('td', { style: S.td }, h('select', { style: { ...S.input, width: 76, height: 28 }, value: (cfg.sessionModes && cfg.sessionModes[s.id]) || cfg.autoDigestMode || '项目', onChange: e => setSessionMode(s.id, e.target.value) },
                ['项目', '闲聊', '全部'].map(m => h('option', { key: m, value: m }, m))),
                h('button', { style: S.btn, disabled: !!digestBusy || !!busy, onClick: () => makeDigest(s.id, (cfg.sessionModes && cfg.sessionModes[s.id]) || cfg.autoDigestMode || '项目') }, digestBusy === s.id ? '生成中…' : '快照'), h('button', { style: S.btn, disabled: !!busy, onClick: () => archiveNow(s.id) }, busy === 'archive' ? '归档中…' : '归档')))))))),

        h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `已生成归档（${(ov.archives || []).length} 份，点此展开）`),
          h('div', { style: { ...S.muted, marginTop: 6, marginBottom: 8, lineHeight: 1.7 } }, `归档用于储存完整的会话记录，方便随时恢复记忆。由于数据量太大，它不会自动写入记忆库，只作为恢复记忆的最后保障。`),
          h('div', { style: { ...S.row, marginTop: 6 } },
            h('button', { style: S.btn, onClick: () => openArchiveDir() }, '打开归档目录'),
            h('span', { style: { ...S.muted, marginLeft: 8 } }, ov.archiveDirResolved || '')),
          (ov.archives || []).length === 0 ? h('div', { style: S.muted }, '还没有归档。') : null,
          h('table', { style: S.table },
            h('thead', null, h('tr', null, ['文件名', '大小', '归档时间', ''].map((t, i) => h('th', { key: i, style: S.th }, t)))),
            h('tbody', null, (ov.archives || []).map(a => h('tr', { key: a.name },
              h('td', { style: S.td, title: a.name }, a.name),
              h('td', { style: S.td }, (a.size / 1024).toFixed(0) + ' KB'),
              h('td', { style: S.td }, fmtTime(a.mtime)),
              h('td', { style: S.td }, h('button', { style: S.btn, disabled: !!busy, onClick: () => deleteArchive(a.name) }, '删除')))))))),

        h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `日记草稿（${ov.drafts.length} 份，点此展开）`),
          h('div', { style: { ...S.muted, marginTop: 6, marginBottom: 8, lineHeight: 1.7 } }, `日记会生成每日的信息，采纳后自动储存到记忆库；同一天可以多次生成，日记重要条目还要通过入库阈值，达到阈值才会储存到记忆中。`),
          h('div', { style: { ...S.row, marginTop: 6 } }, h('button', { style: S.btn, onClick: () => openDiaryBookDir() }, '打开日记合集目录'), h('span', { style: { ...S.muted, marginLeft: 8 } }, ov.diaryBookResolved || '')),
          ov.drafts.length === 0 ? h('div', { style: S.muted }, '还没有草稿，点「立即生成」。') : null,
          ov.drafts.map((d, idx) => {
            const open = openDrafts.find(x => x.date === d.date)
            return h('div', { key: d.date },
              h('div', { style: { ...S.row, borderBottom: '1px solid rgba(127,127,127,.12)', paddingBottom: 6 } },
                h('button', { style: { ...S.btn, width: 26, padding: 0, textAlign: 'center' }, onClick: () => toggleDraft(d.date) }, open ? '▾' : '▸'),
                h('b', null, `${idx + 1}. ${d.date}`),
                h('span', { style: S.muted }, `${d.chars} 字 · ${d.memories} 条候选${d.adopted ? ' · 已采纳' : ''}`),
                h('button', { style: S.btnPrimary, disabled: !!busy || !!adoptBusy, onClick: () => adopt(d.date) }, adoptBusy === d.date ? '上传中…' : '上传记忆'),
                h('button', { style: S.btn, onClick: () => discard(d.date) }, '删除')),
              open ? draftDetail(open) : null)
          }))),

        h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `已生成的快照（${(ov.digests || []).length} 份，点此展开）`),
          h('div', { style: S.row }, h('button', { style: S.btn, onClick: async () => { try { const r = await call('books.openDir'); setMsg('已打开快照合集目录：' + r.path) } catch (e) { setErr('打开失败：' + String(e && e.message || e)) } } }, '打开快照合集目录')),
          h('div', { style: { ...S.muted, marginTop: 6, marginBottom: 8, lineHeight: 1.7 } }, `快照会从整段会话中精炼出重要内容，是整个会话的精炼版本。支持【项目】【闲聊】【全部】三种精炼方式，方便提取真正想要的内容；精炼出的条目还要通过入库阈值，达到阈值才会储存到记忆中。`),
          ov.state.lastArchive ? h('div', { style: { ...S.muted, marginTop: 6 } }, `最近归档：${ov.state.lastArchive.path}（${ov.state.lastArchive.messages} 条）`) : null,
          (ov.digests || []).length === 0 ? h('div', { style: S.muted }, '还没有快照。阈值触发或点会话行的「快照」手动生成。') : null,
          (ov.digests || []).map((d, idx) => {
            const key = d.date + '::' + d.sessionId
            const open = openDigests.find(x => x.date + '::' + x.sessionId === key)
            return h('div', { key },
              h('div', { style: { ...S.row, borderBottom: '1px solid rgba(127,127,127,.12)', paddingBottom: 6 } },
                h('button', { style: { ...S.btn, width: 26, padding: 0, textAlign: 'center' }, onClick: () => toggleDigest(d) }, open ? '▾' : '▸'),
                h('b', null, `${idx + 1}. ${d.date}`),
                h('span', { style: S.muted }, `[${d.mode || '项目'}] ${d.title} · ${d.pct}% · ${d.items} 条`),
                h('button', { style: S.btnPrimary, disabled: !!busy, onClick: () => refineDigest(d) }, busy === 'refine' ? '上传中…' : '上传记忆'),
                h('button', { style: S.btn, onClick: () => deleteDigest(d) }, '删除')),
              open ? digestDetail(open) : null)
          }),))

        ,h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `记录我是谁（${(ov.whoami || []).length} 份，点此展开）`),
          h('div', { style: S.row }, h('button', { style: S.btn, onClick: async () => { try { const r = await call('whoami.openDir'); setMsg('已打开我是谁记忆合集目录：' + r.dir) } catch (e) { setErr('打开失败：' + String(e && e.message || e)) } } }, '打开我是谁记忆合集目录')),
          h('div', { style: { ...S.muted, marginTop: 6, marginBottom: 8, lineHeight: 1.7 } }, `每次生成日记时会顺手写一份「我是谁」：只依据当天素材，总结我的身份、说话做事的样子、和你的立场与最近的变化。上传后并入唯一的「我是谁」记忆合集，文档会逐渐更新。`),
          ov.whoamiCollection ? h('div', { style: { ...S.muted, marginBottom: 6, wordBreak: 'break-all' } }, `合集位置：${ov.whoamiCollection}`) : null,
          h('div', { style: { ...S.muted, marginTop: 2, marginBottom: 8, lineHeight: 1.7 } }, '上传人格：只替换「我是谁（自动归纳）」那一段，人格文件其余内容原样不动。重写人格：把旧人格和「我是谁」一起重新总结，整份人格全部覆盖，不保留旧内容（写前自动备份）。'),
          whoamiProgress ? h('div', { style: { marginBottom: 8 } },
            h('div', { style: { ...S.muted, marginBottom: 4 } }, `${whoamiProgress.kind === 'rewrite' ? '正在重写人格' : whoamiProgress.kind === 'persona' ? '正在归纳人格' : '正在上传记忆'}：${whoamiProgress.date}（已等待 ${Math.floor((Date.now() - whoamiProgress.started) / 1000)}s）`),
            h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden' } },
              h('div', { style: { height: '100%', width: `${Math.min(95, 8 + Math.floor((Date.now() - whoamiProgress.started) / 1000) * 4)}%`, background: '#4f8cff', transition: 'width .5s linear' } }))) : null,
          (ov.whoami || []).length === 0 ? h('div', { style: S.muted }, '还没有记录，生成一次日记就会有了。') : null,
          (ov.whoami || []).map((w, idx) => {
            const open = openWhoami.find(x => x.date === w.date)
            return h('div', { key: w.date },
              h('div', { style: { ...S.row, borderBottom: '1px solid rgba(127,127,127,.12)', paddingBottom: 6 } },
                h('button', { style: { ...S.btn, width: 26, padding: 0, textAlign: 'center' }, onClick: () => toggleWhoami(w.date) }, open ? '▾' : '▸'),
                h('b', null, `${idx + 1}. ${w.date}`),
                h('span', { style: S.muted }, `${w.chars} 字${w.uploaded ? ' · 已上传' : ''}`),
                h('button', { style: S.btnPrimary, disabled: !!whoamiBusy, onClick: () => uploadWhoami(w.date) }, whoamiBusy === w.date ? '上传中…' : '上传记忆'),
                h('button', { style: S.btn, disabled: !!whoamiBusy, onClick: () => uploadPersona(w.date) }, whoamiBusy === w.date + '::persona' ? '归纳中…' : '上传人格'),
                h('button', { style: S.btn, disabled: !!whoamiBusy, onClick: () => rewritePersona(w.date) }, whoamiBusy === w.date + '::rewrite' ? '重写中…' : '重写人格'),
                h('button', { style: S.btn, onClick: () => deleteWhoami(w.date) }, '删除')),
              open ? h('div', { style: { marginTop: 8, marginLeft: 18, paddingLeft: 12, borderLeft: '2px solid rgba(127,127,127,.25)' } },
                h('div', { style: S.title }, `${w.date} · 我是谁`),
                h('div', { style: S.pre }, open.text || '（空）')) : null)
          }))),

        h('div', { style: { ...S.card, flex: '1 1 320px', minWidth: 300, marginBottom: 16 } },
          h('details', { open: false }, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '记忆体检（点此展开）'),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 8px', margin: '4px 0 8px', fontSize: 13, lineHeight: 1.75 } },
            h('div', null, '每月 1 日 04:00 自动跑一次（deepseek-flash）。作用：像人一样会忘——只留还重要的，删之前先归档。'),
            h('div', { style: { ...S.muted, fontSize: 12, margin: '8px 0 2px' } }, '会处理这些文件：'),
            h('div', null, '· MEMORY.md（长期工作记忆）：合并重复、降级、过期清理；预算 ≤ 6 KB、15–40 条'),
            h('div', null, '· USER.md（关于你的画像）：同上；预算 ≤ 3 KB、8–20 条'),
            h('div', null, '· 文档库「日记 …」：插件已自动（单日 >30 天并成月合辑、合辑 >12 个月归档），体检只做确认'),
            h('div', null, '· 文档库「快照 · …」：插件已自动只留最近 20 份，体检只确认数量没爆'),
            h('div', null, '· 文档库「记忆归档 YYYY-MM」：被删条目的原文写进这里（先归档，归档失败就不删）'),
            h('div', null, '· 文档库「我是谁」：不动'),
            h('div', { style: { ...S.muted, fontSize: 12, margin: '8px 0 2px' } }, '不动的：'),
            h('div', null, '· drafts / digests / snapshot-books / archives / backups 这些磁盘文件，以及日记正文')
          ),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 8px', margin: '4px 0 8px', fontSize: 13, lineHeight: 1.7 } },
            h('div', null, '定时任务：记忆月度体检（mnemon）'),
            h('div', null, '下次自动运行：' + fmtTime(reviewInfo && reviewInfo.nextRunAt)),
            h('div', null, '上次运行：' + (reviewInfo && reviewInfo.lastRunAt ? fmtTime(reviewInfo.lastRunAt) + ' · ' + (reviewInfo.lastRunStatus || '—') : '还没跑过')),
            reviewErr ? h('div', { style: { ...S.err, fontSize: 12 } }, reviewErr) : null,
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
              h('button', { style: S.btnPrimary, disabled: reviewBusy, onClick: runReview }, reviewBusy ? '提交中…' : '立即体检'),
              h('button', { style: S.btn, onClick: loadReview }, '刷新状态'))
          ),
          h('div', { style: { border: '1px solid rgba(255,255,200,0.22)', borderRadius: 8, padding: '10px 12px 8px', margin: '4px 0 10px', fontSize: 12, lineHeight: 1.75, opacity: .9 } },
            h('div', { style: { marginBottom: 4 } }, '手动体检（自动流程不可用时用这个）'),
            h('div', null, '什么时候手动：按钮点了没反应、自动运行失败/中断、宿主刚重启或换过模型插件、想马上整理而不想等每月 1 日。'),
            h('div', null, '怎么做：在任意会话里对新开的一行说「加载 skill mnemon-memory-review，做一次记忆体检」；也可以去「设置 → 定时任务」里手动运行「记忆月度体检（mnemon）」。'),
            h('div', null, '手动跑也一样：先归档再删除，报告会给条数/字节数的前后对比。')
          )))

        ,
        h('div', { style: { border: '1px solid rgba(255,255,255,0.18)', borderRadius: 10, padding: '8px 12px 10px', marginTop: 10 } },
          h('details', { open: false, style: { marginTop: 0 }, onToggle: e => { if (e.target.open && planText == null) loadPlan() } },
            h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '记忆存储方案 & 记忆体检 skill（点此展开）'),
          h('div', { style: { border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '10px 12px 8px', margin: '4px 0 8px', fontSize: 13, lineHeight: 1.7 } },
            h('div', null, '给人和 AI 的方案指南：日记 / 快照 / 我是谁 / runtime 记忆分别怎么存、什么时候合并归档、出问题查哪里。聊天记录丢了也能照着排错。'),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, '文件：' + ((planInfo && planInfo.path) || '~/.dsh/mnemon-diary/记忆存储方案.md')),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: 2 } }, 'skill：' + ((planInfo && planInfo.skill && planInfo.skill.path) || '~/.dsh/skills/mnemon-memory-review/SKILL.md') + (planInfo && planInfo.skill ? (planInfo.skill.exists ? (planInfo.skill.synced ? ' · 与方案一致 ✅' : ' · 与方案不一致 ⚠️ 可重新安装') : ' · 尚未安装') : '')),
            h('textarea', {
              readOnly: true,
              style: { width: '100%', minHeight: 380, marginTop: 8, boxSizing: 'border-box', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.6, background: 'rgba(0,0,0,.18)', color: 'inherit', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: 10, cursor: 'text' },
              value: planText == null ? '（展开后加载…）' : planText
            }),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, '字数：' + (planText == null ? '—' : planText.length) + ' · 只读预览：要改方案就在会话里跟我说，我来改（手改容易把标记段写坏）'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('button', { style: S.btn, disabled: !!planBusy || planText == null, onClick: resetPlan }, planBusy === 'reset' ? '恢复中…' : '恢复默认模板'),
              h('button', { style: S.btn, disabled: !!planBusy || planText == null, onClick: installSkill }, planBusy === 'skill' ? '安装中…' : '安装为 skill'),
              h('button', { style: S.btn, onClick: async () => { try { await call('plan.openDir') } catch (e) { setPlanErr('打开目录失败：' + String(e && e.message || e)) } } }, '打开目录')
            ),
            planMsg ? h('div', { style: { ...S.ok, fontSize: 12, marginTop: 6 } }, planMsg) : null,
            planErr ? h('div', { style: { ...S.err, fontSize: 12, marginTop: 6 } }, planErr) : null
          )))
        ,confirmBox ? h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 } },
          h('div', { style: { minWidth: 320, maxWidth: 520, background: '#252526', color: '#eee', border: '1px solid rgba(127,127,127,.35)', borderRadius: 12, padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,.45)' } },
            h('div', { style: { fontWeight: 600, fontSize: 16, marginBottom: 10 } }, '请确认'),
            h('div', { style: { fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, confirmBox.text),
            h('div', { style: { marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' } },
              h('button', { style: S.btn, onClick: () => setConfirmBox(null) }, '取消'),
              h('button', { style: S.btnPrimary, onClick: () => { const f = confirmBox.onOk; setConfirmBox(null); if (f) f() } }, '确认')))) : null
        ,dialog ? h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 } },
          h('div', { style: { minWidth: 340, maxWidth: 560, background: '#252526', color: '#eee', border: '1px solid rgba(127,127,127,.35)', borderRadius: 12, padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,.45)' } },
            h('div', { style: { fontWeight: 600, fontSize: 16, marginBottom: 10 } }, dialog.title),
            dialog.lines.map((x, i) => h('div', { key: i, style: { fontSize: 13, lineHeight: 1.7, wordBreak: 'break-all' } }, x)),
            h('div', { style: { marginTop: 10, fontSize: 13, opacity: .85 } }, dialog.hint),
            h('div', { style: { marginTop: 14, textAlign: 'right' } }, h('button', { style: S.btnPrimary, onClick: () => setDialog(null) }, '知道了')))) : null
      )
    }

    const inject = ['slots', 'connection']

    function apply(ctx) {
      const conn = ctx.get('connection')
      if (!conn || !conn.rpc) return
      const call = async (endpoint, payload) => {
        const r = await conn.rpc.call('/mnemon-diary', endpoint, payload)
        if (r && r.ok === false) throw new Error(r.error?.message || 'rpc error')
        return r && typeof r === 'object' && 'value' in r ? r.value : r
      }
      const callAny = async (channel, endpoint, payload) => {
        const r = await conn.rpc.call(channel, endpoint, payload)
        if (r && r.ok === false) throw new Error(r.error?.message || 'rpc error')
        return r && typeof r === 'object' && 'value' in r ? r.value : r
      }
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'mnemon-diary',
        order: 30,
        label: () => '日记',
        inject: () => ({ call, callAny }),
      }, Section))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
