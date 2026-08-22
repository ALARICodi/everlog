import zlib from 'node:zlib'

/**
 * 极简 ZIP 打包器,只用 store 模式(不压缩),零依赖。
 *
 * 为什么自己写而不是装个包:这个 zip 是整个产品的**出口**——用户拿到它,
 * 十年后靠它复算哈希。关键路径上不放第三方代码,少一层「我也不知道它做了什么」。
 * 不压缩也是刻意的:字节原样进、原样出,任何人用任何解压工具都得到一模一样的文件。
 *
 * 顺便,zip 存在的唯一理由就是**字节保真**:
 * .txt 直接下载会被某些浏览器/编辑器把 \n 悄悄改成 \r\n,每行多一个字节,哈希当场作废。
 * 装进 zip 就没有任何环节会碰它。
 */

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }

/** DOS 时间格式。固定用一个常量时间,让同样的输入永远产出同样的 zip。 */
const DOS_TIME = u16(0)
const DOS_DATE = u16(((2026 - 1980) << 9) | (1 << 5) | 1)

/**
 * @param {Array<{name:string, data:Buffer}>} files
 * @returns {Buffer}
 */
export function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = f.data
    const crc = zlib.crc32(data)

    const local = Buffer.concat([
      u32(0x04034b50),      // 本地文件头签名
      u16(20),              // 解压所需版本
      u16(0x0800),          // 标志位:文件名用 UTF-8
      u16(0),               // 压缩方法 0 = store
      DOS_TIME, DOS_DATE,
      u32(crc),
      u32(data.length),     // 压缩后大小
      u32(data.length),     // 原始大小(store 模式两者相同)
      u16(name.length),
      u16(0),               // 扩展字段长度
      name,
      data,
    ])
    locals.push(local)

    centrals.push(Buffer.concat([
      u32(0x02014b50),      // 中央目录签名
      u16(20), u16(20),
      u16(0x0800),
      u16(0),
      DOS_TIME, DOS_DATE,
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0), u16(0),       // 扩展字段 / 注释
      u16(0),               // 磁盘号
      u16(0),               // 内部属性
      u32(0),               // 外部属性
      u32(offset),          // 本地文件头偏移
      name,
    ]))

    offset += local.length
  }

  const central = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ])

  return Buffer.concat([...locals, central, eocd])
}
