/**
 * - [INPUT]: 依赖 connection 的 fetch 路由注册；依赖 sessions 的 get(sessionId) 取活会话；依赖 llm 的 stream(chunks) 做非 Agent 模型调用；可选依赖 sessionProjections 的 stateOf 读 todos；依赖 Web 的 Request/Response/AbortSignal
 * - [OUTPUT]: 注册 POST /api/next-step（建议）与 /api/next-step/stats（度量）；另导出 __test 供离线单测
 * - [POS]: next-step-suggest 的 Host 半边，是 client.js 唯一的预测来源。缓存按 (sessionId, seq)，同会话最近 3 条参与去重与提示词；失败一律静默
 * - [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

/* ── 常量 ────────────────────────────────────────────── */

// 路由必须带 /api 前缀：connection 用 endpointFromPath('/api', path) 校验并精确匹配 url.pathname
const ROUTE = '/api/next-step'
const STATS_ROUTE = '/api/next-step/stats'
const CACHE_TTL_MS = 5 * 60 * 1000
// 最近 8 轮（用户+助手共 16 条）足够判断「下一句」，再多是浪费
const HISTORY_LINES = 16
const MAX_CHARS_PER_MESSAGE = 900
const MAX_SUGGESTION_CHARS = 60
const MAX_CANDIDATES = 3
// 每个会话记住最近几条已给过的建议，用于避开重复
const RECENT_SUGGESTIONS = 3
const CONTEXT_CHARS = 420
const MAX_TODOS = 5

const DEFAULT_SETTINGS = {
  enabled: true,
  rules: true,
  candidates: 1,
  provider: '',
  model: '',
  reasoningEffort: '',
  maxTokens: 120,
  temperature: 0.9,
  dedup: true,
  timeoutMs: 6000,
}

// 提示词：不问「用户会说什么」（那必然产出「继续」），而问「下一步该推进什么」
const PROMPT_RULES = [
  'Same language as the user; imperative; name the concrete action and its object; no quotes, no numbering, no explanation.',
  'Never answer with a bare "continue", "ok", or "next step".',
  'At most 20 Chinese characters or 12 English words. Never restate the assistant.',
  'If nothing is clearly worth doing next, output exactly NONE.',
]

function systemPrompt(count) {
  const opening = [
    'You help a coding agent decide what to do next.',
    'Read the transcript and context, then write the short instruction the user would send next to move the task forward.',
    count === 1
      ? 'Output exactly one sentence.'
      : 'Output ' + count + ' different sentences, one per line, each starting with "- ".',
  ]
  return opening.concat(PROMPT_RULES).join(' ')
}

/* ── 配置 ────────────────────────────────────────────── */

function clamp(value, fallback, low, high) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(high, Math.max(low, number))
}

/**
 * 行配置来自 cordis.patch.yml 的 `config:`。
 * 这个包没有 schemastery 依赖（link 安装的包解析不到 profile 的 peer），
 * 所以这里自己做收口：类型不对就用默认值，数值一律夹在安全区间。
 */
function resolveSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const pick = (key) => (typeof source[key] === 'string' ? source[key].trim() : '')
  return {
    enabled: source.enabled !== false,
    rules: source.rules !== false,
    candidates: Math.round(clamp(source.candidates, DEFAULT_SETTINGS.candidates, 1, MAX_CANDIDATES)),
    provider: pick('provider'),
    model: pick('model'),
    reasoningEffort: pick('reasoningEffort'),
    maxTokens: Math.round(clamp(source.maxTokens, DEFAULT_SETTINGS.maxTokens, 16, 512)),
    temperature: clamp(source.temperature, DEFAULT_SETTINGS.temperature, 0, 2),
    dedup: source.dedup !== false,
    timeoutMs: Math.round(clamp(source.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 1000, 30000)),
  }
}

/* ── 工具 ────────────────────────────────────────────── */

function reply(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** 从内容块里取纯文本，忽略思考块、工具块、附件块。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 把会话历史压成一段纯文本对话记录。
 * 只保留 user / assistant 的文本，丢系统提示与工具往返——预测下一句不需要它们。
 * 少于两条有效发言时返回 null：没有历史就没有「下一句」。
 */
function buildTranscript(session) {
  let messages
  try {
    messages = session.deriveMessages()
  } catch {
    return null
  }
  if (!Array.isArray(messages)) return null
  const lines = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOf(message.content).trim()
    if (text === '') continue
    const prefix = message.role === 'user' ? 'USER: ' : 'ASSISTANT: '
    lines.push(prefix + text.slice(0, MAX_CHARS_PER_MESSAGE))
  }
  if (lines.length < 2) return null
  return lines.slice(-HISTORY_LINES).join('\n\n')
}

