/**
 * 纯 JS 的 SHA-256,同步、零依赖。
 *
 * 为什么不用浏览器自带的 crypto.subtle:
 * Chrome 不把 file:// 当作安全上下文,直接用 file:// 打开的页面里
 * crypto.subtle 是 undefined。而这个验证器**必须**能被双击打开、断网使用 ——
 * 它的全部意义就是「十年后不依赖任何服务器」。
 * 为了这个,宁可自己实现一遍。
 *
 * 实现依据 FIPS 180-4。已用官方测试向量校验。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0

/**
 * @param {Uint8Array} msg
 * @returns {Uint8Array} 32 字节摘要
 */
export function sha256(msg) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  // 填充:1 个 0x80,补 0 到 56 mod 64,最后 8 字节是比特长度(大端)
  const len = msg.length
  const bitLenHi = Math.floor(len / 0x20000000)
  const bitLenLo = (len << 3) >>> 0
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6)
  padded.set(msg)
  padded[len] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, bitLenHi, false)
  dv.setUint32(padded.length - 4, bitLenLo, false)

  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }

  const out = new Uint8Array(32)
  new DataView(out.buffer).setUint32(0, H[0], false)
  for (let i = 0; i < 8; i++) new DataView(out.buffer).setUint32(i * 4, H[i], false)
  return out
}

export const toHex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('')
