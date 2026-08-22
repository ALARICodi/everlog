import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 账号。
 *
 * **存放位置至关重要:用户数据放在 private/ 下,而不是 data/。**
 * data/ 会被自动提交推送到公开的 GitHub 仓库 —— 密码哈希、邮箱之类的东西
 * 一旦进去就是永久公开,而且 git 历史删不干净。private/ 已写进 .gitignore。
 *
 * 用户 ID 由系统随机分配,不可更改:U + 8 位数字,不含 0。
 * 不含 0 是为了避免和字母 O 混淆 —— 这个号是要被人念出来、抄下来、
 * 手打进输入框的,少一类歧义就少一类麻烦。
 * 组合数 9^8 ≈ 4300 万。
 */

const ROOT = path.resolve(process.env.EVERLOG_PRIVATE || './private')
const USERS = path.join(ROOT, 'users')

/** U + 8 位 1–9 的数字 */
export function newUserId() {
  let s = 'U'
  for (let i = 0; i < 8; i++) s += crypto.randomInt(1, 10)
  return s
}

export function isValidUserId(id) {
  return typeof id === 'string' && /^U[1-9]{8}$/.test(id)
}

export async function init() {
  await fs.mkdir(USERS, { recursive: true })
}

function fileOf(id) {
  if (!isValidUserId(id)) throw new Error('用户号格式不对')
  return path.join(USERS, id + '.json')
}

/* -------------------------------------------------------------- 口令 */

/**
 * scrypt 加随机盐。不存明文,也不用 md5/sha 这类快哈希 ——
 * 快哈希意味着攻击者每秒能试几十亿次;scrypt 是刻意做成又慢又吃内存的。
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`
}

function verifyPassword(password, stored) {
  const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$')
  if (alg !== 'scrypt') return false
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(keyB64, 'base64')
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  })
  // 恒定时间比较,不给时序攻击留缝
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

/* -------------------------------------------------------------- 增删查 */

export async function exists(id) {
  try { await fs.access(fileOf(id)); return true } catch { return false }
}

export async function read(id) {
  try {
    return JSON.parse(await fs.readFile(fileOf(id), 'utf8'))
  } catch {
    return null
  }
}

/** 校验并预先哈希口令。用在向导第一步 —— 那时还不建号。 */
export function prepPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('密码至少 8 位')
  }
  if (password.length > 200) throw new Error('密码过长')
  return hashPassword(password)
}

/**
 * 真正建号并分配用户号。
 * **只在向导走完密码+人脸、用户点「生成唯一账户」时调用。**
 *
 * **刻意没有「显示名」** —— 这个站不提供起网名的机会。
 * 一个账号只有两样东西能标识它:系统分配的用户号,和以后绑定的真实姓名。
 * 网名会让「这是谁」重新变回一件可以随口编的事,而这个产品的方向正相反。
 *
 * 号码随机分配,撞号就重摇 —— 4300 万个坑,现实中一次就中。
 * 分配之后锁死:没有任何接口提供改号途径。
 */
export async function createAccount(passwordHash, faceEnrolled) {
  let id = null
  for (let i = 0; i < 20; i++) {
    const c = newUserId()
    if (!(await exists(c))) { id = c; break }
  }
  if (!id) throw new Error('分配用户号失败,请重试')

  const user = {
    id,
    password: passwordHash,
    createdAt: new Date().toISOString(),
    status: 'pending',            // 绑定实名后转 active
    faceEnrolled: !!faceEnrolled,
    realNameHash: null,
  }
  // wx: 独占创建,万一并发撞上同一个号也不会互相覆盖
  await fs.writeFile(fileOf(id), JSON.stringify(user, null, 2) + '\n', { flag: 'wx' })
  return { id: user.id, createdAt: user.createdAt }
}

/* --------------------------------------------------- 姓名的三份副本

   注意:姓名的熵很低(常见姓名就那么多),单靠哈希挡不住穷举 ——
   所以它只能当**附加登录因子**,不能当主凭证。
   真正的身份锚定要靠以后接入的人脸。

   姓名在这里有两个互不相干的用途,所以存两份:

   1. **登录验证** → 存 scrypt 哈希。只需要能比对,不需要能读出来。
   2. **授权披露** → 存 AES-256-GCM 密文。分享密钥的持有者有权看到全名,
      所以这一份必须能解回来。

   为什么不干脆只存明文:数据库备份被偷、误传、误上传的概率远高于服务器被完全攻破。
   加密至少让「只拿到文件」的人一无所获。密钥单独放在 secrets 目录,不进仓库。 */