/**
 * 会话的当前工作上下文：未完成待办 + 工作目录名。
 * 两者都拿不到时返回空串，调用方据此省略整个 <context> 段。
 */
function buildContext(session, projections) {
  const parts = []

  try {
    const todos = typeof projections?.stateOf === 'function' ? projections.stateOf(session, 'todos') : undefined
    if (Array.isArray(todos)) {
      const open = todos.filter(
        (item) => item !== null && typeof item === 'object' && item.status !== 'completed' && typeof item.content === 'string',
      )
      if (open.length > 0) {
        const lines = open
          .slice(0, MAX_TODOS)
          .map((item) => '- [' + (item.status === 'in_progress' ? 'doing' : 'todo') + '] ' + item.content.slice(0, 80))
        parts.push('Open todos:\n' + lines.join('\n'))
      }
    }
  } catch {
    /* 读不到投影就当没有：预测可以少一点信息，不能因此失败 */
  }

  const cwd = session.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const segments = cwd.split(/[\\/]+/u).filter((segment) => segment !== '')
    const base = segments[segments.length - 1]
    if (base !== undefined) parts.push('Working directory: ' + base)
  }

  return parts.join('\n').slice(0, CONTEXT_CHARS)
}

/**
 * 模型原始输出 → 可填入草稿的一句话；不合格返回 null。
 * 模型的默认毛病是加引号、加粗、编号、换行、以及该说 NONE 时说了别的。
 */
function normalize(raw) {
  let text = String(raw ?? '')
  if (text === '') return null
  const firstBreak = text.search(/[\r\n]/u)
  if (firstBreak !== -1) text = text.slice(0, firstBreak)
  text = text.replace(/\s+/gu, ' ').trim()
  if (text === '') return null
  text = text.replace(/^[\s"'`*_「『【\[（(]+/u, '').replace(/[\s"'`*_」』】\]）)]+$/u, '').trim()
  text = text.replace(/^(?:\d{1,2}[.、)]|[-*•])\s+/u, '').trim()
  if (text === '' || /^none[.。!！]?$/iu.test(text)) return null
  return text.length > MAX_SUGGESTION_CHARS ? text.slice(0, MAX_SUGGESTION_CHARS).trim() : text
}

/**
 * 三行候选解析：只认行首带标记（`- ` / `* ` / `1. ` / `1、`）的行。
 * 模型若整段没加标记，退化为「取前几条非空行」，别让一次格式失误毁掉整轮。
 */
/**
 * 只有虚词、没有对象的句子。「继续」这类建议等于没说，宁可这轮空着。
 * 只拦纯虚词：`继续把测试补上` 带对象，照常放行。
 */
const VACUOUS_PHRASES = new Set([
  '继续',
  '继续吧',
  '继续做',
  '继续干',
  '接着',
  '接着做',
  '下一步',
  '然后呢',
  '好的',
  '好',
  '行',
  '可以',
  '嗯',
  '哦',
  'ok',
  'okay',
  'sure',
  'continue',
  'goon',
  'next',
  'nextstep',
  'keepgoing',
  'goahead',
  'yes',
])

function isVacuous(text) {
  const bare = String(text ?? '')
    .toLowerCase()
    .replace(/[\s.。，,！!？?、~～…·]+/gu, '')
  return VACUOUS_PHRASES.has(bare)
}

function parseCandidates(raw, limit = MAX_CANDIDATES) {
  const marked = []
  const plain = []
  for (const line of String(raw ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = trimmed.match(/^(?:[-*•]|\d{1,2}[.、)])\s*(.+)$/u)
    if (match !== null) marked.push(match[1])
    else plain.push(trimmed)
  }

  const source = marked.length > 0 ? marked : plain
  const out = []
  for (const item of source) {
    const text = normalize(item)
    if (text === null || isVacuous(text) || out.includes(text)) continue
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/** 用会话自己最近一次请求的模型；行配置可覆盖。 */
function resolveModel(session, settings) {
  if (settings.provider !== '' && settings.model !== '') {
    return { provider: settings.provider, model: settings.model }
  }
  if (typeof session.requestHeader !== 'function') return null
  const header = session.requestHeader()
  const config = header?.config
  if (config === undefined || config === null) return null
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') return null
  return { provider: config.provider, model: config.model }
}

/** 一次非 Agent 的模型调用：不产生会话事件，不进上下文。 */
async function complete(llm, model, settings, userText, signal) {
  const options = {
    provider: model.provider,
    model: model.model,
    system: systemPrompt(settings.candidates),
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    signal,
  }
  if (settings.reasoningEffort !== '') options.reasoningEffort = settings.reasoningEffort

  let out = ''
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') {
      out += chunk.text
      continue
    }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind !== 'stop' && kind !== 'max-tokens') throw new Error('finish:' + String(kind))
    }
  }
  return out
}

