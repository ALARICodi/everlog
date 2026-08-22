import { sha256 } from './sha256.js'

/**
 * OpenTimestamps 证明文件(.ots)解析器 —— 纯 JS,零依赖,可在浏览器里跑。
 *
 * 为什么要自己写:官方客户端只认本地比特币全节点(几百 GB),普通人不可能有。
 * 但验证其实分两半:
 *
 *   「算」—— 从原文哈希沿兄弟哈希一层层合并到树根。纯算术,离线可做。
 *   「对」—— 树根在不在某个比特币区块里。这半才需要比特币数据。
 *
 * 这个文件负责「算」那一半,并且把每一步都吐出来,让用户亲眼看见
 * R 是怎么从他自己的文字里长出来的 —— 而不是被一句 "Success!" 打发。
 *
 * 「对」那一半交给区块浏览器:「R 在不在第 N 号区块」是几万个节点
 * 各存一份的公开事实,问谁都一样,不是谁的私产。
 *
 * 格式参考 python-opentimestamps 的 serialize/deserialize 实现。
 */

const MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61,
  0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf,
  0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]) // "\x00OpenTimestamps\x00\x00Proof\x00" + 8 字节魔数

// 操作码
const OP_SHA1 = 0x02, OP_RIPEMD160 = 0x03, OP_SHA256 = 0x08, OP_KECCAK256 = 0x67
const OP_APPEND = 0xf0, OP_PREPEND = 0xf1, OP_REVERSE = 0xf2, OP_HEXLIFY = 0xf3

// 证明种类的 8 字节标签
const TAG_BITCOIN = '0588960d73d71901'
const TAG_PENDING = '83dfe30d2ef90c8e'
const TAG_LITECOIN = '06869a0d73d71b45'
const TAG_ETHEREUM = '30fe8087b5c7ead7'

const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('')

class Reader {
  constructor(buf) { this.b = new Uint8Array(buf); this.i = 0 }
  byte() {
    if (this.i >= this.b.length) throw new Error('文件在此处意外结束,可能已损坏')
    return this.b[this.i++]
  }
  bytes(n) {
    if (this.i + n > this.b.length) throw new Error('文件在此处意外结束,可能已损坏')
    return this.b.slice(this.i, this.i += n)
  }
  /** 变长整数:每字节低 7 位有效,最高位为 1 表示还有后续 */
  varuint() {
    let v = 0, shift = 0
    for (;;) {
      const b = this.byte()
      v |= (b & 0x7f) << shift
      if (!(b & 0x80)) return v >>> 0
      shift += 7
      if (shift > 28) throw new Error('变长整数过长')
    }
  }
  varbytes() { return this.bytes(this.varuint()) }
}

// 用自己实现的同步 SHA-256,不碰 crypto.subtle ——
// Chrome 在 file:// 下不提供它,而这个验证器必须能双击打开、断网使用。
function concat(a, b) {
  const r = new Uint8Array(a.length + b.length)
  r.set(a, 0); r.set(b, a.length)
  return r
}

/**
 * 递归走完整棵树。每条从叶子到某个证明的路径,都产出一条 chain。
 * @returns {Array<{steps:Array, attestation:object}>}
 */
function walk(r, msg, steps, out) {
  const handle = tag => {
    if (tag === 0x00) {
      // 走到头了:这是一个「证明」,记下这条路径
      out.push({ steps: steps.slice(), attestation: readAttestation(r), result: msg })
      return
    }
    let step, next
    switch (tag) {
      case OP_APPEND: {
        const arg = r.varbytes()
        next = concat(msg, arg)
        step = { op: 'append', arg: hex(arg), desc: `在后面拼上 ${hex(arg).slice(0, 16)}…` }
        break
      }
      case OP_PREPEND: {
        const arg = r.varbytes()
        next = concat(arg, msg)
        step = { op: 'prepend', arg: hex(arg), desc: `在前面拼上 ${hex(arg).slice(0, 16)}…` }
        break
      }
      case OP_SHA256:
        next = sha256(msg)
        step = { op: 'sha256', desc: '做一次 SHA-256' }
        break
      case OP_REVERSE:
        next = msg.slice().reverse()
        step = { op: 'reverse', desc: '字节序反转' }
        break
      case OP_HEXLIFY:
        next = new TextEncoder().encode(hex(msg))
        step = { op: 'hexlify', desc: '转成十六进制文本' }
        break
      case OP_SHA1: case OP_RIPEMD160: case OP_KECCAK256:
        throw new Error('这份证明用了本验证器不支持的哈希算法(0x' + tag.toString(16) + ')')
      default:
        throw new Error('未知操作码 0x' + tag.toString(16))
    }
    step.before = hex(msg)
    step.after = hex(next)
    steps.push(step)
    walk(r, next, steps, out)
    steps.pop()
  }

  // 0xff 表示「这里分叉,还有并行的分支」
  let tag = r.byte()
  while (tag === 0xff) {
    const saved = r.i
    handle(r.byte())
    void saved
    tag = r.byte()
  }
  handle(tag)
}

function readAttestation(r) {
  const tag = hex(r.bytes(8))
  const payload = r.varbytes()
  const p = new Reader(payload)
  switch (tag) {
    case TAG_BITCOIN:
      return { type: 'bitcoin', height: p.varuint() }
    case TAG_LITECOIN:
      return { type: 'litecoin', height: p.varuint() }
    case TAG_ETHEREUM:
      return { type: 'ethereum', height: p.varuint() }
    case TAG_PENDING:
      return { type: 'pending', uri: new TextDecoder().decode(p.varbytes()) }
    default:
      return { type: 'unknown', tag, payload: hex(payload) }
  }
}

/**
 * 解析一份 .ots。
 * @param {ArrayBuffer|Uint8Array} otsBuf
 * @returns {{fileHash:string, chains:Array}}
 */
export function parseOts(otsBuf) {
  const r = new Reader(otsBuf)
  const magic = r.bytes(MAGIC.length)
  if (hex(magic) !== hex(MAGIC)) throw new Error('这不是一个 OpenTimestamps 证明文件')

  r.varuint() // 主版本号

  const hashOp = r.byte()
  if (hashOp !== OP_SHA256) throw new Error('本验证器只支持 SHA-256 的证明')
  const fileHash = r.bytes(32)

  const chains = []
  walk(r, fileHash, [], chains)
  return { fileHash: hex(fileHash), chains }
}

/** 只挑出锚定到比特币的那些路径,按区块高度从小到大(越早的上界越紧) */
export function bitcoinChains(parsed) {
  return parsed.chains
    .filter(c => c.attestation.type === 'bitcoin')
    .sort((a, b) => a.attestation.height - b.attestation.height)
}

export { hex }
