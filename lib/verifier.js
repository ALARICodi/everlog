import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = path.dirname(fileURLToPath(import.meta.url))

/**
 * 生成离线验证器 —— 一个可以双击打开、断网使用的单文件 HTML。
 *
 * 它把 sha256.js 和 otsparse.js 内联进去,不引用任何外部资源,
 * 因为它要跟证明包一起躺在用户硬盘里,十年后还能用。
 *
 * 代码只有一份源头(lib/ 下那两个文件),这里只做拼装,不复制粘贴。
 */

/** 把 ES 模块的 import/export 语法剥掉,好塞进同一个 <script> 里 */
function inline(src) {
  return src
    .replace(/^import .*$/gm, '')
    .replace(/^export \{[^}]*\}\s*$/gm, '')
    .replace(/^export (function|const|class) /gm, '$1 ')
}

export async function buildVerifier() {
  const sha = inline(await fs.readFile(path.join(LIB, 'sha256.js'), 'utf8'))
  const ots = inline(await fs.readFile(path.join(LIB, 'otsparse.js'), 'utf8'))

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>everlog 离线验证器</title>
<style>
:root{--paper:#faf8f4;--ink:#17150f;--ink2:#4a463c;--ink3:#8b8578;--rule:#ddd7cb;--rule2:#c9c2b2;--seal:#9a2617;--ok:#2f6b3c;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--serif:Georgia,"Songti SC",serif;
--sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
@media(prefers-color-scheme:dark){:root{--paper:#12110e;--ink:#e8e4da;--ink2:#a8a294;--ink3:#6f6a5e;--rule:#2b2822;--rule2:#3d392f;--seal:#c9553f;--ok:#5fa06e}}
*{box-sizing:border-box}
body{margin:0;padding:0 20px 60px;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.7}
.wrap{max-width:720px;margin:0 auto}
header{padding:34px 0 20px;border-bottom:1px solid var(--rule);margin-bottom:26px}
.brand{font-family:var(--mono);font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink3)}
h1{font-family:var(--serif);font-weight:400;font-size:25px;margin:12px 0 0}
.sub{color:var(--ink2);font-size:14px;margin-top:10px}
h2{font-family:var(--serif);font-weight:500;font-size:19px;margin:34px 0 12px}
.drop{border:1px dashed var(--rule2);padding:26px 18px;text-align:center;margin:22px 0}
.drop.over{border-color:var(--seal);border-style:solid}
.drop p{margin:0 0 14px;color:var(--ink2);font-size:14.5px}
input[type=file]{font-family:var(--sans);font-size:14px}
.f{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--rule);font-size:14px}
.f span:first-child{color:var(--ink3)}
.f b{font-family:var(--mono);font-size:12px;font-weight:400}
.res{border:1px solid var(--rule2);margin:22px 0}
.res.good{border-color:var(--ok)}
.res.bad{border-color:var(--seal)}
.res-h{font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink3);padding:11px 14px;border-bottom:1px solid var(--rule)}
.res-b{padding:14px}
.hash{font-family:var(--mono);font-size:12.5px;word-break:break-all;line-height:1.65}
.big{font-size:17px;font-family:var(--serif)}
.ok{color:var(--ok)}.bad{color:var(--seal)}
ol.steps{font-family:var(--mono);font-size:11.5px;line-height:1.55;max-height:44vh;overflow:auto;border:1px solid var(--rule);padding:12px 12px 12px 44px;margin:0}
ol.steps li{margin-bottom:7px;word-break:break-all;color:var(--ink2)}
ol.steps li b{color:var(--ink);font-weight:600}
a{color:var(--ink)}
.bigstep{border-left:3px solid var(--ok);padding:12px 0 12px 15px;margin:16px 0;font-size:16px;line-height:1.6}
.links a{display:block;font-family:var(--mono);font-size:12.5px;padding:7px 0;word-break:break-all}
.note{font-size:13.5px;color:var(--ink2);line-height:1.7;margin:14px 0 0}
.err{color:var(--seal);font-size:14px}
footer{margin-top:50px;padding-top:20px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink3);line-height:1.8}
</style>
</head>
<body><div class="wrap">
<header>
  <div class="brand">everlog · 离线验证器</div>
  <h1>自己算一遍,不用信任何人</h1>
  <p class="sub">这个页面不联网、不上传、不记录。所有计算都在你这台电脑上完成。
     你可以断网使用,也可以先另存到本地再打开。</p>
</header>

<div class="drop" id="drop">
  <p>把证明包里的 <b>article.txt</b> 和 <b>article.txt.ots</b> 拖进来<br>(或者直接把解压后的所有文件一起拖进来)</p>
  <input type="file" id="pick" multiple>
</div>
<div id="files"></div>
<div id="out"></div>