/** 组装交给模型的那条用户消息：对话记录 + 上下文 + 近期已给过的建议。 */
function buildUserText(transcript, context, recent) {
  const sections = ['<transcript>', transcript, '</transcript>']
  if (context !== '') sections.push('', '<context>', context, '</context>')
  if (recent.length > 0) {
    sections.push('', 'Recently suggested (do not repeat or paraphrase any of these):')
    for (const item of recent) sections.push('- ' + item)
  }
  return sections.join('\n')
}

/* ── 规则优先：状态已经写明下一步时，不问模型 ────────── */

/** 会话最近一句用户发言用什么语言，规则文案跟着它走。 */
function detectLanguage(transcript) {
  let lastUser = ''
  for (const line of String(transcript).split('\n\n')) {
    if (line.startsWith('USER: ')) lastUser = line
  }
  return /[\u4e00-\u9fff]/u.test(lastUser) ? 'zh' : 'en'
}

/**
 * 从会话状态里直接读出下一步。返回 null 表示规则没有把握，交给模型。
 * 只认高置信信号：进行中的待办 > 待办的待办 > 激活中的计划。
 */
function ruleCandidate(projections, session, language) {
  try {
    const todos =
      typeof projections?.stateOf === 'function' ? projections.stateOf(session, 'todos') : undefined
    if (Array.isArray(todos)) {
      const doing = todos.find(
        (item) => item?.status === 'in_progress' && typeof item.content === 'string' && item.content.trim() !== '',
      )
      if (doing !== undefined) {
        return (language === 'zh' ? '继续 ' : 'Continue: ') + doing.content.trim().slice(0, 40)
      }
      const pending = todos.find(
        (item) => item?.status === 'pending' && typeof item.content === 'string' && item.content.trim() !== '',
      )
      if (pending !== undefined) {
        return (language === 'zh' ? '下一步 ' : 'Next: ') + pending.content.trim().slice(0, 40)
      }
    }
    const plan = typeof projections?.stateOf === 'function' ? projections.stateOf(session, 'plan') : undefined
    if (plan !== null && plan !== undefined && (plan.active === true || plan.pending === true)) {
      return language === 'zh' ? '按计划继续' : 'Continue with the plan'
    }
  } catch {
    /* 投影读不到就当没有规则：预测可以少一条线索，不能因此失败 */
  }
  return null
}

/* ── 度量：只看接受率，不做持久化 ─────────────────────── */

function emptyStats() {
  return { shown: 0, accepted: 0, dismissed: 0 }
}

async function handleStats(request, state) {
  let body
  try {
    body = await request.json()
  } catch {
    return reply({ stats: null })
  }
  const sessionId = body?.sessionId
  const event = body?.event
  if (typeof sessionId !== 'string' || sessionId === '') return reply({ stats: null })
  if (event !== 'show' && event !== 'accept' && event !== 'dismiss') return reply({ stats: null })

  const stats = state.stats.get(sessionId) ?? emptyStats()
  if (event === 'show') stats.shown += 1
  else if (event === 'accept') stats.accepted += 1
  else stats.dismissed += 1
  state.stats.set(sessionId, stats)
  return reply({ stats })
}

/* ── 路由 ────────────────────────────────────────────── */

async function handle(request, app, state) {
  let body
  try {
    body = await request.json()
  } catch {
    return reply({ candidates: [], suggestion: null, reason: 'bad-body' })
  }

  const sessionId = body?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    return reply({ candidates: [], suggestion: null, reason: 'no-session-id' })
  }
  const force = body?.force === true

  const settings = state.settings
  if (settings.enabled === false) return reply({ candidates: [], suggestion: null, reason: 'disabled' })

  const session = app.sessions.get(sessionId)
  if (session === undefined) return reply({ candidates: [], suggestion: null, reason: 'not-live' })
  const cacheKey = sessionId + ':' + String(session.seq)
  if (!force) {
    const hit = state.cache.get(cacheKey)
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) {
      return reply({ candidates: hit.candidates, suggestion: hit.candidates[0] ?? null, cached: true })
    }
    // 同一回合的并发请求合并成一次模型调用
    const inflight = state.inflight.get(cacheKey)
    if (inflight !== undefined) return inflight
  }

  const job = generate({ app, state, session, sessionId, cacheKey, settings, force, signal: request.signal })
  if (!force) {
    state.inflight.set(cacheKey, job)
    job.finally(() => state.inflight.delete(cacheKey)).catch(() => {})
  }
  return job
}

