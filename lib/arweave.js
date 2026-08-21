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

/** 查这笔交易进了哪个 Arweave 区块、区块时间是多少 —— 这就是第一重时间戳 */
export async function fetchBlock(txid) {
  const query = `{
    transaction(id: "${txid}") {
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
  if (!b) return null // 还没打包进块
  return {
    height: b.height,
    id: b.id,
    timestamp: b.timestamp,
    time: new Date(b.timestamp * 1000).toISOString(),
  }
}
