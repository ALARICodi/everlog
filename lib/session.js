import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * 会话:签名 cookie,**不在服务端存状态**。
 *
 * 为什么不用内存里的 session 表:这个站会跑在 Render 免费档上,闲置就休眠、
 * 醒来是新进程 —— 内存里的会话全没了,所有人被登出。
 * 签名 cookie 自带一切,进程重启、换机器都照常有效。
 *
 * cookie 内容:<用户号>.<过期时间戳>.<HMAC>
 * 服务端只用密钥验签,伪造不了,也篡改不了过期时间。
 */

const SECRET_FILE =
  process.env.EVERLOG_SESSION_SECRET_FILE ||
  'C:/Users/陈志平/.claude/secrets/everlog_session_secret.txt'

const TTL_MS = 30 * 24 * 3600 * 1000  // 30 天
const COOKIE = 'everlog_session'

function secret() {
  if (process.env.EVERLOG_SESSION_SECRET) return process.env.EVERLOG_SESSION_SECRET
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    const s = crypto.randomBytes(32).toString('base64url')
    fs.writeFileSync(SECRET_FILE, s)
    return s
  }
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function issue(userId) {
  const exp = Date.now() + TTL_MS
  const payload = `${userId}.${exp}`
  return `${payload}.${sign(payload)}`
}

/** @returns {string|null} 用户号,验不过就是 null */
export function verify(token) {
  if (typeof token !== 'string') return null
  const i = token.lastIndexOf('.')
  if (i < 0) return null
  const payload = token.slice(0, i)
  const mac = token.slice(i + 1)

  const expected = sign(payload)
  const a = Buffer.from(mac), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  const [userId, expStr] = payload.split('.')
  if (!/^U[1-9]{8}$/.test(userId)) return null
  if (!(Number(expStr) > Date.now())) return null
  return userId
}

/** 手工解析 Cookie 头,省掉一个依赖 */
export function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function setCookie(res, token) {
  // HttpOnly:JS 读不到,防 XSS 偷令牌
  // SameSite=Lax:防 CSRF
  // Secure:只在 https 下带 —— 本机 http 调试时关掉
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure}`)
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/** Express 中间件:把 req.userId 填好(没登录就是 null) */
export function attachUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE]
  req.userId = verify(token)
  next()
}

export function requireLogin(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: '请先登录' })
  next()
}

export { COOKIE }
