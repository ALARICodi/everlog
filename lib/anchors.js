/**
 * 时间下界锚点。
 *
 * 区块链时间戳天生只给**上界**:「这段字节不晚于某时刻已存在」。
 * 它给不了下界 —— 没有任何东西能阻止你宣称这篇十年前就写好了、今天才传。
 *
 * 下界要靠另一个办法:在文档里嵌入一个**在那一刻之前不可能存在**的东西。
 * 区块哈希正是这种东西 —— 不可预测,且在该区块被挖出之前全世界没人知道它。
 *
 *   文档含有第 N 号区块的哈希  → 文档必然写于该区块诞生之后   ← 下界
 *   文档的哈希被锚进第 M 号区块 → 文档必然写于该区块诞生之前   ← 上界
 *
 * 两条链各取一个,于是每篇文章有两个独立的双边区间。
 * 这买到的不是更高精度,是**独立性**:伪造要同时攻破两条链;
 * 任何一条链死掉,另一条给出的区间原样成立。
 *
 * 关于重组:即便所选区块日后被孤立,「这个哈希在那个时刻已被算出并广播」
 * 依然成立,下界的论证不受影响 —— 只是验证者要去孤块记录里找。
 * 所以这里直接取链尖,换取最紧的下界。
 */

const BTC_SOURCES = [
  {
    name: 'blockstream',
    tip: 'https://blockstream.info/api/blocks/tip/hash',
    block: h => `https://blockstream.info/api/block/${h}`,
  },
  {
    name: 'mempool',
    tip: 'https://mempool.space/api/blocks/tip/hash',
    block: h => `https://mempool.space/api/block/${h}`,
  },
]

async function getJson(url, timeout = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return r.json()
}

async function getText(url, timeout = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return (await r.text()).trim()
}

/**
 * MTP(Median Time Past)—— 第 N 号区块的严格「过去时刻」。
 *
 * 为什么不能直接用区块自己的标称时间当下界:
 * **区块时间戳是矿工自己填的**,共识规则只要求它大于前 11 个块的中位数、
 * 且不超过网络时间 +2 小时。也就是说标称时间**可以超前真实时间最多两小时**。
 *
 * 实测踩到过:963421 号块标称 10:06:14,但我们 10:04:35 就已经从节点拿到它了。
 * 拿标称时间当下界 = 超额宣称,争议现场会被一句「你自己页面自相矛盾」打穿。
 *
 * MTP 是前 11 块时间戳的中位数,共识层保证它在过去(BIP113 就是为此而设)。
 * 代价是比标称时间松几十分钟 —— 但松而正确,好过紧而站不住。
 */
