import fs from 'node:fs'
import { TurboFactory, ArweaveSigner } from '@ardrive/turbo-sdk'
import { FORMAT, MAX_BYTES } from './canonical.js'

/**
 * Arweave 上传。走 ArDrive Turbo:100 KiB 以下免费,不需要钱包里有余额。
 * 我们在 canonical.js 里把 MAX_BYTES 硬卡在 100 KiB,所以这条路径永远不花钱——
 * 这也是这个站能对所有人免费开放的唯一原因。
 */

const JWK_PATH =
  process.env.EVERLOG_ARWEAVE_JWK ||
  'C:/Users/陈志平/.claude/secrets/everlog_arweave_jwk.json'

let _turbo = null
function turbo() {
  if (!_turbo) {
    const jwk = JSON.parse(fs.readFileSync(JWK_PATH, 'utf8'))
    _turbo = TurboFactory.authenticated({ signer: new ArweaveSigner(jwk) })
  }
  return _turbo
}

/**
 * 把规范字节永久写进 Arweave。
 *
 * tags 会被索引,任何人可以用 GraphQL 按 App-Name 检索出本站所有文章 ——
 * 也就是说,即便这个网站明天关掉,全部内容依然可以被独立枚举和取回。
 * 这是「不依赖我」的关键一环。
 *
 * @returns {{txid:string, url:string, uploadedAt:string}}
 */
export async function upload(bytes, { title, author, sha256 }) {
  if (bytes.length > MAX_BYTES) {
    throw new Error(`超过 ${MAX_BYTES} 字节的免费上限`)
  }

  let res
  try {
    res = await turbo().upload({
    data: bytes,
    dataItemOpts: {
      tags: [
        { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
        { name: 'App-Name', value: 'everlog' },
        { name: 'App-Version', value: FORMAT },
        { name: 'Title', value: title },
        { name: 'Author', value: author },
        // 把内容哈希也写进 tag:验证者不下载正文就能先比对
        { name: 'Content-SHA256', value: sha256 },
      ],
    },
    })
  } catch (e) {
    // 钱包余额为 0 是刻意的:免费额度一旦取消或这次打包超了阈值,
    // 结果是「传不上去」,而不是「悄悄扣了钱」。把这个失败说清楚,别让它变成一句天书。
    const m = String(e?.message || e)
    if (/insufficient|balance|payment|402/i.test(m)) {
      throw new Error(
        '这篇超出了 Arweave 免费额度,且钱包没有余额,已停止上传(没有产生任何费用)。' +
        '请缩短正文,或给钱包充值后重试。原始错误:' + m,
      )
    }
    throw e
  }

  // Turbo 是「先收下、再打包上链」:这里返回成功只代表**已被接收**,
  // 不代表已经能从网关取回。数据项要等 bundle 被提交、被挖进区块、被网关索引,
  // 通常几分钟到一小时。所以把它给的全部线索都留下,别只留一个 txid ——
  // 后面 upgrade 任务要靠这些判断到底落地了没有。
  return {
    txid: res.id,
    url: `https://arweave.net/${res.id}`,
    uploadedAt: new Date().toISOString(),
    receipt: {
      owner: res.owner,
      dataCaches: res.dataCaches,
      fastFinalityIndexes: res.fastFinalityIndexes,
      winc: res.winc, // "0" 就是走了免费额度的证据
    },
  }
}

const TURBO_STATUS = 'https://upload.ardrive.io/v1/tx/'

async function gqlBlock(id) {
  const query = `{
    transaction(id: "${id}") {
      block { id height timestamp }
    }
  }`
  const r = await fetch('https://arweave.net/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!r.ok) throw new Error(`arweave graphql ${r.status}`)
  const j = await r.json()
  const b = j?.data?.transaction?.block
  if (!b) return null
  return {
    height: b.height,
    id: b.id,
    timestamp: b.timestamp,
    time: new Date(b.timestamp * 1000).toISOString(),
  }
}

/**
 * 读 ANS-104 bundle 的头部,确认某个数据项真的在里面。
 *
 * 头部格式:前 32 字节是条目数,之后每条 64 字节 = 32 字节大小 + 32 字节 ID。
 * 只读头部就够,不必把整个 bundle(几十 MB)拉下来。网关不一定支持 Range,
 * 所以用流式读取,拿够字节就断开。
 */
async function bundleContains(bundleId, itemId) {
  const r = await fetch(`https://arweave.net/raw/${bundleId}`)
  if (!r.ok || !r.body) throw new Error(`bundle ${bundleId} http ${r.status}`)
  const reader = r.body.getReader()
  const chunks = []
  let have = 0
  let need = 32
  try {
    while (have < need) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      have += value.length
      if (need === 32 && have >= 32) {
        need = 32 + Number(Buffer.concat(chunks).readBigUInt64LE(0)) * 64
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  const buf = Buffer.concat(chunks)
  if (buf.length < need) return false
  const n = Number(buf.readBigUInt64LE(0))
  for (let i = 0; i < n; i++) {
    const at = 32 + i * 64 + 32
    if (buf.subarray(at, at + 32).toString('base64url') === itemId) return true
  }
  return false
}

/**
 * 查这笔交易进了哪个 Arweave 区块、区块时间是多少 —— 这就是第一重时间戳。
 *
 * 先问网关的 GraphQL。查不到不等于没上链:Turbo 把数据项打包进 bundle 上链,
 * 网关要自己把 bundle 拆开逐条索引,而这一步**会漏**。实测(2026-09-18)第一篇文章
 * 的数据项 Turbo 已 FINALIZED、所在 bundle 在 1984414 号区块里躺了一个月,
 * arweave.net / goldsky / ar-io 全都查不到这个条目。数据在链上,只是没人给它建索引。
 *
 * 区块号是第一重时间戳,不能因为网关索引漏了就永远空着。所以退一步:
 * 问 Turbo 它进了哪个 bundle → 查 bundle 的区块 → 自己读 bundle 头部确认条目确实在里面。
 * 最后一步不能省 —— Turbo 说「在」是一面之词,头部里有它的 ID 才算数。
 * 数据项在 bundle 里,bundle 在区块里,所以 bundle 的区块就是数据项的区块。
 */
export async function fetchBlock(txid) {
  const direct = await gqlBlock(txid)
  if (direct) return direct

  const st = await fetch(TURBO_STATUS + txid + '/status')
  if (!st.ok) return null // Turbo 不认识它:还没打包,或者根本不是走 Turbo 传的
  const j = await st.json()
  if (!j.bundleId) return null // 还没进 bundle

  const b = await gqlBlock(j.bundleId)
  if (!b) return null // bundle 还没被挖进区块

  if (!(await bundleContains(j.bundleId, txid))) {
    throw new Error(`Turbo 说在 bundle ${j.bundleId} 里,但 bundle 头部没有这个条目`)
  }
  return { ...b, bundleId: j.bundleId, via: 'bundle' }
}
