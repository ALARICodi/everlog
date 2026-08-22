import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect, parse, MAX_BYTES } from './lib/canonical.js'
import crypto from 'node:crypto'
import { fetchAnchors, assertFresh, verifyAnchors, MAX_ANCHOR_AGE_MS } from './lib/anchors.js'
import { build, isComplete } from './lib/bundle.js'
import { scheduleUpgrade } from './jobs/upgrade.js'
import { sync as gitSync } from './lib/gitsync.js'
import * as store from './lib/store.js'
import * as ar from './lib/arweave.js'
import * as ots from './lib/ots.js'
import * as users from './lib/users.js'
import * as session from './lib/session.js'
// 上链前审核暂时关闭(lib/moderate.js 保留,以后要开时把 pipeline 里那段接回来)。
// 注意:关掉之后任何投稿都会直接永久上链,且由本站钱包签名。

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8000
// 管理员密钥从 secrets 读,不设默认口令 —— 这个站会被挂到公网,
// 而管理员接口能放行「永久上链」,默认口令等于把钱包交出去。
const ADMIN_KEY =
  process.env.EVERLOG_ADMIN_KEY ||
  (await import('node:fs')).default
    .readFileSync('C:/Users/陈志平/.claude/secrets/everlog_admin_key.txt', 'utf8')
    .trim()

const app = express()
// 贴着实际上限给,超了在入口就以清楚的理由拒绝,而不是收下十倍垃圾再走到深处报错
app.use(express.json({ limit: '256kb' }))
app.use(session.attachUser)   // 每个请求都填好 req.userId(没登录就是 null)
app.use(express.static(path.join(HERE, 'public')))

await store.init()
await users.init()

/* ------------------------------------------------------------ 账号
   与版本1 的唯一区别就是这一块。发布链路、证明、验证器全都没动。

   默认**不强制登录**,和版本1 保持一致 —— 登录只是为了「以后能找回自己的文章」,
   不是发布的门槛。要改成必须登录,把 EVERLOG_REQUIRE_LOGIN 设成 1。 */
const REQUIRE_LOGIN = process.env.EVERLOG_REQUIRE_LOGIN === '1'

