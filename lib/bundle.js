import * as store from './store.js'
import { zip } from './zip.js'
import { buildVerifier } from './verifier.js'

/**
 * 证明包 —— 这个产品真正的出口。
 *
 * 目标:十年后,这个网站没了、我也不在了、Arweave 和 OpenTimestamps 都关门了,
 * 用户从抽屉里翻出这个 zip,在断网的电脑上敲一条命令,
 * 算出的哈希和比特币区块里躺着的那串一模一样。
 *
 * 所以包里的 article.txt 必须是**哈希原像本身**,不是它的导出版、渲染版、包装版。
 * 一旦用户需要「先重建原文再哈希」,他就得重新实现规范化规则,
 * 那就又回到了「相信这个网站」—— 整件事白做。
 */

/** 证明是否已经自包含(兄弟哈希都取回来了,不再依赖任何服务器) */
export function isComplete(meta) {
  return !!meta?.bitcoin?.confirmed && Number.isInteger(meta?.bitcoin?.height)
}

function readme(meta) {
  const btc = meta.bitcoin || {}
  const nb = meta.notBefore
  return `everlog 证明包
================================================================

文章:${meta.title}
署名:${meta.author}
编号:${meta.id}

这个包是自包含的。验证它不需要联网,不需要本站,
不需要 Arweave,也不需要 OpenTimestamps 的服务器还活着。


一、包里有什么
----------------------------------------------------------------

article.txt        原文。这就是被丢进哈希函数的那串字节本身。
                   一个字节都不要改 —— 多一个空格、换行从 \\n 变成
                   \\r\\n,算出来的哈希就完全不同。

article.txt.ots    比特币证明。里面装着从你的哈希一路合并到树根的
                   全部「兄弟哈希」,以及树根躺在哪个比特币区块。

receipt.txt        回执:把内容哈希和 Arweave 交易号绑在一起。
receipt.txt.ots    回执的比特币证明。

meta.json          全部凭据的机读版本。


二、第一步:确认原文没被动过
----------------------------------------------------------------

Windows   certutil -hashfile article.txt SHA256
macOS     shasum -a 256 article.txt
Linux     sha256sum article.txt

应该得到:

  ${meta.sha256}

如果对不上,先别怀疑造假 —— 大概率是下载或解压环节把换行符
改掉了。请重新下载这个 zip,不要用文本编辑器打开再另存。


三、第二步:确认这个哈希在比特币里
----------------------------------------------------------------
${btc.height ? `
这篇文章的哈希已被锚定进比特币第 ${btc.height} 号区块。

装官方客户端后运行:

  pip install opentimestamps-client
  ots info article.txt.ots

输出末尾会看到 BitcoinBlockHeaderAttestation(${btc.height}),
那就是树根所在的区块号。

然后去任意区块浏览器查这个区块的时间,例如:

  https://blockstream.info/block-height/${btc.height}

得到的时间就是「这篇文章不晚于此刻已经存在」的铁证。
${btc.attestedAt ? `\n本站记录的该区块时间:${btc.attestedAt}\n` : ''}` : `
⚠ 这份证明尚未固化,暂时不能离线验证。请稍后重新下载。
`}

四、时间区间
----------------------------------------------------------------
${nb ? `
不早于(下界):

  比特币第 ${nb.bitcoin.height} 号区块  ${nb.bitcoin.time}
  Arweave 第 ${nb.arweave.height} 号区块  ${nb.arweave.time}

这两个区块的哈希写在 article.txt 的头部。区块被挖出之前,
没有任何人能预测它的哈希 —— 所以这篇文章必然写于它们诞生之后。
${btc.height ? `
不晚于(上界):

  比特币第 ${btc.height} 号区块${btc.attestedAt ? `  ${btc.attestedAt}` : ''}
` : ''}
两头一夹,才是一个有限区间。只有上界的时间戳,无法反驳
「我十年前就写好了,今天才传上去」。
` : `
本篇为 everlog/1 格式,只有上界,没有下界。
也就是说:能证明「不晚于某时刻已存在」,不能证明「不早于某时刻才写」。
`}

五、这个包丢了也没关系
----------------------------------------------------------------
${meta.arweave ? `
原文和证明都已永久存在 Arweave 上,任何人都能取回:

  正文  https://arweave.net/${meta.arweave.txid}${meta.proofArweave ? `
  证明  https://arweave.net/${meta.proofArweave.txid}` : ''}

取回的字节应当和这个包里的 article.txt / article.txt.ots 完全一致。
${meta.proofArweave ? `
也就是说:everlog 关站、GitHub 消失、你的硬盘烧了 ——
这两个地址依然能取回全部材料,你照样能自己算一遍。
` : ''}` : '  (无)'}

================================================================
生成时间:${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}
`
}

/**
 * 打包。只在证明已固化时才应该调用 —— 调用方负责把关。
 * @returns {Promise<{filename:string, data:Buffer}>}
 */
export async function build(id) {
  const meta = await store.readMeta(id)
  const files = [{ name: 'article.txt', data: await store.readBytes(id) }]

  // article.txt.ots 是核心,缺了整个包就没意义 —— 缺失必须报错,不能静默跳过
  files.push({ name: 'article.txt.ots', data: await store.readProof(id, 'article.txt.ots') })

  for (const n of ['receipt.txt', 'receipt.txt.ots']) {
    try {
      files.push({ name: n, data: await store.readProof(id, n) })
    } catch {
      // 回执是加分项(把内容和 Arweave 交易绑在一起),缺了不影响主链条
    }
  }

  files.push({ name: 'meta.json', data: Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8') })
  // 文件名用纯 ASCII:zip 的文件名编码在各家解压工具里表现不一致,中文名会乱码。
  // 内容是中文没问题,文件名不冒这个险 —— 这个包要在十年后任何系统上打得开。
  files.push({ name: 'README.txt', data: Buffer.from(readme(meta), 'utf8') })
  // 离线验证器:双击就能打开,不联网、不上传,把 79 步计算一行行摆出来。
  // 它和证明一起躺在用户硬盘里 —— 这才叫「不依赖任何人」。
  // 同样用 ASCII 文件名 —— 理由见上一行。
  files.push({ name: 'verify.html', data: Buffer.from(await buildVerifier(), 'utf8') })

  return {
    filename: `everlog-${id}.zip`,
    data: zip(files),
  }
}