export async function btcMtp(height) {
  // /blocks/:h 一次返回从 h 往下 10 个区块。要 h-1..h-11 共 11 个,两次请求。
  const a = await getJson(`https://blockstream.info/api/blocks/${height - 1}`, 25000)
  const b = await getJson(`https://blockstream.info/api/blocks/${height - 11}`, 25000)
  const byHeight = new Map()
  for (const blk of [...a, ...b]) byHeight.set(blk.height, blk.timestamp)

  const ts = []
  for (let h = height - 11; h <= height - 1; h++) {
    const t = byHeight.get(h)
    if (t === undefined) throw new Error(`缺少第 ${h} 号区块,算不出 MTP`)
    ts.push(t)
  }
  ts.sort((x, y) => x - y)
  const mtp = ts[Math.floor(ts.length / 2)]
  return {
    mtp,
    mtpTime: new Date(mtp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
}

/** 比特币链尖。两个独立浏览器互为备份,一个挂了不影响发布。 */
export async function btcTip() {
  const errs = []
  for (const s of BTC_SOURCES) {
    try {
      const hash = await getText(s.tip)
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('返回的不是区块哈希')
      const b = await getJson(s.block(hash))
      return {
        chain: 'bitcoin',
        height: b.height,
        hash,
        timestamp: b.timestamp,
        time: new Date(b.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        source: s.name,
      }
    } catch (e) {
      errs.push(`${s.name}: ${e.message}`)
    }
  }
  throw new Error('取不到比特币链尖 — ' + errs.join('; '))
}

/**
 * 按高度查一个比特币区块的时间。
 * 这就是验证的「对」那一半 —— 我们不存比特币账本,问公开浏览器。
 * 两家互为备份;答案是几万个节点各存一份的公开事实,不是谁的私产。
 */
export async function btcBlockByHeight(height) {
  const errs = []
  for (const s of BTC_SOURCES) {
    try {
      const base = s.tip.replace('/blocks/tip/hash', '')
      const hash = await getText(`${base}/block-height/${height}`)
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('返回的不是区块哈希')
      const b = await getJson(s.block(hash))
      return {
        height: b.height,
        hash,
        timestamp: b.timestamp,
        time: new Date(b.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        source: s.name,
      }
    } catch (e) {
      errs.push(`${s.name}: ${e.message}`)
    }
  }
  throw new Error(`查不到比特币第 ${height} 号区块 — ` + errs.join('; '))
}

/** Arweave 链尖。 */
export async function arTip() {
  const b = await getJson('https://arweave.net/block/current', 25000)
  return {
    chain: 'arweave',
    height: b.height,
    hash: b.indep_hash,
    timestamp: b.timestamp,
    time: new Date(b.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'arweave.net',
  }
}

/** 两条链一起取。任何一条失败就整体失败 —— 宁可不发,也不发一个瘸腿的证明。 */
export async function fetchAnchors() {
  const [btc, ar] = await Promise.all([btcTip(), arTip()])

  // MTP 拿不到不阻断发布 —— 它只影响「下界显示得多严格」,
  // 不影响证明本身(区块高度已经写进文章字节里了,MTP 任何人事后都能自己算)。
  try {
    Object.assign(btc, await btcMtp(btc.height))
  } catch (e) {
    btc.mtpError = e.message
  }

  return { btc, ar, fetchedAt: new Date().toISOString() }
}

/**
 * 锚点必须新鲜。
 *
 * 用户在确认屏上可能坐很久。如果放行一个几小时前的锚点,下界就白白松掉几小时,
 * 而用户对此毫无察觉 —— 一个悄悄变弱的证明比没有证明更糟。
 */
export const MAX_ANCHOR_AGE_MS = 2 * 60 * 60 * 1000

/**
 * 独立复核锚点是不是真的:拿高度去区块浏览器重查一遍哈希,对不上就拒绝。
 *
 * 这是纵深防御的第二层。第一层是「信封锁在服务端、只发 token」,
 * 已经堵住了前端伪造。这一层防的是第一层出意外(比如以后有人改回去、
 * 或者上游 API 在预览那一刻返回了脏数据)。
 *
 * 关键在于:锚点一旦写进文章字节就永久上链、不可撤回。
 * 上链前多花一次 HTTP 查询,换掉一个永久错误,这笔账怎么算都划算。
 */
export async function verifyAnchors(anchors) {
  const real = await btcBlockByHeight(anchors.btc.height)
  if (real.hash !== anchors.btc.hash) {
    throw new Error(
      `比特币锚点核对失败:第 ${anchors.btc.height} 号区块的真实哈希是 ${real.hash},` +
      `不是 ${anchors.btc.hash}。已中止发布。`,
    )
  }

  // Arweave 同理:按哈希取块,看高度对不对得上
  const r = await fetch(`https://arweave.net/block/hash/${anchors.ar.hash}`, {
    signal: AbortSignal.timeout(25000),
  })
  if (!r.ok) throw new Error(`Arweave 锚点核对失败:取不到区块 ${anchors.ar.hash}`)
  const blk = await r.json()
  if (blk.height !== anchors.ar.height) {
    throw new Error(
      `Arweave 锚点核对失败:该哈希对应的是第 ${blk.height} 号区块,不是 ${anchors.ar.height}。已中止发布。`,
    )
  }
  return true
}

export function assertFresh(anchors) {
  const age = Date.now() - new Date(anchors.fetchedAt).getTime()
  if (!Number.isFinite(age) || age < 0 || age > MAX_ANCHOR_AGE_MS) {
    throw new Error('锚点已过期,请返回重新预览(这样才能拿到最紧的时间下界)')
  }
  for (const k of ['btc', 'ar']) {
    const a = anchors[k]
    if (!a?.hash || !Number.isInteger(a.height)) throw new Error('锚点数据不完整')
  }
}