<footer>
  这个验证器和官方 OpenTimestamps 客户端算的是同一套算术、读的是同一份文件。<br>
  区别只在最后一步:官方要求你本地跑一个比特币全节点,这里改成让你去公开区块浏览器核对。
</footer>
</div>

<script>
${sha}
${ots}

const $ = s => document.querySelector(s)
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const rev = h => h.match(/../g).reverse().join('')
let article = null, proof = null

function show(name, size) {
  $('#files').insertAdjacentHTML('beforeend',
    '<div class="f"><span>' + esc(name) + '</span><b>' + size + ' 字节</b></div>')
}

async function take(fileList) {
  $('#files').innerHTML = ''
  $('#out').innerHTML = ''
  for (const f of fileList) {
    const buf = new Uint8Array(await f.arrayBuffer())
    if (/\\.ots$/i.test(f.name)) { if (/article/i.test(f.name) || !proof) proof = { name: f.name, buf } }
    else if (/^article\\.txt$/i.test(f.name)) article = { name: f.name, buf }
    show(f.name, buf.length)
  }
  if (!article || !proof) {
    $('#out').innerHTML = '<p class="err">还差文件:需要 article.txt 和 article.txt.ots 两个。</p>'
    return
  }
  run()
}

/**
 * 文件体检:哈希对不上时,查是「被编辑器改了格式」还是「根本不是这篇」。
 * 逐项还原已知的污染,看还原后能不能对上。
 */
function diagnose(buf, expected) {
  const notes = []
  let b = buf

  // BOM:记事本另存 UTF-8 时会在开头塞三个字节
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    notes.push('开头被加了 UTF-8 BOM(记事本另存的典型痕迹)')
    b = b.slice(3)
  }

  // CRLF:Windows 编辑器把每个换行从 \\n 改成 \\r\\n,每行多一个字节
  if (b.indexOf(0x0d) !== -1) {
    const out = []
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 0x0d && b[i + 1] === 0x0a) continue
      out.push(b[i])
    }
    notes.push('换行被改成了 Windows 格式(每行多一个字节)')
    b = new Uint8Array(out)
  }

  // 结尾多余空行
  while (b.length > 1 && b[b.length - 1] === 0x0a && b[b.length - 2] === 0x0a) {
    if (notes[notes.length - 1] !== '结尾多了空行') notes.push('结尾多了空行')
    b = b.slice(0, -1)
  }

  return { notes, fixed: toHex(sha256(b)), recovered: toHex(sha256(b)) === expected }
}

