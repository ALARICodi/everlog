import crypto from 'node:crypto'

/**
 * 规范字节格式 everlog/1
 *
 * 这是整个系统的地基:所有三重时间戳都锚定在这串字节上。
 * 规则一旦发布就不能再改,否则历史证明全部作废。
 *
 * 硬规则:
 *   - UTF-8 编码,无 BOM
 *   - 换行一律 LF (\n),CRLF 和 CR 在入口就被转换掉
 *   - 头部字段顺序固定,冒号后恰好一个空格
 *   - 头部与正文之间恰好一行 "---"
 *   - 正文末尾恰好一个 \n(多余空行被剥掉)
 *   - 标题/作者内不允许换行
 *
 * 上传到 Arweave 的字节 === 被 sha256 的字节 === 页面上展示的字节。
 * 三者永远是同一个东西,不存在"版本对不上"的可能。
 */

/**
 * everlog/2 相对 /1 只多了四行下界锚点(btc-block/btc-hash/ar-block/ar-hash)。
 * 格式一经发布就不可更改 —— 改了历史文章的验证规则就分叉。
 * 所以 /1 永远按 /1 的规则有效,parse() 两个版本都认。
 */
export const FORMAT = 'everlog/2'
const KNOWN_FORMATS = ['everlog/1', 'everlog/2']
/**
 * Turbo 的免费线是 100 KiB,但它量的是**打包后的 data item**:
 * 正文 + tags(标题/署名/sha256/App-Name…)+ 签名。tags 和签名有一到两 KB。
 * 所以正文必须留出余量,否则顶格的文章打包完就掉出免费区、上传直接失败。
 *
 * 96 KiB ≈ 3.2 万汉字,对「思想随笔」这个定位绰绰有余。
 *
 * 注意:免费是 ArDrive 的政策,不是协议保证,随时可能变。
 * 好在钱包余额是 0 —— 政策一变,上传会因余额不足被拒,而不是悄悄扣钱。
 * 失败模式是「传不上去」,不是「花了钱」。
 */
export const MAX_BYTES = 96 * 1024

/** 把任意输入压成规范文本:统一换行、去掉行尾空白、收敛结尾空行 */
function normalizeText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

/**
 * 单行字段:禁止换行(防止有人用换行伪造头部),并限制长度。
 *
 * 长度上限不是为了好看:标题和署名会原样写进 Arweave 的 tag,
 * 而 Arweave 单个 tag 上限约 3 KB。超了上传会在最后一步失败 ——
 * 而那时 .ots 已经 stamp 过了,留下一个半死的文章目录。
 * 与其在链上出事,不如在入口就拦住。
 */
export const MAX_LINE_BYTES = 512

function normalizeLine(s, field = '字段') {
  const v = normalizeText(s).replace(/\n/g, ' ').trim()
  if (Buffer.byteLength(v, 'utf8') > MAX_LINE_BYTES) {
    throw new Error(`${field}过长(上限 ${MAX_LINE_BYTES} 字节,约 170 个汉字)`)
  }
  return v
}

/**
 * 生成规范字节。
 * @param {{title:string, author:string, date:string, body:string}} input
 * @returns {Buffer}
 */
export function canonicalize({ title, author, date, body, anchors }) {
  const t = normalizeLine(title, '标题')
  const a = normalizeLine(author, '署名')
  const d = new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const b = normalizeText(body)

  if (!t) throw new Error('标题不能为空')
  if (!a) throw new Error('署名不能为空')
  if (!b) throw new Error('正文不能为空')
  if (!anchors?.btc?.hash || !anchors?.ar?.hash) throw new Error('缺少时间下界锚点')

  // 这四行是下界的全部依据:它们在被挖出之前不可预测,
  // 所以「文档里含有它们」就等于「文档写于它们诞生之后」。
  // 必须和正文一起被哈希,分开存就什么都不证明。
  const text =
    `${FORMAT}\n` +
    `title: ${t}\n` +
    `author: ${a}\n` +
    `date: ${d}\n` +
    `btc-block: ${anchors.btc.height}\n` +
    `btc-hash: ${anchors.btc.hash}\n` +
    `ar-block: ${anchors.ar.height}\n` +
    `ar-hash: ${anchors.ar.hash}\n` +
    `---\n` +
    `${b}\n`

  return Buffer.from(text, 'utf8')
}

/** 反解:验证者拿到 Arweave 上的字节后,用它还原出结构化内容 */
export function parse(buf) {
  const text = buf.toString('utf8')
  const sep = text.indexOf('\n---\n')
  const fmt = KNOWN_FORMATS.find(f => text.startsWith(f + '\n'))
  if (!fmt || sep === -1) {
    throw new Error('不是合法的 everlog 文档(支持 ' + KNOWN_FORMATS.join(' / ') + ')')
  }
  const head = text.slice(fmt.length + 1, sep)
  const body = text.slice(sep + 5)
  const fields = {}
  for (const line of head.split('\n')) {
    const i = line.indexOf(': ')
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 2)
  }
  return { format: fmt, ...fields, body: body.replace(/\n$/, '') }
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest()
}

export function sha256hex(buf) {
  return sha256(buf).toString('hex')
}

/**
 * 提交前的体检:不产生任何副作用,只告诉调用方「如果现在发布,会发布什么」。
 * 页面上的二次确认就用这个返回值。
 */
export function inspect(input) {
  const bytes = canonicalize(input)
  return {
    bytes,
    format: FORMAT,
    byteLength: bytes.length,
    sha256: sha256hex(bytes),
    overLimit: bytes.length > MAX_BYTES,
    maxBytes: MAX_BYTES,
    text: bytes.toString('utf8'),
  }
}
