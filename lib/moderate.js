import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

/**
 * 上链前的闸门。
 *
 * 这一步不是「内容审查」的洁癖,是这个产品结构性的必需品:
 * Arweave 上链不可撤销,而且是站点钱包签的名。一旦有人借这个口子把
 * 违法内容永久写进公链,站点运营者要承担后果,且没有任何补救手段 ——
 * 页面可以下架,链上删不掉。
 *
 * 所以这里刻意保守:拿不准的一律进人工队列,而不是放行。
 */

const KEY_FILE = 'C:/Users/陈志平/.claude/secrets/anthropic_api_key.txt'
const MODEL = process.env.EVERLOG_MODEL || 'claude-opus-5'

let _client = null
function client() {
  if (!_client) {
    const apiKey =
      process.env.ANTHROPIC_API_KEY ||
      fs.readFileSync(KEY_FILE, 'utf8').trim()
    _client = new Anthropic({ apiKey })
  }
  return _client
}

const Verdict = z.object({
  decision: z
    .enum(['allow', 'review', 'block'])
    .describe('allow=可直接上链, review=需人工确认, block=明确拒绝'),
  reason: z.string().describe('一句话说明理由,会展示给投稿人'),
  categories: z
    .array(z.string())
    .describe('命中的问题类别,没有就空数组'),
})

const SYSTEM = `你是一个永久存档站的上链前审核员。

背景:通过审核的文本会被**永久写入公开区块链,任何人无法删除**,并由站点的钱包签名。
这是不可逆的。因此你的判断标准是「这段文字永久公开存在,是否会给站点运营者或文中他人造成实际伤害」。

判 block(明确拒绝):
- 违反中国大陆法律的内容
- 泄露他人隐私(身份证号、住址、电话、未公开的私人信息)
- 对具体个人的人身攻击、诽谤、骚扰
- 未成年人相关的性内容
- 具体可操作的危害他人的指导(制爆、制毒、入侵等)
- 明显的垃圾广告、批量刷量内容

判 review(转人工):
- 涉及政治、宗教、民族等敏感议题,但看起来是正常的观点表达
- 提到真实在世人物且带负面评价,但可能属于正当评论
- 你无法确定是否属实的指控
- 任何你拿不准的情况

判 allow:
- 明确无害的思想随笔、技术文章、观点表达、文学创作

重要:这个站的定位是「让人发表思想洞察并留下时间证明」。
观点尖锐、立场鲜明、批评某种现象或某个机构 —— 这些本身不是问题,不要因为
「有争议」就拦截。你拦的是伤害,不是异议。

拿不准就判 review,不要判 allow,也不要判 block。`

/**
 * @param {{title:string, author:string, body:string}} article
 * @returns {Promise<{decision:'allow'|'review'|'block', reason:string, categories:string[], usage?:object}>}
 */
export async function moderate({ title, author, body }) {
  const res = await client().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low', // 分类任务,不需要深思
      format: zodOutputFormat(Verdict, 'verdict'),
    },
    messages: [
      {
        role: 'user',
        content:
          `请审核这篇待上链的投稿。\n\n` +
          `标题:${title}\n署名:${author}\n\n<正文>\n${body}\n</正文>`,
      },
    ],
  })

  const v = res.parsed_output
  if (!v) {
    // 解析失败绝不放行 —— 上链不可逆,默认走保守分支
    return {
      decision: 'review',
      reason: '自动审核未能得出结论,已转人工',
      categories: ['parse_failed'],
      usage: res.usage,
    }
  }
  return { ...v, usage: res.usage }
}

/** 粗算这次审核花了多少钱(claude-opus-5: $5/M 输入, $25/M 输出) */
export function estimateCost(usage) {
  if (!usage) return null
  const inTok = usage.input_tokens ?? 0
  const outTok = usage.output_tokens ?? 0
  const usd = (inTok * 5) / 1e6 + (outTok * 25) / 1e6
  return { inTok, outTok, usd: Number(usd.toFixed(4)), cny: Number((usd * 7.2).toFixed(3)) }
}