app.post('/api/register', async (req, res) => {
  try {
    const u = await users.register(req.body?.password, req.body?.displayName)
    session.setCookie(res, session.issue(u.id))
    res.json(u)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/login', async (req, res) => {
  try {
    const u = await users.login(
      String(req.body?.id || '').trim().toUpperCase(),
      req.body?.password,
      req.body?.realName,
    )
    session.setCookie(res, session.issue(u.id))
    res.json(u)
  } catch (e) {
    res.status(401).json({ error: e.message })
  }
})

app.post('/api/logout', (req, res) => {
  session.clearCookie(res)
  res.json({ ok: true })
})

app.get('/api/me', async (req, res) => {
  if (!req.userId) return res.json({ user: null, requireLogin: REQUIRE_LOGIN })
  res.json({ user: await users.progress(req.userId), requireLogin: REQUIRE_LOGIN })
})

/* --- 认证向导的后两步 --- */

// 第二步:人脸。**这里刻意不写实现** —— 人脸识别是个大模块(活体检测、
// 特征提取、模板存储、防照片攻击),以后单独做。现在只占位,让流程完整可走通。
app.post('/api/enroll/face', session.requireLogin, async (_req, res) => {
  res.json({ ok: true, enrolled: false, note: '人脸识别模块尚未接入,本步暂时跳过' })
})

// 第三步:实名绑定。两个输入框必须一致,绑定后不可更改。
app.post('/api/enroll/name', session.requireLogin, async (req, res) => {
  try {
    res.json(await users.bindRealName(req.userId, req.body?.name1, req.body?.name2))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/me/name', session.requireLogin, async (req, res) => {
  try {
    res.json(await users.setDisplayName(req.userId, req.body?.displayName))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/me/password', session.requireLogin, async (req, res) => {
  try {
    await users.changePassword(req.userId, req.body?.oldPassword, req.body?.newPassword)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** 我的文章 —— 账号系统存在的主要理由:换台设备也能找回来 */
app.get('/api/mine', session.requireLogin, async (req, res) => {
  const all = await store.list()
  res.json(all.filter(m => m.owner === req.userId))
})

/* ---------------------------------------------------------------- 限流
   每次发布都是一次不可撤销的永久上链,还带着本站钱包的签名。刷不得。

   按 IP 限流只能算尽力而为:任何 HTTP 头都是客户端可控的,
   `x-forwarded-for` 随手就能伪造,换一个值就是一份新配额。
   所以真正兜底的是**全局闸** —— 不管来自谁、不管头怎么编,
   整站每小时的发布总量有硬上限。这一层伪造不了。 */
const PER_IP_DAILY = Number(process.env.EVERLOG_DAILY_LIMIT || 5)
const GLOBAL_HOURLY = Number(process.env.EVERLOG_HOURLY_LIMIT || 30)

const hits = new Map()      // ip:day -> 次数
let windowStart = Date.now()
let windowCount = 0

function rateLimit(req, res, next) {
  // 全局闸:唯一一层伪造不了的
  const now = Date.now()
  if (now - windowStart > 3600_000) { windowStart = now; windowCount = 0 }
  if (windowCount >= GLOBAL_HOURLY) {
    return res.status(429).json({ error: '本站本小时的发布额度已用完,请稍后再试' })
  }

  // 尽力而为的按 IP 闸。cloudflare 隧道会带 cf-connecting-ip,比 x-forwarded-for 稍可信
  const ip =
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip
  const day = new Date().toISOString().slice(0, 10)
  const key = `${ip}:${day}`

  // 顺手清掉隔天的,别让这个 Map 无限长 —— 之前它永不回收
  if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith(day)) hits.delete(k)

  const n = (hits.get(key) || 0) + 1
  hits.set(key, n)
  if (n > PER_IP_DAILY) {
    return res.status(429).json({ error: '今天的投稿次数已用完,明天再来' })
  }

  windowCount++
  next()
}

/* ------------------------------------------------------- 预览(无副作用)
   页面上的二次确认用这个:把「如果现在发布,到底会发布哪串字节」
   原样摊给用户看。上链不可逆,这一步不能省。 */
/* ------------------------------------------------------------------ 信封
   date 和 anchors 必须在预览时就定死,发布时原样使用 —— 否则字节变、哈希变,
   确认屏给用户看的 sha256 就不是最终上链的那个。

   但**绝不能把信封交给浏览器再要回来**:浏览器在用户手里,回传的内容可以随便改。
   谁都能直接 POST 一个编造的 { height: 700000, hash: 'dede…' },
   服务端照单全收写进文章,页面就会显示一个假的「不早于 2021」——
   数学没被攻破(查一下就露馅),但我们的网站在替谎言背书,这更糟。

   所以信封锁在服务端,只把一个随机 token 交出去。浏览器全程碰不到内容。 */
const envelopes = new Map() // token -> { envelope, at }

function pruneEnvelopes() {
  const cutoff = Date.now() - MAX_ANCHOR_AGE_MS
  for (const [k, v] of envelopes) if (v.at < cutoff) envelopes.delete(k)
}

app.post('/api/inspect', async (req, res) => {
  try {
    const { title, author, body } = req.body
    const envelope = { date: new Date().toISOString(), anchors: await fetchAnchors() }
    const r = inspect({ title, author, body, ...envelope })

    pruneEnvelopes()
    const token = crypto.randomBytes(18).toString('base64url')
    envelopes.set(token, { envelope, at: Date.now() })

    res.json({
      format: r.format,
      byteLength: r.byteLength,
      sha256: r.sha256,
      overLimit: r.overLimit,
      maxBytes: r.maxBytes,
      text: r.text,
      token, // 只给号,不给内容
      bounds: bounds(envelope.anchors),
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** 把锚点翻译成人话的「不早于」区间 */
function bounds(anchors) {
  return {
    notBefore: {
      bitcoin: { height: anchors.btc.height, time: anchors.btc.time },
      arweave: { height: anchors.ar.height, time: anchors.ar.time },
    },
  }
}

/* ------------------------------------------------------------- 发布流水线 */
const jobs = new Map() // id -> {step, log[], error, meta}

function log(id, msg) {
  const j = jobs.get(id)
  if (j) j.log.push(msg)
}

async function pipeline(id, input) {
  const j = jobs.get(id)
  const set = s => { j.step = s }

  // 1. 定稿字节。用预览时那个信封里的 date + anchors,一字不改 ——
  //    这样确认屏上显示的 sha256 就是真正上链的那个。
  set('canonical')
  assertFresh(input.anchors)
  // 上链前独立复核一次锚点真伪 —— 写进字节就永久,错了没法撤
  await verifyAnchors(input.anchors)
  log(id, `锚点已复核:比特币 #${input.anchors.btc.height} / Arweave #${input.anchors.ar.height}`)
  const r = inspect(input)
  if (r.overLimit) throw new Error(`超过 ${MAX_BYTES} 字节上限`)
  log(id, `规范字节 ${r.byteLength} B,sha256 ${r.sha256.slice(0, 16)}…`)

  const p = parse(r.bytes)
  const meta = {
    id,
    format: p.format,
    title: p.title,
    author: p.author,
    date: p.date,
    sha256: r.sha256,
    byteLength: r.byteLength,
    owner: input.owner || null,   // 只存在 meta.json 里,不进 article.txt
    // 时间下界:这两个区块在文档诞生前不可预测,所以文档必然写于它们之后。
    notBefore: {
      bitcoin: {
        height: input.anchors.btc.height,
        hash: input.anchors.btc.hash,
        time: input.anchors.btc.time,       // 区块标称时间:矿工自填,可超前最多 2 小时
        mtpTime: input.anchors.btc.mtpTime || null, // MTP:共识层保证在过去,这才是严格下界
      },
      arweave: { height: input.anchors.ar.height, hash: input.anchors.ar.hash, time: input.anchors.ar.time },
    },
    status: 'publishing',
  }
  await store.create(id, r.bytes, meta)

  return publish(id, meta)
}

/**
 * 真正动链的部分。
 *
 * **必须幂等** —— 崩溃恢复会重跑它。每一步都要先看「是不是已经做过了」,
 * 否则救援会把 Arweave 再传一遍:同一篇文章两份永久记录,两份都用本站钱包签名,
 * 删不掉。那正是这套恢复逻辑本来要避免的事故。
 */
async function publish(id, meta) {
  const j = jobs.get(id)
  const set = s => { if (j) j.step = s }
  const bytes = await store.readBytes(id)
  const dir = store.dirOf(id)

  // 3. 先给内容打比特币时间戳 —— 不依赖 Arweave 是否成功,拿到最早的时间。
  set('stamp-content')
  if (!(await store.hasFile(id, 'article.txt.ots'))) {
    await ots.stamp(path.join(dir, 'article.txt'))
    log(id, '内容已提交比特币 calendar(pending)')
  } else {
    log(id, '内容时间戳已存在,跳过')
  }

  // 4. 永久写入 Arweave。传过就绝不再传。
  set('arweave')
  let up = meta.arweave
  if (up?.txid) {
    log(id, `Arweave 已传过,跳过(${up.txid})`)
  } else {
    up = await ar.upload(bytes, {
      title: meta.title,
      author: meta.author,
      sha256: meta.sha256,
    })
    meta.arweave = { txid: up.txid, url: up.url, uploadedAt: up.uploadedAt }
    log(id, `Arweave txid ${up.txid}`)
  }

  // 5. 回执:把「内容哈希」和「Arweave 交易」绑进同一份字节,再锚一次比特币。
  //    这一步证明的不只是文章存在,还证明**这次上传本身**发生在那个时刻,
  //    于是 Arweave 自己的时间戳可不可信就不再重要了。
  set('stamp-receipt')
  if (!(await store.hasFile(id, 'receipt.txt.ots'))) {
    const receipt =
      `everlog-receipt/1\n` +
      `article: ${id}\n` +
      `sha256: ${meta.sha256}\n` +
      `arweave: ${up.txid}\n` +
      `issued: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n`
    await store.writeProof(id, 'receipt.txt', Buffer.from(receipt, 'utf8'))
    await ots.stamp(path.join(dir, 'receipt.txt'))
    log(id, '回执已提交比特币 calendar(pending)')
  } else {
    log(id, '回执时间戳已存在,跳过')
  }

  meta.bitcoin = { confirmed: false, proofs: ['article.txt.ots', 'receipt.txt.ots'] }
  meta.status = 'published'
  meta.publishedAt = new Date().toISOString()
  await store.writeMeta(id, meta)

  // 第三重时间戳 + 异地备份。不阻塞返回,失败也不影响这篇文章已经拿到的证明。
  gitSync(`发表《${meta.title}》— ${meta.author}

sha256: ${meta.sha256}
arweave: ${up.txid}`)
    .then(r => log(id, 'Git:' + r.detail))

  if (j) { j.meta = meta; set('done') }
  return meta
}

/**
 * 启动时收拾上次崩溃/重启留下的半成品。
 *
 * status 卡在 'publishing' 的目录,list() 看不见、pendingProofs() 也不管,
 * 会永远无声无息地烂在那里 —— 而如果它崩在 Arweave 上传之后,
 * 那次**不可逆**的上传就白花了,我们连它上过链都不知道。
 *
 * 所以分两种情况:
 *   已经传上 Arweave  → 补完剩下的步骤,救回来(上传的钱不能白花)
 *   还没传            → 标记失败,记一行日志,不再假装它不存在
 */
async function recoverOrphans() {
  let ids = []
  try {
    ids = await store.listAll()
  } catch { return }

  for (const id of ids) {
    let meta
    try { meta = await store.readMeta(id) } catch { continue }
    if (meta.status !== 'publishing') continue

    if (meta.arweave?.txid) {
      console.log(`[recover] ${id}《${meta.title}》已上 Arweave,补完剩余步骤`)
      try {
        await publish(id, meta)   // 幂等:重跑会补上回执与存证
        console.log(`[recover] ${id} 已救回`)
      } catch (e) {
        console.log(`[recover] ${id} 救不回来: ${e.message}`)
      }
    } else {
      meta.status = 'failed'
      meta.failedReason = '发布过程中服务中断,尚未写入 Arweave'
      await store.writeMeta(id, meta)
      console.log(`[recover] ${id}《${meta.title}》标记为失败(未上链,无损失)`)
    }
  }
}

app.post('/api/publish', rateLimit, async (req, res) => {
  if (REQUIRE_LOGIN && !req.userId) {
    return res.status(401).json({ error: '本站需要登录后才能发布' })
  }
  // 只认 token,信封从服务端自己的抽屉里取 —— 前端给什么 anchors 一律不看
  const rec = envelopes.get(req.body?.token)
  if (!rec) {
    return res.status(400).json({ error: '预览已过期或无效,请返回重新预览' })
  }
  envelopes.delete(req.body.token) // 一次性,防重放

  const id = store.newId()
  jobs.set(id, { step: 'queued', log: [], error: null, meta: null })
  res.json({ id })
  // 后台跑,前端轮询 —— 上链 + 两次存证加起来可能几十秒
  pipeline(id, {
    title: req.body.title,
    author: req.body.author,
    body: req.body.body,
    // 归属只是方便找回,**不写进文章字节** ——
    // 写进去会改变规范格式,让 everlog/2 的证明和版本1 不通用。
    // 而且账号也证明不了「谁写的」(署名仍是自称),没有理由污染那串永久字节。
    owner: req.userId || null,
    ...rec.envelope,
  }).catch(e => {
    const j = jobs.get(id)
    if (j) { j.error = e.message; j.step = 'error' }
  })
})

app.get('/api/job/:id', (req, res) => {
  const j = jobs.get(req.params.id)
  if (!j) return res.status(404).json({ error: '任务不存在' })
  res.json({ step: j.step, log: j.log, error: j.error, meta: j.meta })
})

/* --------------------------------------------------------------- 读取 */
app.get('/api/list', async (_req, res) => {
  res.json(await store.list())
})

app.get('/api/a/:id', async (req, res) => {
  try {
    const meta = await store.readMeta(req.params.id)
    if (meta.status !== 'published') return res.status(404).json({ error: '未发布' })
    const bytes = await store.readBytes(req.params.id)
    // proofComplete 决定前端下载按钮是灰的还是亮的
    res.json({ ...meta, proofComplete: isComplete(meta), text: bytes.toString('utf8'), ...parse(bytes) })
  } catch {
    res.status(404).json({ error: '找不到' })
  }
})

/** 下载证明文件。这是整个站最重要的出口:
 *  拿走 article.txt + article.txt.ots,验证就完全不需要这个网站了。 */
app.get('/api/a/:id/file/:name', async (req, res) => {
  const { id, name } = req.params
  try {
    if (name === 'article.txt') {
      res.type('text/plain; charset=utf-8')
      return res.send(await store.readBytes(id))
    }
    res.type('application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${id}-${name}"`)
    res.send(await store.readProof(id, name))
  } catch {
    res.status(404).send('找不到')
  }
})

/* --------------------------------------------------- 人工审核队列(管理员) */
function admin(req, res, next) {
  // 恒定时间比较。密钥是 128 位随机,时序攻击本就不现实,
  // 但这是一行的事,没有理由留一个「原则上错」的写法。
  const given = String(req.query.k || req.headers['x-admin-key'] || '')
  const a = Buffer.from(given)
  const b = Buffer.from(ADMIN_KEY)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: '需要管理员密钥' })
  }
  next()
}

app.get('/api/admin/queue', admin, async (_req, res) => {
  const all = await store.pendingProofs()
  const ids = [...jobs.keys()]
  const queued = []
  for (const id of ids) {
    try {
      const m = await store.readMeta(id)
      if (m.status === 'review') queued.push(m)
    } catch {}
  }
  res.json({ review: queued, unconfirmed: all.length })
})

app.post('/api/admin/approve/:id', admin, async (req, res) => {
  try {
    const meta = await store.readMeta(req.params.id)
    if (meta.status !== 'review') return res.status(400).json({ error: '状态不对' })
    if (!jobs.has(req.params.id)) {
      jobs.set(req.params.id, { step: 'queued', log: [], error: null, meta: null })
    }
    res.json({ ok: true })
    publish(req.params.id, meta).catch(e => {
      const j = jobs.get(req.params.id)
      if (j) { j.error = e.message; j.step = 'error' }
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/* ------------------------------------------------------------ 证明包下载
   只在证明已固化(兄弟哈希取回来了)时才放行。
   未固化时给 409 而不是 404 —— 前端要能区分「还没好」和「不存在」。 */
app.get('/api/a/:id/bundle.zip', async (req, res) => {
  try {
    const meta = await store.readMeta(req.params.id)
    if (meta.status !== 'published') return res.status(404).send('未发布')
    if (!isComplete(meta)) {
      return res.status(409).json({
        error: '证明尚未固化',
        detail: '兄弟哈希还没从 calendar 取回来,现在下载的包无法离线验证。通常在发布后 1 小时内完成。',
      })
    }
    const b = await build(req.params.id)
    res.type('application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${b.filename}"`)
    res.send(b.data)
  } catch (e) {
    res.status(404).send('找不到')
  }
})

app.get('/api/health', async (_req, res) => {
  res.json({ ots: await ots.health(), maxBytes: MAX_BYTES })
})

// 文章页 / 首页都交给同一个 SPA 壳
app.get(/^\/a\/[A-Za-z0-9]+$/, (_req, res) => {
  res.sendFile(path.join(HERE, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`everlog → http://localhost:${PORT}`)
  recoverOrphans().catch(e => console.log('[recover] ' + e.message))
  scheduleUpgrade()
})
