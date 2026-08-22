import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 第三重时间戳 + 异地备份。
 *
 * 每次发布或升级之后,把 data/ 提交并推到 GitHub。两个作用:
 *
 * 一、**备份**。整套东西里唯一不可再生的是 .ots ——
 *     硬盘坏了重新 stamp 只会拿到今天的时间戳,原来那个时刻永久丢失。
 *
 * 二、**第三方时间**。注意:git 提交自带的日期是本机写的,可以随便伪造
 *     (`GIT_COMMITTER_DATE=1999-01-01 git commit` 完全合法),所以那个日期不是证据。
 *     真正有价值的是 **GitHub 服务器记录的推送时刻** —— 那是他们的日志,改不了。
 *     而且公开仓库的推送会进入 GitHub 公开事件流,被第三方持续归档,
 *     于是这个时间被一个和比特币、Arweave 都无关的地方抄走了一份。
 *     (私有仓库拿不到这一层,只有备份作用。)
 *
 * 失败绝不能影响发布 —— 网络抽风、没配 remote,都只记一行日志就过。
 */

// 串行化:并发的 git 操作会互相锁死索引
let queue = Promise.resolve()

async function git(args, timeout = 60_000) {
  const { stdout, stderr } = await run('git', ['-C', REPO, ...args], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  })
  return (stdout || '') + (stderr || '')
}

async function hasRemote() {
  try {
    const out = await git(['remote'], 10_000)
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * 提交并推送。永不抛错。
 * @returns {Promise<{committed:boolean, pushed:boolean, detail:string}>}
 */
export function sync(message) {
  queue = queue.then(async () => {
    try {
      await git(['add', '-A', 'data'])

      // 没有变化就别提交,免得堆一串空提交
      try {
        await git(['diff', '--cached', '--quiet'])
        return { committed: false, pushed: false, detail: '无变化' }
      } catch {
        // 有变化,继续
      }

      await git(['commit', '-q', '-m', message])

      if (!(await hasRemote())) {
        return { committed: true, pushed: false, detail: '已提交(还没配 GitHub 远端)' }
      }
      try {
        await git(['push', '-q', 'origin', 'HEAD'], 120_000)
        return { committed: true, pushed: true, detail: '已提交并推送' }
      } catch (e) {
        return { committed: true, pushed: false, detail: '已提交,推送失败:' + String(e.message).slice(0, 120) }
      }
    } catch (e) {
      return { committed: false, pushed: false, detail: 'git 失败:' + String(e.message).slice(0, 160) }
    }
  }, () => ({ committed: false, pushed: false, detail: '队列异常' }))

  return queue
}