async function generate({ app, state, session, sessionId, cacheKey, settings, force, signal }) {
  const transcript = buildTranscript(session)
  if (transcript === null) return reply({ candidates: [], suggestion: null, reason: 'too-early' })

  const projections = app.get('sessionProjections')
  const recent = state.recent.get(sessionId) ?? []

  // 规则优先：状态已经写明下一步时不花模型的钱
  if (settings.rules) {
    const rule = ruleCandidate(projections, session, detectLanguage(transcript))
    if (rule !== null && !recent.includes(rule)) {
      state.recent.set(sessionId, [...recent, rule].slice(-RECENT_SUGGESTIONS))
      if (!force) state.cache.set(cacheKey, { candidates: [rule], at: Date.now() })
      return reply({ candidates: [rule], suggestion: rule, source: 'rule' })
    }
  }

  const model = resolveModel(session, settings)
  if (model === null) return reply({ candidates: [], suggestion: null, reason: 'no-model' })

  const context = buildContext(session, projections)
  const userText = buildUserText(transcript, context, recent)

  const timeout = AbortSignal.timeout(settings.timeoutMs)
  const combined =
    typeof AbortSignal.any === 'function' && signal !== null ? AbortSignal.any([signal, timeout]) : timeout

  let candidates
  try {
    candidates = parseCandidates(await complete(app.llm, model, settings, userText, combined), settings.candidates)
  } catch (error) {
    console.warn('[next-step] generation failed:', error?.message ?? error)
    return reply({ candidates: [], suggestion: null, reason: 'generation-failed' })
  }

  // 一条都没解析出来：模型说了 NONE，或者格式彻底没救
  if (candidates.length === 0) {
    if (!force) state.cache.set(cacheKey, { candidates: [], at: Date.now() })
    return reply({ candidates: [], suggestion: null, reason: 'empty' })
  }

  if (settings.dedup && candidates.length > 0) {
    const kept = candidates.filter((item) => !recent.includes(item))
    if (kept.length === 0) {
      // 全军覆没：明确要求换一批，只重试一次
      const retryText =
        userText + '\n\nAll of those were already suggested. Write different sentences, not paraphrases.'
      try {
        const second = parseCandidates(await complete(app.llm, model, settings, retryText, combined), settings.candidates)
        candidates = second.filter((item) => !recent.includes(item))
      } catch (error) {
        console.warn('[next-step] dedup retry failed:', error?.message ?? error)
        candidates = []
      }
    } else {
      candidates = kept
    }
  }

  if (candidates.length === 0) {
    if (!force) state.cache.set(cacheKey, { candidates: [], at: Date.now() })
    return reply({ candidates: [], suggestion: null, reason: 'duplicate' })
  }

  state.recent.set(sessionId, [...recent, ...candidates].slice(-RECENT_SUGGESTIONS))
  if (!force) state.cache.set(cacheKey, { candidates, at: Date.now() })
  return reply({ candidates, suggestion: candidates[0] })
}

/* ── 插件入口 ────────────────────────────────────────── */

export function apply(ctx, config) {
  const state = {
    cache: new Map(),
    recent: new Map(),
    inflight: new Map(),
    stats: new Map(),
    settings: resolveSettings(config),
  }

  ctx.inject(['connection', 'llm', 'sessions'], (app) => {
    app.effect(() =>
      app.connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handle(request, app, state),
      }),
    )
    app.effect(() =>
      app.connection.fetch.register({
        path: STATS_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleStats(request, state),
      }),
    )
    app.effect(() => () => {
      state.cache.clear()
      state.recent.clear()
      state.inflight.clear()
      state.stats.clear()
    })
  })
}

/** 离线单测入口：不参与插件运行时，仅供 _research/test-*.mjs 使用。 */
export const __test = {
  normalize,
  isVacuous,
  parseCandidates,
  buildTranscript,
  buildContext,
  buildUserText,
  detectLanguage,
  ruleCandidate,
  resolveModel,
  resolveSettings,
  systemPrompt,
}
