import fs from 'node:fs/promises'
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

/**
 * 注册。号码由系统分配,撞号就重摇 —— 4300 万个坑,现实中一次就中。
 * @returns {Promise<{id:string, createdAt:string}>}
 */
export async function register(password, displayName) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('密码至少 8 位')
  }
  if (password.length > 200) throw new Error('密码过长')

  let id = null
  for (let i = 0; i < 20; i++) {
    const c = newUserId()
    if (!(await exists(c))) { id = c; break }
  }
  if (!id) throw new Error('分配用户号失败,请重试')

  const user = {
    id,
    displayName: String(displayName || '').trim().slice(0, 40) || id,
    password: hashPassword(password),
    createdAt: new Date().toISOString(),
    // 认证是三步的向导:密码 → 人脸(以后接入)→ 实名。
    // 走完之前 status 停在 pending,此时登录只验号+密码,免得卡在半路进不来。
    status: 'pending',
    faceEnrolled: false,
    realNameHash: null,
  }
  // wx: 独占创建,万一并发撞上同一个号也不会互相覆盖
  await fs.writeFile(fileOf(id), JSON.stringify(user, null, 2) + '\n', { flag: 'wx' })
  return { id: user.id, displayName: user.displayName, createdAt: user.createdAt }
}

/* --------------------------------------------------- 实名绑定(登录因子之一)

   真实姓名**只存哈希,不存明文**。
   它在这里的角色和密码一样是一个登录因子,而验证一个因子只需要能比对,
   不需要能读出来。存明文等于凭空多担一份泄露风险,换不来任何功能。
   页面上要显示的时候用掩码(陈**),够用了。

   注意:姓名的熵很低(常见姓名就那么多),单靠哈希挡不住穷举 ——
   所以它只能当**附加因子**,不能当主凭证。真正的身份锚定要靠以后接入的人脸。 */

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

  u.realNameHash = hashPassword(a)   // 和密码同一套 scrypt
  u.realNameMasked = maskName(a)
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
    displayName: u.displayName,
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
    displayName: u.displayName,
    status: u.status || 'pending',
    passwordSet: true,                    // 注册第一步就设了
    faceEnrolled: !!u.faceEnrolled,       // 人脸模块以后接入
    realNameBound: !!u.realNameHash,
    realNameMasked: u.realNameMasked || null,
  }
}

export async function setDisplayName(id, name) {
  const u = await read(id)
  if (!u) throw new Error('用户不存在')
  u.displayName = String(name || '').trim().slice(0, 40) || u.id
  await fs.writeFile(fileOf(id), JSON.stringify(u, null, 2) + '\n')
  return { id: u.id, displayName: u.displayName }
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
