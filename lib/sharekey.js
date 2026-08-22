import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 分享密钥:用户 A 生成一串 W,私下给 B,B 拿 W 就能查到 A 的姓名和全部文章。
 *
 * ── 生成方式 ──
 * 按固定格式拼一份文件,整份丢进 SHA-256,得到的哈希就是 W。
 *
 * **文件里必须有一段随机数(nonce),这是整个功能的安危所在。**
 * 如果文件只由用户号、签发时间、有效期这些可预测的字段组成,那么任何人
 * 都能自己拼出一模一样的文件、算出一模一样的 W —— 密钥就成了公开信息,
 * 谁都能查谁。加了 32 字节随机数之后,W 的取值空间是 2^256,猜不出来。
 *
 * ── 存储方式 ──
 * 服务端**只存 sha256(W),不存 W 本身**。
 * 这样即便数据库整个泄露,拿到的也只是一堆哈希,没法拿去查任何人。
 * 代价是我们自己也算不出 W —— 所以 W 只在生成那一刻显示一次,
 * 用户必须当场复制走。丢了就重新生成一个,不能找回。
 *
 * (W 本身是 256 位随机,熵极高,所以用一次 sha256 就够,
 *  不需要 scrypt 那种防暴力破解的慢哈希 —— 那是给低熵口令用的。)
 */

const ROOT = path.resolve(process.env.EVERLOG_PRIVATE || './private')
const KEYS = path.join(ROOT, 'sharekeys')

export const FORMAT = 'everlog-sharekey/1'

/** 有效期选项 */
export const DURATIONS = {
  '3h':  { ms: 3 * 3600e3,            label: '3 小时' },
  '3d':  { ms: 3 * 24 * 3600e3,       label: '3 天' },
  '3w':  { ms: 21 * 24 * 3600e3,      label: '3 周' },
  '3m':  { ms: 90 * 24 * 3600e3,      label: '3 个月' },
}

export async function init() {
  await fs.mkdir(KEYS, { recursive: true })
}

const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex')

/**
 * 生成一把密钥。
 * @returns {{key:string, file:string, id:string, expiresAt:string, label:string}}
 *          key 只在这里出现这一次,之后服务端再也算不出来
 */
/** 同时有效的密钥上限。过期的和已撤销的不占名额。 */
export const MAX_ACTIVE = 3

/** 当前仍然有效的密钥(没撤销、没过期) */
export async function activeFor(userId) {
  const now = Date.now()
  return (await all()).filter(k =>
    k.userId === userId && !k.revoked && new Date(k.expiresAt).getTime() > now)
}

export async function create(userId, duration, note) {
  const d = DURATIONS[duration]
  if (!d) throw new Error('有效期只能是 3h / 3d / 3w / 3m')

  // 上限不是技术限制,是安全习惯:密钥能看到真实姓名和全部文章,
  // 散出去的越多越难收回。逼用户先撤掉不用的那把,才是对他有利的默认。
  const active = await activeFor(userId)
  if (active.length >= MAX_ACTIVE) {
    throw new Error(
      `最多同时有 ${MAX_ACTIVE} 把有效密钥,你现在有 ${active.length} 把。` +
      `请先撤销一把不用的,再生成新的。`,
    )
  }

  const issued = new Date()
  const expires = new Date(issued.getTime() + d.ms)

  // 这份文件就是密钥的原像。nonce 是它不可预测的唯一来源。
  const file =
    `${FORMAT}\n` +
    `user: ${userId}\n` +
    `issued: ${issued.toISOString().replace(/\.\d{3}Z$/, 'Z')}\n` +
    `expires: ${expires.toISOString().replace(/\.\d{3}Z$/, 'Z')}\n` +
    `nonce: ${crypto.randomBytes(32).toString('hex')}\n`

  const key = sha256hex(Buffer.from(file, 'utf8'))
  const id = crypto.randomBytes(6).toString('hex')   // 只用于列表和吊销,不敏感

  await fs.writeFile(path.join(KEYS, id + '.json'), JSON.stringify({
    id,
    userId,
    keyHash: sha256hex(key),      // 存哈希,不存 W
    duration,
    note: String(note || '').trim().slice(0, 60),
    issuedAt: issued.toISOString(),
    expiresAt: expires.toISOString(),
    revoked: false,
    uses: 0,
    lastUsedAt: null,
  }, null, 2) + '\n', { flag: 'wx' })

  return { key, file, id, expiresAt: expires.toISOString(), label: d.label }
}

async function all() {
  let names = []
  try { names = await fs.readdir(KEYS) } catch { return [] }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try { out.push(JSON.parse(await fs.readFile(path.join(KEYS, n), 'utf8'))) } catch {}
  }
  return out
}

/** 某人自己的密钥列表。**不含 W** —— 我们也没有。 */
export async function listFor(userId) {
  const now = Date.now()
  return (await all())
    .filter(k => k.userId === userId)
    .map(k => ({
      id: k.id,
      note: k.note,
      duration: k.duration,
      label: DURATIONS[k.duration]?.label || k.duration,
      issuedAt: k.issuedAt,
      expiresAt: k.expiresAt,
      revoked: k.revoked,
      expired: new Date(k.expiresAt).getTime() <= now,
      uses: k.uses,
      lastUsedAt: k.lastUsedAt,
    }))
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
}

export async function revoke(userId, id) {
  if (!/^[0-9a-f]{12}$/.test(String(id))) throw new Error('密钥编号不对')
  const p = path.join(KEYS, id + '.json')
  let k
  try { k = JSON.parse(await fs.readFile(p, 'utf8')) } catch { throw new Error('找不到这把密钥') }
  if (k.userId !== userId) throw new Error('这不是你的密钥')
  k.revoked = true
  k.revokedAt = new Date().toISOString()
  await fs.writeFile(p, JSON.stringify(k, null, 2) + '\n')
  return true
}

/**
 * 用 W 查。返回 userId,或者一个说明为什么不行的原因。
 * 命中时顺手记一次使用 —— 让密钥主人能看到「被用过几次、最后一次什么时候」。
 */
export async function resolve(key) {
  const k = String(key || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(k)) return { ok: false, reason: '密钥格式不对(应为 64 位十六进制)' }

  const h = sha256hex(k)
  const hit = (await all()).find(x => {
    // 恒定时间比较,别让人靠响应快慢逐位试探
    const a = Buffer.from(x.keyHash), b = Buffer.from(h)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  })

  if (!hit) return { ok: false, reason: '没有这把密钥' }
  if (hit.revoked) return { ok: false, reason: '这把密钥已被撤销' }
  if (new Date(hit.expiresAt).getTime() <= Date.now()) {
    return { ok: false, reason: '这把密钥已过期(' + hit.expiresAt.slice(0, 10) + ')' }
  }

  hit.uses++
  hit.lastUsedAt = new Date().toISOString()
  await fs.writeFile(path.join(KEYS, hit.id + '.json'), JSON.stringify(hit, null, 2) + '\n')

  return { ok: true, userId: hit.userId, expiresAt: hit.expiresAt, note: hit.note }
}
