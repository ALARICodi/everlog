import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as store from './../lib/store.js'
import * as ots from './../lib/ots.js'
import * as ar from './../lib/arweave.js'
import { btcBlockByHeight } from './../lib/anchors.js'
import { sync as gitSync } from './../lib/gitsync.js'

/**
 * 每小时跑一次。做两件事:
 *
 * 1. ots upgrade —— 把 pending 的时间戳升级成**自包含**证明。
 *    这一步做完之前,.ots 里只有「已提交给 calendar」的凭条;做完之后,
 *    里面嵌入了从内容哈希一路到比特币区块的完整 Merkle 路径。
 *    此后 OpenTimestamps 整个项目消失也无所谓 —— 证明对任意比特币节点独立成立。
 *    **不跑这一步,证明就一直依赖第三方服务器活着。这是整条链上最容易被忽略的一环。**
 *
 * 2. 回填 Arweave 区块高度和时间(第一重时间戳)。
 *
 * 用法:node jobs/upgrade.js      (或 npm run upgrade)
 */

async function upgradeOne(meta) {
  const id = meta.id
  const dir = store.dirOf(id)
  let changed = false

  // --- Arweave 区块回填 ---
  if (meta.arweave?.txid && !meta.arweaveBlock) {
    try {
      const b = await ar.fetchBlock(meta.arweave.txid)
      if (b) {
        meta.arweaveBlock = b
        changed = true
        console.log(`  [${id}] Arweave 区块 #${b.height} @ ${b.time}` +
                    (b.via === 'bundle' ? `(网关没索引这条,经 bundle ${b.bundleId} 核实)` : ''))
      } else {
        console.log(`  [${id}] Arweave 还没打包进区块`)
      }
    } catch (e) {
      console.log(`  [${id}] Arweave 查询失败: ${e.message}`)
    }
  }

  // --- 比特币证明升级 ---
  // upgrade = 去 calendar 把兄弟哈希取回来塞进 .ots。
  // 取回来之前,.ots 里只有一张「以后来取」的凭条,离线验证不了,
  // 下载按钮也就必须锁着。这一步做完,证明才真正自包含。
  const proofs = meta.bitcoin?.proofs || ['article.txt.ots', 'receipt.txt.ots']
  for (const p of proofs) {
    const proofPath = path.join(dir, p)
    await ots.upgrade(proofPath)
    const a = await ots.attestations(proofPath)

    if (!a.confirmed) {
      console.log(`  [${id}] ${p} 仍在聚合中`)
      continue
    }
    // 取最小的区块高度 —— 越早的区块,「不晚于」这个上界越紧
    const height = a.heights[0]
    console.log(`  [${id}] ${p} → 比特币区块 #${height}`)

    if (p.startsWith('article')) {
      if (meta.bitcoin?.height !== height || !meta.bitcoin?.attestedAt) {
        let blk = null
        try {
          blk = await btcBlockByHeight(height)
        } catch (e) {
          console.log(`  [${id}] 区块时间查询失败(不影响证明本身): ${e.message}`)
        }
        meta.bitcoin = {
          ...meta.bitcoin,
          confirmed: true,
          height,
          heights: a.heights,
          attestedAt: blk?.time || null,
          blockHash: blk?.hash || null,
          proofs,
        }
        changed = true
        if (blk) console.log(`  [${id}] 区块时间 ${blk.time}`)
      }
    }
  }

  // --- 把固化后的证明本身也传上 Arweave ---
  //
  // 整套东西里唯一不可再生的就是 .ots。正文丢了能从 Arweave 捞回来,
  // 比特币时间本来就在链上 —— 只有 .ots 只存在我们硬盘上,丢了就是永久丢了
  // (重新 stamp 只会拿到今天的时间戳,原来那个时刻再也证明不了)。
  //
  // 而它只有几 KB,远低于 Arweave 100 KiB 的免费线。传上去之后,
  // 我们、GitHub、硬盘全没了,用户依然能从 Arweave 取回正文和证明,自己算一遍。
  // 必须等 upgrade 完成再传:没固化的 .ots 传上去是个残废,而且删不掉。
  if (meta.bitcoin?.confirmed && !meta.proofArweave) {
    try {
      const proofBytes = await store.readProof(id, 'article.txt.ots')
      const up = await ar.upload(proofBytes, {
        title: `proof:${meta.title}`,
        author: meta.author,
        sha256: meta.sha256,
      })
      meta.proofArweave = { txid: up.txid, url: up.url, uploadedAt: up.uploadedAt }
      changed = true
      console.log(`  [${id}] 证明已上 Arweave: ${up.txid}`)
    } catch (e) {
      console.log(`  [${id}] 证明上传 Arweave 失败(下次重试): ${e.message}`)
    }
  }

  if (changed) await store.writeMeta(id, meta)
  return changed
}

export async function runUpgrade() {
  await store.init()
  const pending = await store.pendingProofs()
  if (!pending.length) return { checked: 0, changed: 0 }

  let changed = 0
  console.log(`[upgrade] 待处理 ${pending.length} 篇`)
  for (const meta of pending) {
    try {
      if (await upgradeOne(meta)) changed++
    } catch (e) {
      console.log(`  [${meta.id}] 失败: ${e.message}`)
    }
  }
  if (changed) {
    const r = await gitSync(`证明固化 ${changed} 篇`)
    console.log('[upgrade] Git:' + r.detail)
  }
  return { checked: pending.length, changed }
}

/**
 * 定时自动跑。用户点完发布就走了,不会守着跑命令 ——
 * 而在兄弟哈希取回来之前,证明包是残缺的、下载按钮是灰的。
 * 所以这件事必须自动发生,否则「1小时后可下载」这句话就是空头支票。
 */
export function scheduleUpgrade(intervalMs = 20 * 60 * 1000) {
  const tick = () => runUpgrade().catch(e => console.log('[upgrade] ' + e.message))
  setTimeout(tick, 60_000)          // 启动一分钟后先跑一次
  const t = setInterval(tick, intervalMs)
  t.unref?.()
  return t
}

// 也支持手动跑:node jobs/upgrade.js
// 注意:路径含中文时 import.meta.url 是百分号编码的,不能拿字符串直接拼来比,
// 必须用 pathToFileURL 走标准转换。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runUpgrade()
    .then(r => console.log(`完成。检查 ${r.checked} 篇,更新 ${r.changed} 篇。`))
    .catch(e => { console.error(e); process.exit(1) })
}