const NAME_KEY_FILE =
  process.env.EVERLOG_NAME_KEY_FILE ||
  'C:/Users/陈志平/.claude/secrets/everlog_name_key.txt'

function nameKey() {
  if (process.env.EVERLOG_NAME_KEY) return Buffer.from(process.env.EVERLOG_NAME_KEY, 'base64')
  try {
    return Buffer.from(fsSync.readFileSync(NAME_KEY_FILE, 'utf8').trim(), 'base64')
  } catch {
    const k = crypto.randomBytes(32)
    fsSync.writeFileSync(NAME_KEY_FILE, k.toString('base64'))
    return k
  }
}

function encryptName(plain) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', nameKey(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.')
}

export function decryptName(blob) {
  try {
    const [ivB, tagB, dataB] = String(blob).split('.')
    const d = crypto.createDecipheriv('aes-256-gcm', nameKey(), Buffer.from(ivB, 'base64'))
    d.setAuthTag(Buffer.from(tagB, 'base64'))
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

function maskName(name) {
  const s = String(name).trim()
  if (s.length <= 1) return s
  return s[0] + '*'.repeat(s.length - 1)
}

export function normalizeName(name) {
  // 去掉所有空白再比对:避免「张 三」和「张三」被判成两个人
  return String(name || '').replace(/\s+/g, '').trim()
}

/** 完成实名绑定。两次输入必须一致由调用方保证,这里再校验一遍。 */
export async function bindRealName(id, name1, name2) {
  const a = normalizeName(name1)
  const b = normalizeName(name2)
  if (!a) throw new Error('姓名不能为空')
  if (a !== b) throw new Error('两次输入的姓名不一致')
  if (a.length > 60) throw new Error('姓名过长')

  const u = await read(id)
  if (!u) throw new Error('用户不存在')
  if (u.realNameHash) throw new Error('已经绑定过姓名,不可更改')

  u.realNameHash = hashPassword(a)      // 登录验证用
  u.realNameEnc = encryptName(a)        // 授权披露用(分享密钥持有者可见)
  u.realNameMasked = maskName(a)        // 平时页面上显示用
  u.status = 'active'
  u.boundAt = new Date().toISOString()
  await fs.writeFile(fileOf(id), JSON.stringify(u, null, 2) + '\n')
  return { id: u.id, realNameMasked: u.realNameMasked, status: u.status }
}

/**
 * 登录。
 *
 * 已完成认证的账号:用户号 + 密码 + 真实姓名(+ 以后的人脸)。
 * 还没绑姓名的账号:只验用户号 + 密码,并提示去把认证走完 ——
 * 否则用户卡在半路就永远进不来了。
 *
 * 失败一律给同一句话,不透露号存不存在、也不透露是哪个因子错了。
 */
export async function login(id, password, realName) {
  const fail = new Error('用户号、密码或姓名不对')
  if (!isValidUserId(id)) throw fail
  const u = await read(id)
  if (!u) {
    // 号不存在也走一遍 scrypt,让耗时看起来一样,别让人靠响应快慢探号
    crypto.scryptSync(String(password || ''), Buffer.alloc(16), 64, { N: 16384, r: 8, p: 1 })
    throw fail
  }
  if (!verifyPassword(String(password || ''), u.password)) throw fail

  if (u.realNameHash) {
    if (!verifyPassword(normalizeName(realName), u.realNameHash)) throw fail
  }

  return {
    id: u.id,
    createdAt: u.createdAt,
    status: u.status || 'pending',
    realNameMasked: u.realNameMasked || null,
    faceEnrolled: !!u.faceEnrolled,
  }
}

/** 认证进度,给向导用 */
export async function progress(id) {
  const u = await read(id)
  if (!u) return null
  return {
    id: u.id,
    status: u.status || 'pending',
    passwordSet: true,                    // 注册第一步就设了
    faceEnrolled: !!u.faceEnrolled,       // 人脸模块以后接入
    realNameBound: !!u.realNameHash,
    realNameMasked: u.realNameMasked || null,
  }
}

export async function changePassword(id, oldPassword, newPassword) {
  const u = await read(id)
  if (!u || !verifyPassword(String(oldPassword || ''), u.password)) {
    throw new Error('原密码不对')
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new Error('新密码至少 8 位')
  }
  u.password = hashPassword(newPassword)
  await fs.writeFile(fileOf(id), JSON.stringify(u, null, 2) + '\n')
  return true
}
