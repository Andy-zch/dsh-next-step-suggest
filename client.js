/**
 * - [INPUT]: 依赖 slot props 的 useInput（draft/phase）、useSession（running）、inputActions.setDraft；依赖 react 的 createElement/useState/useEffect/useLayoutEffect/useRef/useCallback；依赖浏览器 fetch、keydown 捕获、getBoundingClientRect、ResizeObserver、visibilityState
 * - [OUTPUT]: 向 conversation.input.overlay 注册 id=next-step-ghost 的组件：单条灰字、Tab 接受、Esc 本回合闭嘴、条件式触发（空闲 + 草稿空 + 无建议）+ 冷却/上限/连拒/重试间隔四道闸门、延迟浮现、会话隔离、跳闸原因写 console、屏读播报
 * - [POS]: next-step-suggest 的 Client 半边。只读草稿、只写一次草稿、只在回合结束发一个预测请求，从不发送消息。与 index.js 成对
 * - [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-next-step-suggest',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ── 常量 ────────────────────────────────────────── */

    const ROUTE = '/api/next-step'
    const STATS_ROUTE = '/api/next-step/stats'
    // 灰字根节点上的标记：CSS 钩子，也是「建议可见」的唯一真相
    const GHOST_ATTR = 'data-next-step-ghost'
    const PLACEHOLDER_SELECTOR = '[data-composer-placeholder]'

    const FETCH_TIMEOUT_MS = 8000
    // 只在回合结束的边沿请求，这里的防抖只为合并同一帧内的抖动
    const REQUEST_DEBOUNCE_MS = 120
    // 等回答先落进眼里，灰字再浮现
    const SHOW_DELAY_MS = 1200
    // 闸门：多久允许再次尝试、多久允许再出现一次、一个会话最多出现几次
    const RETRY_GAP_MS = 60000
    const MIN_INTERVAL_MS = 180000
    const MAX_PER_SESSION = 6
    // 连续按 Esc 到这个次数，本会话闭嘴；接受一次就把连拒清零，并把冷却缩短到 60 秒
    const DISMISS_STREAK_LIMIT = 2
    const ACCEPT_COOLDOWN_MS = 60000

    const TEXT_COLOR = 'var(--dsw-alias-label-secondary, inherit)'
    const BORDER_COLOR = 'var(--dsw-alias-border-l1, currentColor)'

    const FADE_KEYFRAMES =
      '@keyframes next-step-in{from{opacity:0;transform:translateY(1px)}to{opacity:1;transform:none}}'

    const SR_ONLY = {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clip: 'rect(0 0 0 0)',
      whiteSpace: 'nowrap',
      border: '0',
      padding: '0',
      margin: '-1px',
    }

    /* ── DOM 关系 ────────────────────────────────────── */

    /**
     * 两个节点是否处在同一张 composer 卡片里。
     * 从候选节点向上爬，找到第一个包含 root 的祖先；爬到 body 还没找到就是别的卡片。
     */
    function sharesCard(root, node) {
      if (root === null || node === null) return false
      let cursor = node
      while (cursor !== null && cursor !== document.body) {
        if (cursor.contains(root)) return true
        cursor = cursor.parentElement
      }
      return false
    }

    function findPlaceholder(root) {
      const all = document.querySelectorAll(PLACEHOLDER_SELECTOR)
      if (all.length <= 1) return all[0] ?? null
      for (const item of all) if (sharesCard(root, item)) return item
      return all[0] ?? null
    }

    /* ── 度量 ────────────────────────────────────────── */

    /**
     * 量出宿主占位符的位置与字体，供灰字逐像素对齐。
     * 颜色不走这里：颜色用主题 token，主题切换才能立刻跟上。
     */
    function measure(root) {
      const placeholder = findPlaceholder(root)
      if (placeholder === null || root === null) return null
      const p = placeholder.getBoundingClientRect()
      const r = root.getBoundingClientRect()
      if (p.width === 0 || p.height === 0) return null
      const cs = window.getComputedStyle(placeholder)
      return {
        left: p.left - r.left,
        top: p.top - r.top,
        width: p.width,
        paddingLeft: cs.paddingLeft,
        paddingTop: cs.paddingTop,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
      }
    }

    /* ── 视图 ────────────────────────────────────────── */

    function GhostStyle({ hidePlaceholder }) {
      // 只在单 composer 时遮蔽原生占位符；双面板下宁可不遮蔽，也不误伤另一侧
      const hide = hidePlaceholder
        ? 'body:has([' + GHOST_ATTR + ']) ' + PLACEHOLDER_SELECTOR + '{visibility:hidden!important}'
        : ''
      return h('style', { dangerouslySetInnerHTML: { __html: hide + FADE_KEYFRAMES } })
    }

    function GhostText({ box, text }) {
      const boxStyle = {
        position: 'absolute',
        left: box.left + 'px',
        top: box.top + 'px',
        width: box.width + 'px',
        paddingLeft: box.paddingLeft,
        paddingTop: box.paddingTop,
        fontFamily: box.fontFamily,
        fontSize: box.fontSize,
        lineHeight: box.lineHeight,
        letterSpacing: box.letterSpacing,
        color: TEXT_COLOR,
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        animation: 'next-step-in 140ms ease-out both',
      }
      const textStyle = {
        minWidth: 0,
        flex: '0 1 auto',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        userSelect: 'none',
      }
      const keycapStyle = {
        flex: '0 0 auto',
        padding: '0 5px',
        fontSize: '11px',
        lineHeight: '16px',
        fontFamily: 'inherit',
        color: TEXT_COLOR,
        border: '1px solid ' + BORDER_COLOR,
        borderRadius: '4px',
        opacity: 0.9,
      }

      return h('div', { style: boxStyle }, h('span', { style: textStyle }, text), h('kbd', { style: keycapStyle }, 'Tab'))
    }

    /* ── 组件 ────────────────────────────────────────── */

    function GhostInner(props) {
      const { useInput, useSession, inputActions, sessionId } = props
      const input = useInput((s) => s)
      const running = useSession((s) => s?.running) === true
      const draft = input?.draft ?? ''
      const phase = input?.phase ?? 'plain'

      const [text, setText] = React.useState(null)
      const [accepted, setAccepted] = React.useState(false)
      const [dismissed, setDismissed] = React.useState(false)
      const [box, setBox] = React.useState(null)

      const rootRef = React.useRef(null)
      const inflightRef = React.useRef(null)
      const pendingShowRef = React.useRef(null)
      const requestRef = React.useRef(null)
      // 频率状态：上次尝试时间、上次显示时间、本会话显示次数、连续忽略次数、当前请求令牌
      const lastAttemptAtRef = React.useRef(null)
      const lastShownAtRef = React.useRef(null)
      const shownCountRef = React.useRef(0)
      const dismissStreakRef = React.useRef(0)
      const turnTokenRef = React.useRef(0)
      const skipRef = React.useRef('init')
      // 当前会话身份：每个异步回调都用它判断「这份结果还属不属于我」
      const sessionIdRef = React.useRef(sessionId)
      sessionIdRef.current = sessionId

      // 草稿里的空格换行不算内容；输入机只把 adjudicating/submitting 当忙
      const empty = draft.trim() === ''
      const busy = phase === 'adjudicating' || phase === 'submitting'

      // 延迟浮现到点时要复核的现场
      const viewRef = React.useRef({ running, empty, busy })
      viewRef.current = { running, empty, busy }

      // 只有「空闲 + 草稿为空 + 没被接受/忽略」时才露脸
      const ready = text !== null && !accepted && !dismissed && empty && !running && !busy
      const hidePlaceholder = document.querySelectorAll(PLACEHOLDER_SELECTOR).length <= 1

      /* 请求：只取第一条。归属不符的响应整段丢弃，绝不写进别的会话 */
      const request = React.useCallback(async (token) => {
        const owner = sessionIdRef.current
        if (owner === undefined || owner === null) return
        if (inflightRef.current !== null) return
        const controller = new AbortController()
        inflightRef.current = controller
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionId: owner }),
            signal: controller.signal,
          })
          if (sessionIdRef.current !== owner) return
          if (!response.ok) {
            console.info(
              '[next-step] route responded ' +
                response.status +
                (response.status === 404 ? ' — host module not loaded yet; restart DSH once' : ''),
            )
            return
          }
          const data = await response.json()
          if (sessionIdRef.current !== owner) return

          const first = Array.isArray(data?.candidates)
            ? data.candidates.find((item) => typeof item === 'string' && item.trim() !== '')
            : undefined
          const next =
            typeof first === 'string' && first.trim() !== ''
              ? first.trim()
              : typeof data?.suggestion === 'string' && data.suggestion.trim() !== ''
                ? data.suggestion.trim()
                : null
          if (next === null && data?.reason) console.info('[next-step] no suggestion:', data.reason)
          if (next === null) return

          // 延迟浮现：到点再复核现场，用户已经在打字或换了会话就丢掉
          if (pendingShowRef.current !== null) clearTimeout(pendingShowRef.current)
          pendingShowRef.current = setTimeout(() => {
            pendingShowRef.current = null
            if (sessionIdRef.current !== owner) return
            if (turnTokenRef.current !== token) return
            const view = viewRef.current
            if (view.running || !view.empty || view.busy) return
            lastShownAtRef.current = Date.now()
            shownCountRef.current += 1
            setText(next)
            setAccepted(false)
            setDismissed(false)
            reportRef.current('show')
          }, SHOW_DELAY_MS)
        } catch (error) {
          if (error?.name !== 'AbortError' && sessionIdRef.current === owner) {
            console.info('[next-step] request failed:', String(error?.message ?? error))
          }
        } finally {
          clearTimeout(timer)
          if (inflightRef.current === controller) inflightRef.current = null
        }
      }, [])
      requestRef.current = request

      /* 度量：只上报，不渲染。接受/忽略时顺带把累计数打到 console */
      const report = React.useCallback((event) => {
        const owner = sessionIdRef.current
        if (owner === undefined || owner === null) return
        fetch(STATS_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId: owner, event }),
          keepalive: true,
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (event !== 'show' && data?.stats) console.info('[next-step] stats', data.stats)
          })
          .catch(() => {})
      }, [])
      const reportRef = React.useRef(report)
      reportRef.current = report

      /* 换会话：中止在飞请求与待显示，清空一切跨会话状态与频率计数 */
      React.useEffect(() => {
        const controller = inflightRef.current
        inflightRef.current = null
        if (controller !== null) controller.abort()
        if (pendingShowRef.current !== null) {
          clearTimeout(pendingShowRef.current)
          pendingShowRef.current = null
        }
        lastAttemptAtRef.current = null
        lastShownAtRef.current = null
        shownCountRef.current = 0
        dismissStreakRef.current = 0
        skipRef.current = 'init'
        turnTokenRef.current += 1
        setText(null)
        setAccepted(false)
        setDismissed(false)
        setBox(null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      /* 新一轮开始：上一条建议已经过期，清掉，回合结束后才好再请求 */
      React.useEffect(() => {
        if (!running) return
        setText(null)
        setAccepted(false)
        setDismissed(false)
      }, [running])

      /* 触发：条件满足就请求，不依赖「回合结束」的边沿。
         边沿会漏（错过一次就永远错过），条件式能自愈；打扰由下面的闸门负责。 */
      React.useEffect(() => {
        const note = (reason) => {
          if (skipRef.current === reason) return
          skipRef.current = reason
          if (reason !== null) console.info('[next-step] skip:', reason)
        }

        if (sessionId === undefined || sessionId === null) return note('no-session')
        if (running) return note('running')
        if (!empty) return note('draft')
        if (document.visibilityState !== 'visible') return note('hidden')
        if (text !== null) return note('showing')

        const now = Date.now()
        if (lastAttemptAtRef.current !== null && now - lastAttemptAtRef.current < RETRY_GAP_MS) {
          return note('retry-gap')
        }
        if (lastShownAtRef.current !== null && now - lastShownAtRef.current < MIN_INTERVAL_MS) {
          return note('cooldown')
        }
        if (shownCountRef.current >= MAX_PER_SESSION) return note('session-cap')
        if (dismissStreakRef.current >= DISMISS_STREAK_LIMIT) return note('muted')

        note(null)
        lastAttemptAtRef.current = now
        turnTokenRef.current += 1
        const token = turnTokenRef.current
        const timer = setTimeout(() => requestRef.current(token), REQUEST_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [running, empty, sessionId, text])

      /* 对齐：露脸时量一次，渲染后补量，容器尺寸变化时重量 */
      React.useLayoutEffect(() => {
        if (!ready) {
          setBox(null)
          return undefined
        }
        const root = rootRef.current
        if (root === null) return undefined
        const sync = () => setBox(measure(root))
        sync()
        const frame = requestAnimationFrame(sync)
        const observer = new ResizeObserver(sync)
        const placeholder = findPlaceholder(root)
        if (placeholder !== null) observer.observe(placeholder)
        if (root.parentElement !== null) observer.observe(root.parentElement)
        window.addEventListener('resize', sync)
        return () => {
          cancelAnimationFrame(frame)
          observer.disconnect()
          window.removeEventListener('resize', sync)
        }
      }, [ready, draft, text])

      /* 键位：只有 Tab 与 Esc。捕获阶段抢在编辑器之前，且只在同一张卡片、灰字可见时动手 */
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (!ready) return
          const target = event.target
          if (!(target instanceof HTMLElement) || !target.isContentEditable) return
          if (!sharesCard(rootRef.current, target)) return
          if (event.isComposing || event.keyCode === 229) return

          if (event.key === 'Escape') {
            // 本回合彻底闭嘴：没有定时器，不回来；连续忽略会累加
            dismissStreakRef.current += 1
            setDismissed(true)
            report('dismiss')
            return
          }

          if (event.key !== 'Tab') return
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
          event.preventDefault()
          event.stopPropagation()
          inputActions.setDraft(text)
          // 用过的人给高频：连拒清零，冷却缩到 60 秒
          dismissStreakRef.current = 0
          lastShownAtRef.current = Date.now() - (MIN_INTERVAL_MS - ACCEPT_COOLDOWN_MS)
          setAccepted(true)
          report('accept')
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [ready, text, inputActions, report])

      /* 卸载时中止在飞请求与待显示 */
      React.useEffect(() => {
        return () => {
          if (inflightRef.current !== null) inflightRef.current.abort()
          if (pendingShowRef.current !== null) clearTimeout(pendingShowRef.current)
        }
      }, [])

      if (!ready) {
        // 仍渲染稳定锚点，下一次测量才有参照
        return h('div', { ref: rootRef, style: { display: 'none' } })
      }

      return h(
        React.Fragment,
        null,
        h(GhostStyle, { hidePlaceholder }),
        h(
          'div',
          {
            ref: rootRef,
            [GHOST_ATTR]: '',
            style: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 },
          },
          box === null ? null : h(GhostText, { box, text }),
          h('div', { role: 'status', 'aria-live': 'polite', style: SR_ONLY }, '建议：' + text + '。按 Tab 填入。'),
        ),
      )
    }

    function NextStepGhost(props) {
      if (typeof props.useInput !== 'function') return null
      if (typeof props.useSession !== 'function') return null
      if (props.inputActions === undefined) return null
      return h(GhostInner, props)
    }

    /* ── 注册 ────────────────────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'next-step-ghost', order: 50 },
            NextStepGhost,
          ),
        )
      },
    }
  },
})
