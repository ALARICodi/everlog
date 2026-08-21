import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 文件系统存储。刻意不用数据库:
 * 每篇文章就是一个目录,里面躺着原文、两个 .ots 证明、一份元数据。
 * 这个目录可以直接 git commit 上 GitHub —— 那就是第三重时间戳,
 * 也意味着整站可以打包带走,不依赖任何服务商。
 *
 *   data/articles/<id>/
 *     article.txt      规范字节,与 Arweave 上、与被哈希的完全一致
 *     content.ots      对 sha256(article.txt) 的比特币时间戳
 *     txid.ots         对 Arweave txid 的比特币时间戳(把两条链绑死)
 *     meta.json        所有凭据 + 状态
 */

const ROOT = path.resolve(process.env.EVERLOG_DATA || './data')
const ARTICLES = path.join(ROOT, 'articles')

export function newId() {
  // 12 位 base32,短到能念出来,又够抗碰撞
  return crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 12)
}

export function dirOf(id) {
  if (!/^[A-Za-z0-9]{6,24}$/.test(id)) throw new Error('非法 id')
  return path.join(ARTICLES, id)
}

export async function init() {
  await fs.mkdir(ARTICLES, { recursive: true })
}

export async function create(id, bytes, meta) {
  const dir = dirOf(id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'article.txt'), bytes)
  await writeMeta(id, meta)
  return dir
}

export async function writeMeta(id, meta) {
  await fs.writeFile(
    path.join(dirOf(id), 'meta.json'),
    JSON.stringify(meta, null, 2) + '\n',
  )
}

export async function patchMeta(id, patch) {
  const meta = { ...(await readMeta(id)), ...patch }
  await writeMeta(id, meta)
  return meta
}

export async function readMeta(id) {
  return JSON.parse(await fs.readFile(path.join(dirOf(id), 'meta.json'), 'utf8'))
}

export async function readBytes(id) {
  return fs.readFile(path.join(dirOf(id), 'article.txt'))
}

export async function writeProof(id, name, bytes) {
  await fs.writeFile(path.join(dirOf(id), name), bytes)
}

/**
 * 读取证明/回执文件。
 * 白名单而不是正则 —— 这个路径直接对外暴露,宁可写死也不要留想象空间。
 * (曾经用 /^[a-z]+\.ots$/,结果匹配不了 article.txt.ots 中间那个点,
 *  导致证明文件静默地没被打进 zip,包看起来正常但完全没用。)
 */
const ALLOWED_FILES = new Set([
  'article.txt.ots',
  'receipt.txt',
  'receipt.txt.ots',
])

export async function readProof(id, name) {
  if (!ALLOWED_FILES.has(name)) throw new Error('非法证明文件名: ' + name)
  return fs.readFile(path.join(dirOf(id), name))
}

export async function list() {
  let ids = []
  try {
    ids = await fs.readdir(ARTICLES)
  } catch {
    return []
  }
  const metas = await Promise.all(
    ids.map(id => readMeta(id).catch(() => null)),
  )
  return metas
    .filter(m => m && m.status === 'published')
    .sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * upgrade 任务要处理的:任何**还有未完成的事**的已发布文章。
 *
 * 不能只挑「比特币未确认」的 —— 那样一篇文章一旦确认就再也不会被回访,
 * 后面那些依赖确认才能做的事(把 .ots 传上 Arweave)就永远轮不到,
 * 而且不会有任何报错。这种「悄悄不做」的漏最难发现。
 */
export async function pendingProofs() {
  let ids = []
  try {
    ids = await fs.readdir(ARTICLES)
  } catch {
    return []
  }
  const metas = await Promise.all(ids.map(id => readMeta(id).catch(() => null)))
  return metas.filter(m =>
    m && m.status === 'published' && (
      !m.bitcoin?.confirmed ||   // 比特币还没确认
      !m.arweaveBlock ||          // Arweave 区块还没回填
      !m.proofArweave             // 证明还没传上 Arweave
    ),
  )
}
