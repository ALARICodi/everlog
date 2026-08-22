import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 现状快照。
 *
 * 存在的理由:**文档里绝不该写「目前有几篇文章」这种话** ——
 * 那句话几小时后就是假的,而下一个接手的人会信它。
 * 所以 CLAUDE.md 里只写「跑 npm run status」,真实状态永远现查现报。
 *
 * 文档会过期,命令不会。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ok = b => (b ? '✅' : '⬜')

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return null }
}

async function count(dir, suffix = '.json') {
  try {
    return (await fs.readdir(dir)).filter(n => n.endsWith(suffix)).length
  } catch { return 0 }
}

async function main() {
  const isV2 = !!(await readJson(path.join(ROOT, 'package.json')))?.name?.includes('v2') ||
               await fs.access(path.join(ROOT, 'lib/users.js')).then(() => true, () => false)

  console.log('')
  console.log(`everlog ${isV2 ? '版本2(带账号)' : '版本1(无账号)'}  —  ${ROOT}`)
  console.log('─'.repeat(66))

  /* ---- 文章 ---- */
  const artDir = path.join(ROOT, 'data/articles')
  let ids = []
  try { ids = await fs.readdir(artDir) } catch {}
  const metas = (await Promise.all(
    ids.map(id => readJson(path.join(artDir, id, 'meta.json'))),
  )).filter(Boolean)

  console.log(`\n文章 ${metas.length} 篇`)
  for (const m of metas) {
    const bits = [
      `${ok(!!m.arweave?.txid)} Arweave`,
      `${ok(!!m.bitcoin?.confirmed)} 比特币${m.bitcoin?.height ? ' #' + m.bitcoin.height : ''}`,
      `${ok(!!m.proofArweave?.txid)} 证明上链`,
      `${ok(!!m.arweaveBlock)} 区块号`,
    ]
    console.log(`  ${m.id}  ${m.title}`)
    console.log(`    ${m.format || 'everlog/1'} · ${m.byteLength}B · ${m.status}` +
                (m.owner ? ` · 归属 ${m.owner}` : ' · 无归属'))
    console.log(`    ${bits.join('  ')}`)
  }
  const pending = metas.filter(m => !m.bitcoin?.confirmed || !m.proofArweave || !m.arweaveBlock)
  if (pending.length) {
    console.log(`\n  ${pending.length} 篇还有未完成项 —— 服务内每 20 分钟自动重试,`)
    console.log(`  也可手动:node jobs/upgrade.js`)
  }

  /* ---- 账号(仅版本2) ---- */
  if (isV2) {
    const users = await count(path.join(ROOT, 'private/users'))
    const keysDir = path.join(ROOT, 'private/sharekeys')
    let keyFiles = []
    try { keyFiles = await fs.readdir(keysDir) } catch {}
    const keys = (await Promise.all(
      keyFiles.filter(n => n.endsWith('.json')).map(n => readJson(path.join(keysDir, n))),
    )).filter(Boolean)
    const now = Date.now()
    const live = keys.filter(k => !k.revoked && new Date(k.expiresAt).getTime() > now)
    console.log(`\n账号 ${users} 个 · 分享密钥 ${keys.length} 把(其中 ${live.length} 把有效)`)
    console.log(`  用户数据在 private/,已 gitignore —— 绝不能进公开仓库`)
  }

  /* ---- 依赖与凭证 ---- */
  console.log('\n运行前提')
  const checks = [
    ['node_modules', path.join(ROOT, 'node_modules')],
    ['Arweave 钱包', 'C:/Users/陈志平/.claude/secrets/everlog_arweave_jwk.json'],
    ['管理员密钥', 'C:/Users/陈志平/.claude/secrets/everlog_admin_key.txt'],
    ['OTS 的 ssl 垫片', 'C:/Users/陈志平/.claude/scripts/otslib/ssl.dll'],
  ]
  for (const [label, p] of checks) {
    const exists = await fs.access(p).then(() => true, () => false)
    console.log(`  ${ok(exists)} ${label}`)
  }

  /* ---- 服务在不在跑 ----
     新会话不知道这个,会去起第二个进程,然后端口冲突或者悄悄用了旧代码。
     先查一眼,比事后排查便宜得多。 */
  console.log('\n服务')
  for (const port of [8000, 8001]) {
    const who = port === 8000 ? '版本1' : '版本2'
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2500),
      })
      const h = await r.json()
      // 有没有账号接口,用来判断这个端口上跑的到底是哪个分支
      const me = await fetch(`http://127.0.0.1:${port}/api/me`, {
        signal: AbortSignal.timeout(2500),
      }).then(x => x.headers.get('content-type') || '', () => '')
      const kind = me.includes('json') ? '带账号(v2)' : '无账号(v1)'
      console.log(`  ✅ :${port} 在跑 —— ${kind},上限 ${h.maxBytes}B` +
                  (kind.includes('v2') === (who === '版本2') ? '' : '  ⚠ 和端口约定不符'))
    } catch {
      console.log(`  ⬜ :${port} 没在跑(${who})`)
    }
  }

  /* ---- git ---- */
  console.log('\n提示')
  console.log('  想知道某个决定为什么这么做:git log --grep 关键词')
  console.log('  想知道某段代码为什么这么写:直接读那个文件的注释,不要猜')
  console.log('')
}

main().catch(e => { console.error(e.message); process.exit(1) })