function run() {
  let parsed
  try { parsed = parseOts(proof.buf) }
  catch (e) { $('#out').innerHTML = '<p class="err">证明文件读不出来:' + esc(e.message) + '</p>'; return }

  const mine = toHex(sha256(article.buf))
  const match = mine === parsed.fileHash

  let html = ''

  // ---- 第一步:内容有没有被动过 ----
  html += '<h2>第一步 · 原文有没有被改过</h2>'
  html += '<div class="res ' + (match ? 'good' : 'bad') + '">'
  html += '<div class="res-h">对比</div><div class="res-b">'
  html += '<div class="hash">你这份 article.txt 算出来:<br><b>' + mine + '</b></div>'
  html += '<div class="hash" style="margin-top:10px">证明文件里记着的:<br><b>' + parsed.fileHash + '</b></div>'
  html += '<p class="big ' + (match ? 'ok' : 'bad') + '" style="margin:14px 0 0">'
  html += match ? '✓ 一致 —— 这份原文一个字节都没被改过' : '✗ 不一致 —— 这两个文件对不上'
  html += '</p></div></div>'

  if (!match) {
    // 光说「大概是换行问题」等于把人扔在原地。直接体检:
    // 到底是被污染了还是真不是这篇文章?能不能救?
    const d = diagnose(article.buf, parsed.fileHash)
    html += '<div class="res ' + (d.recovered ? 'good' : 'bad') + '"><div class="res-h">体检</div><div class="res-b">'
    if (d.notes.length) {
      html += '<p>发现这份文件被动过:</p><ul style="margin:8px 0 0;padding-left:20px">'
      for (const n of d.notes) html += '<li>' + esc(n) + '</li>'
      html += '</ul>'
    }
    if (d.recovered) {
      html += '<p class="big ok" style="margin:14px 0 0">✓ 把这些改动还原之后,哈希就对上了。</p>'
      html += '<p class="note"><b>内容本身是真的</b>,只是文件在传输或编辑过程中被改了格式。' +
              '不影响这篇文章的真实性,但要给别人看证据时,请用<b>没被动过的原件</b> —— ' +
              '重新下载 zip,解压后直接拖进来,中间不要用任何编辑器打开。</p>'
    } else if (d.notes.length) {
      html += '<p class="big bad" style="margin:14px 0 0">✗ 还原格式之后仍然对不上。</p>'
      html += '<p class="note">说明这不只是格式问题 —— 这份 article.txt 和这份证明不是一对,' +
              '或者内容确实被修改过。</p>'
    } else {
      html += '<p class="big bad">✗ 文件没有格式问题,但哈希就是对不上。</p>'
      html += '<p class="note">最可能的原因:这两个文件来自不同的文章。请确认它们出自同一个 zip。</p>'
    }
    html += '</div></div>'
    $('#out').innerHTML = html
    return
  }

  // ---- 第二步:算到树根 ----
  const btc = bitcoinChains(parsed)
  const pend = parsed.chains.filter(c => c.attestation.type === 'pending')

  if (!btc.length) {
    html += '<h2>第二步 · 比特币锚定</h2>'
    html += '<div class="res bad"><div class="res-h">尚未固化</div><div class="res-b">'
    html += '<p>这份证明里还没有比特币区块号,只有 ' + pend.length + ' 张待兑现的凭条。</p>'
    html += '<p class="note">说明兄弟哈希还没取回来。请稍后重新下载证明包。</p>'
    html += '</div></div>'
    $('#out').innerHTML = html
    return
  }

  for (const c of btc) {
    const root = toHex(c.result)
    const rroot = rev(root)
    html += '<h2>第二步 · 从你的文字算到比特币</h2>'
    html += '<div class="res good"><div class="res-h">共 ' + c.steps.length + ' 步计算</div><div class="res-b">'
    html += '<div class="hash">起点(你的原文哈希):<br><b>' + parsed.fileHash + '</b></div>'
    html += '<ol class="steps">'
    for (const s of c.steps) {
      let d = s.op === 'sha256' ? '做一次 SHA-256'
            : s.op === 'append' ? '在后面拼上 ' + s.arg
            : s.op === 'prepend' ? '在前面拼上 ' + s.arg
            : s.op === 'reverse' ? '字节序反转'
            : s.op === 'hexlify' ? '转成十六进制文本' : s.op
      html += '<li>' + esc(d) + '<br>→ <b>' + s.after.slice(0, 64) + (s.after.length > 64 ? '…' : '') + '</b></li>'
    }
    html += '</ol>'
    html += '<div class="hash" style="margin-top:14px">算完得到:<br><b>' + root + '</b></div>'
    html += '<div class="hash" style="margin-top:10px">字节序反转(比特币的显示惯例):<br><b class="ok">' + rroot + '</b></div>'
    html += '</div></div>'

    // ---- 第三步:去链上核对 ----
    html += '<h2>第三步 · 去比特币链上核对</h2>'
    html += '<div class="res"><div class="res-b">'
    // 指令放在链接之前:链接活不过十年,这句话可以。
    html += '<div class="bigstep">去查<b>比特币第 ' + c.attestation.height + ' 号区块</b>的 ' +
            '<b>Merkle Root</b>,和上面那串绿字逐字比对。</div>'
    html += '<p class="note">用哪个比特币区块浏览器都行,自己跑一个节点也行 —— ' +
            '任何能查区块的地方,查第 ' + c.attestation.height + ' 号区块,找 Merkle Root 那一栏。' +
            '对上了,就说明你手里这份文字在那个区块被挖出之前就已经存在。</p>'
    html += '<p class="note">下面这三个是 2026 年时常用的浏览器,<b>可能已经失效</b>,失效了就自己搜一个:</p>'
    html += '<div class="links">'
    html += '<a href="https://blockstream.info/block-height/' + c.attestation.height + '" target="_blank">blockstream.info/block-height/' + c.attestation.height + '</a>'
    html += '<a href="https://mempool.space/block/' + c.attestation.height + '" target="_blank">mempool.space/block/' + c.attestation.height + '</a>'
    html += '<a href="https://www.blockchain.com/explorer/blocks/btc/' + c.attestation.height + '" target="_blank">blockchain.com/explorer/blocks/btc/' + c.attestation.height + '</a>'
    html += '</div>'
    html += '<p class="note">这三个只是方便。换任何一个比特币区块浏览器,或者自己跑一个节点,' +
            '结果都一样 —— 「这个数字在不在第 ' + c.attestation.height + ' 号区块」是几万个节点各存一份的公开事实,' +
            '不是哪一家网站说了算。要骗你,得让它们全部串通。</p>'
    html += '</div></div>'
    break // 只展示最早的那个区块:越早,「不晚于」这个上界越紧
  }

  if (pend.length) {
    html += '<p class="note">(证明里另有 ' + pend.length + ' 张待兑现的凭条,属于其它 calendar 服务器的备份路径。' +
            '上面那条已经落进比特币,足够了。)</p>'
  }

  $('#out').innerHTML = html
}

$('#pick').addEventListener('change', e => take(e.target.files))
const dz = $('#drop')
;['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over') }))
;['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over') }))
dz.addEventListener('drop', e => take(e.dataTransfer.files))
</script>
</body>
</html>
`
}
