import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'

const run = promisify(execFile)

/**
 * OpenTimestamps —— 比特币时间戳。
 *
 * 刻意调用官方 Python 参考实现,而不是 npm 上的 javascript-opentimestamps:
 * 后者依赖 2020 年就废弃的 request-promise。对一个「永久证据」产品来说,
 * 证明文件的格式必须绝对正确,互操作性风险远大于「统一运行时」的便利。
 *
 * Windows 踩坑:python-bitcoinlib 导入时会找 ssl.dll 找不到就崩(存证根本用不到
 * 那个模块,纯属导入链连坐)。otslib/ 里放了一份 libcrypto 改名的 ssl.dll,
 * 运行时挂进 PATH 即可。
 */

const SHIM = process.env.EVERLOG_OTS_SHIM || 'C:\\Users\\陈志平\\.claude\\scripts\\otslib'

function env() {
  return { ...process.env, PATH: `${SHIM};${process.env.PATH}` }
}

async function ots(args, opts = {}) {
  try {
    const { stdout, stderr } = await run('ots', args, {
      env: env(),
      timeout: opts.timeout ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, out: (stdout || '') + (stderr || '') }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') + (e.message || '') }
  }
}

/**
 * 对一个文件做时间戳。生成 <file>.ots,状态为 pending —— 哈希已经进了
 * calendar 的聚合队列,等下一批打包进比特币区块(通常 1–2 小时)。
 */
export async function stamp(filePath) {
  const r = await ots(['stamp', filePath])
  const proof = filePath + '.ots'
  try {
    await fs.access(proof)
  } catch {
    throw new Error('ots stamp 失败: ' + r.out.slice(0, 400))
  }
  return { proofPath: proof, log: r.out.trim() }
}

/**
 * 把 pending 的证明升级成自包含的完整证明。
 * 跑完之后 .ots 里嵌入了从你的哈希到比特币区块的完整 Merkle 路径,
 * 此后即便 OpenTimestamps 整个项目消失,这个文件依然能对任意比特币节点验证。
 */
export async function upgrade(proofPath) {
  const r = await ots(['upgrade', proofPath])
  // 升级成功时客户端会留一个 .bak,清掉免得污染仓库
  await fs.rm(proofPath + '.bak', { force: true })
  const done = /Success!|Timestamp has been successfully upgraded/i.test(r.out)
  return { upgraded: done, log: r.out.trim() }
}

/**
 * 读出这份证明锚定在哪些比特币区块。
 *
 * 刻意不用 `ots verify` —— 它默认要求本地跑一个比特币全节点(几百 GB),
 * 没有节点就直接报错,判不出任何结果。普通用户不可能有节点,服务器也不该有。
 *
 * 但验证其实分两半:
 *   算 —— 从内容哈希沿兄弟哈希一路合并到树根。纯算术,离线可做。
 *   对 —— 树根在不在某个比特币区块里。这半才需要比特币数据。
 *
 * `ots info` 已经把「算」的结果和目标区块号摊在文件里了,不需要节点。
 * 剩下「对」那半交给区块浏览器(见 anchors.js)——
 * 「R 在不在第 N 号区块」是几万个节点各存一份的公开事实,问谁都一样。
 *
 * @returns {{heights:number[], pending:boolean, confirmed:boolean}}
 */
export async function attestations(proofPath) {
  const out = await info(proofPath)
  const heights = [...out.matchAll(/BitcoinBlockHeaderAttestation\((\d+)\)/g)]
    .map(m => Number(m[1]))
    .sort((a, b) => a - b)
  return {
    heights,
    // 还有 calendar 凭条没兑现 —— 不影响已经拿到的区块,只说明还能更完整
    pending: /PendingAttestation/.test(out),
    confirmed: heights.length > 0,
  }
}

/** 把 .ots 的内部结构 dump 出来 —— 就是那条「兄弟哈希路径」的配方 */
export async function info(proofPath) {
  const r = await ots(['info', proofPath])
  return r.out.trim()
}

/** 自检:ots 命令在不在、能不能跑 */
export async function health() {
  const r = await ots(['--version'], { timeout: 15_000 })
  return { ok: r.ok, detail: r.out.trim().split('\n')[0] || '' }
}

export function proofName(filePath) {
  return path.basename(filePath) + '.ots'
}
