/**
 * Host 半边：为「状态卡片」提供**整会话的变更文件汇总**与**已提交计划的索引**。
 *
 * 为什么需要宿主：每轮的文件清单只存在于宿主内存里（`ctx.workspaceChanges.summary(sessionId, seq)`，
 * git 校验、含 added/deleted），客户端 SessionFace 看不到原始事件流，官方也只通过
 * `/api/changes.summary` 暴露「单轮」视图。卡片要的是「本次会话累计去重」的视图，
 * 所以这里自己找 seq 并合并，再开一条认证路由给客户端读。
 *
 * seq 从**会话日志**里现读（`ctx.sessions.get(id).snapshotEvents()`），不再靠 `session/event` 监听累积。
 * 理由：真机上监听拿不到事件时整块变更静默为空（内存表空 → 卡片无数据），而这种失败没有任何
 * 可见信号；日志是权威来源，按需扫描还顺带免疫 HMR 重载与监听时序。代价是每次请求扫一遍日志，
 * 因此按「会话对象 + 日志长度」缓存上一次的扫描结果。
 *
 * 计划同理但更简单：plan 模式不落盘任何文件，计划正文只存在于 `exit_plan_mode` 工具调用参数里
 * （`plan` 投影只有 `{active, pending}`）。客户端要「点开侧栏预览」必须先知道 `callId`，
 * 于是这里顺手把每次提交记成 `{callId, title, seq}`，随同一条路由下发，避免客户端翻整段历史。
 *
 * 只读、无副作用：不改官方投影、不改事件、不写任何会话状态；插件卸载时路由一起回收。
 *
 * @author liuh
 */

/** 卡片客户端读取变更汇总的认证路由（同源 cookie，与官方 /api/changes.* 同规格）。 */
export const CHANGES_ROUTE = '/api/status-card.changes';

/** 计划提交事件的形态（与官方 ui-plan 的识别规则一致）。 */
const PLAN_EVENT_TYPES = new Set(['tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch']);
/** 计划正文来自 plan 模式退出工具的参数，plan 模式本身不落盘任何文件。 */
const PLAN_TOOL = 'exit_plan_mode';

/**
 * 会停下来等人类回答的工具：`ask_user_question` 从 `tool/call` 到 `tool/result`
 * 之间全是人在思考与点选，这段算「等你」而不是工具执行时间。
 */
const QUESTION_TOOL = 'ask_user_question';
/** 每个会话最多保留的计划条数（只留最近的，卡片也只展示最近的几条）。 */
const PLAN_LIMIT = 20;

/**
 * 依赖声明必须是**数组**形式。
 *
 * cordis 的「对象形式」不是 required/optional 语义，而是「服务名 → 拦截配置」映射
 * （见 @deepseek-ai/cordis 的 `Inject.resolve`：对非数组对象直接 `Object.keys()` 展开）。
 * 写成 `{ required: [...], optional: [...] }` 会被解析成两个并不存在的服务名，
 * fiber 永远停在 PENDING —— apply 不执行、不抛错、不打日志，路由静默缺失，
 * 客户端只看得到「变更数据不可用」。官方 Host 插件的 inject 也清一色是数组。
 *
 * 这些都是 web profile 的活服务：connection（认证路由通道）、workspaceChanges（变更记录）、
 * sessions（会话日志，用来找 seq）、shell（sandboxMode）。
 */
export const inject = ['connection', 'workspaceChanges', 'sessions', 'shell'];

/**
 * 合并一个会话的全部已记录轮次，产出卡片需要的整会话视图。
 *
 * - 按路径去重：同一文件跨多轮改动只保留**最后一次**改动的行数与来源坐标
 *   （与点击该行后打开的「变更审查」那一轮完全一致）。
 * - 排序：最近改动的轮次在前，同一轮内沿用官方 summary 的文件顺序。
 *
 * @param ctx - 插件上下文（只读 workspaceChanges / shell）。
 * @param seqs - 该会话按时间升序的 `workspace/changes` 事件 seq。
 * @param sessionId - 目标会话。
 * @returns 卡片直接可渲染的 JSON 值。
 */
export function collectChanges(ctx, seqs, sessionId) {
  const merged = new Map();
  let last = null;
  for (const seq of seqs) {
    const summary = ctx.workspaceChanges?.summary(sessionId, seq);
    if (summary === undefined || summary === null) continue;
    last = { seq, turn: summary.turn };
    summary.files.forEach((file, index) => {
      merged.set(file.path, { ...file, seq, index, turn: summary.turn });
    });
  }
  const files = [...merged.values()].sort((a, b) => b.seq - a.seq || a.index - b.index);
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += file.added;
    deleted += file.deleted;
  }
  return {
    sandboxMode: ctx.shell?.sandboxMode ?? null,
    files,
    total: files.length,
    added,
    deleted,
    turns: seqs.length,
    lastSeq: last === null ? null : last.seq,
    lastTurn: last === null ? null : last.turn,
  };
}

/**
 * 计划正文 → 标题：取首个 ATX 标题（任意层级），没有标题就退回首个非空行。
 *
 * @param markdown - `exit_plan_mode` 的 plan 参数。
 * @returns 单行标题；正文为空时返回空串。
 */
export function planTitle(markdown) {
  if (typeof markdown !== 'string') return '';
  const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/mu.exec(markdown);
  if (heading !== null) return heading[1].trim();
  for (const line of markdown.split(/\r?\n/u)) {
    const text = line.trim();
    if (text !== '') return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  }
  return '';
}

/**
 * 从一条会话事件里认出「计划被提交」，并抽出卡片需要的最小信息。
 *
 * plan 模式不产生文件，计划正文只存在于 `exit_plan_mode` 的工具调用参数里；
 * 客户端要预览必须拿到 `callId`（拼 `dsh-resource://plan/session/<sid>/<callId>`）。
 *
 * @param event - 会话事件。
 * @returns `{ callId, title, seq }`；不是计划提交时返回 null。
 */
export function planRecord(event) {
  if (event === null || event === undefined || !PLAN_EVENT_TYPES.has(event.type)) return null;
  const data = event.data;
  if (data === null || data === undefined || data.name !== PLAN_TOOL) return null;
  const callId = data.callId ?? data.subCallId;
  if (typeof callId !== 'string' || callId === '') return null;
  let args = data.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  const markdown = args?.plan;
  if (typeof markdown !== 'string' || markdown.trim() === '') return null;
  return { callId, title: planTitle(markdown), seq: event.seq };
}

/**
 * 本轮耗时统计的初始状态（含内部记账字段，出站前由 `exportTiming` 裁掉）。
 */
export function emptyTiming() {
  return {
    turn: null,
    modelMs: 0,
    toolMs: 0,
    // 已结算的等待区间（升序、重叠已合并）。存区间而不是只存总长，是为了把审批窗口
    // 从「工具耗时」里扣掉——否则同一段时间既算工具又算等你。
    waits: [],
    openStepStart: null,
    pendingCalls: {},
    openWaits: {},
  };
}

/** 把区间并入已合并的等待表（重叠或相邻即合并），保证同一段时间不会记两遍。 */
function addWait(waits, from, to) {
  if (!(to > from)) return waits;
  const next = [];
  let merged = { from, to };
  let placed = false;
  for (const span of waits) {
    if (span.to < merged.from) {
      next.push(span);
      continue;
    }
    if (span.from > merged.to) {
      if (!placed) {
        next.push(merged);
        placed = true;
      }
      next.push(span);
      continue;
    }
    merged = { from: Math.min(span.from, merged.from), to: Math.max(span.to, merged.to) };
  }
  if (!placed) next.push(merged);
  return next;
}

/** 等待区间在 `[from,to]` 内覆盖的总时长（工具耗时去重用）。 */
function waitWithin(waits, from, to) {
  let total = 0;
  for (const span of waits) {
    const start = Math.max(span.from, from);
    const end = Math.min(span.to, to);
    if (end > start) total += end - start;
  }
  return total;
}

/** 等待区间总长（区间已合并，直接相加即不重叠）。 */
function waitTotal(waits) {
  let total = 0;
  for (const span of waits) total += Math.max(0, span.to - span.from);
  return total;
}

/**
 * 把一条会话事件折叠进「本轮耗时」。
 *
 * 口径与官方 `sessionStats` 投影一致：模型时间 = `step/start` → `assistant/message`，
 * 工具时间 = `tool/call` → `tool/result`（按 callId 配对）。事件自带 `time`（epoch ms），
 * 所以统计能直接从历史日志复原，不需要进程内监听。
 *
 * 「等你」是三段之和，且三者互不重叠（同一段时间只记一次）：
 * ① 问人类 / 让人批准计划的工具（`ask_user_question`、`exit_plan_mode`）从调用到返回；
 * ② 工具执行期间弹出的审批（`approval/asked` → `decided`，同时从工具耗时里扣掉）；
 * ③ 这一轮交给用户之后（`turn/end` 到下一轮 `turn/start`），由客户端往后顺延计时。
 *
 * @param state - `emptyTiming()` 起的累计状态。
 * @param event - 会话事件。
 * @returns 新的累计状态。
 */
export function foldTiming(state, event) {
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null;
  if (time === null) return state;
  switch (event.type) {
    case 'turn/start':
      return {
        ...emptyTiming(),
        turn: typeof event.data?.turn === 'number' ? event.data.turn : null,
      };
    case 'step/start':
      if (state.openStepStart !== null) return state;
      return { ...state, openStepStart: time };
    case 'assistant/message': {
      if (state.openStepStart === null) return state;
      return { ...state, modelMs: state.modelMs + Math.max(0, time - state.openStepStart), openStepStart: null };
    }
    case 'tool/call': {
      const callId = event.data?.callId ?? event.data?.subCallId;
      if (typeof callId !== 'string' || callId === '') return state;
      // 问人类 / 让人类批准计划的工具：从 call 到 result 之间全是人在思考与点选，
      // 这段既不是模型时间也不是工具执行时间，单记「等你」。
      const name = event.data?.name;
      if (name === QUESTION_TOOL || name === PLAN_TOOL) {
        return { ...state, openWaits: { ...state.openWaits, [`q:${callId}`]: time } };
      }
      return { ...state, pendingCalls: { ...state.pendingCalls, [callId]: time } };
    }
    case 'tool/result': {
      const callId = event.data?.toolCallId ?? event.data?.message?.source?.callId;
      if (typeof callId !== 'string' || callId === '') return state;
      let next = state;
      const start = next.pendingCalls[callId];
      if (typeof start === 'number') {
        const pendingCalls = { ...next.pendingCalls };
        delete pendingCalls[callId];
        // 工具执行期间可能弹出审批（plugin_manager / 命令提权等）：那段人已经算进「等你」，
        // 这里从工具耗时里扣掉，避免同一段时间记两遍（真机 3 小时审批实测到过）。
        let waited = waitWithin(next.waits, start, time);
        for (const since of Object.values(next.openWaits)) {
          if (typeof since === 'number' && time > since) waited += time - Math.max(since, start);
        }
        next = { ...next, toolMs: next.toolMs + Math.max(0, time - start - waited), pendingCalls };
      }
      const waited = closeWait(next, `q:${callId}`, time);
      return waited ?? next;
    }
    // 审批：asked → decided 之间是人在点「允许/拒绝」，同样只算「等你」。
    case 'approval/asked': {
      const id = event.data?.id;
      if (typeof id !== 'string' || id === '') return state;
      return { ...state, openWaits: { ...state.openWaits, [`a:${id}`]: time } };
    }
    case 'approval/decided': {
      const id = event.data?.id;
      if (typeof id !== 'string' || id === '') return state;
      return closeWait(state, `a:${id}`, time) ?? state;
    }
    case 'turn/end': {
      // 收尾：还在等人决策的那段算到这一瞬；未闭合的工具调用直接丢弃（不当作工具耗时）。
      let waits = state.waits;
      for (const since of Object.values(state.openWaits)) {
        if (typeof since === 'number') waits = addWait(waits, since, time);
      }
      return {
        ...state,
        waits,
        openWaits: {},
        openStepStart: null,
        pendingCalls: {},
      };
    }
    default:
      return state;
  }
}

/** 关闭一个等待区间：有起点就并进等待表，否则返回 null 表示状态没变。 */
function closeWait(state, key, time) {
  const since = state.openWaits[key];
  if (typeof since !== 'number') return null;
  const openWaits = { ...state.openWaits };
  delete openWaits[key];
  return { ...state, waits: addWait(state.waits, since, time), openWaits };
}

export function exportTiming(state) {
  const opens = Object.values(state.openWaits);
  return {
    turn: state.turn,
    modelMs: state.modelMs,
    toolMs: state.toolMs,
    waitMs: waitTotal(state.waits),
    // 正在等人的那一刻：客户端拿它算「等你」的增量（每秒重渲染，不再发请求）。
    // 轮次结束（`turn/end`）后就没有未结算的等待了，数字随这一轮定格——「等你」只算
    // 人真正卡住 agent 的时间（提问 / 计划批准 / 审批），不算轮次之间的空闲。
    waitSince: opens.length === 0 ? null : Math.min(...opens),
  };
}

/**
 * 扫描一段会话日志，抽出卡片需要的三类坐标。
 *
 * @param events - 会话事件（升序）。
 * @param previous - 上一批扫描结果，用于增量累加（同一文件不必重算）。
 * @returns `{ seqs, plans, timing, subagentTurns }`；`seqs` 升序去重，`plans` 按 callId 去重且只留最近
 *   PLAN_LIMIT 条，`subagentTurns` 是「子会话 → 它被派生的轮次」（卡片按轮次折叠用）。
 */
export function scanLog(events, previous) {
  const seqs = previous === undefined ? [] : [...previous.seqs];
  const plans = previous === undefined ? [] : [...previous.plans];
  const subagentTurns = previous?.subagentTurns === undefined ? {} : { ...previous.subagentTurns };
  let timing = previous === undefined || previous.timing === undefined ? emptyTiming() : previous.timing;
  for (const event of events) {
    timing = foldTiming(timing, event);
    // 子目录事件只带子会话 id（label / 模式在子会话自己的投影里）：记下它属于哪一轮，
    // 客户端据此把「整段历史的子智能体」按轮次分组。
    if (event.type === 'subagent/catalog') {
      const childId = event.data?.childId;
      if (typeof childId === 'string' && childId !== '') {
        subagentTurns[childId] = typeof timing.turn === 'number' ? timing.turn : null;
      }
      continue;
    }
    if (event.type === 'workspace/changes') {
      if (seqs[seqs.length - 1] !== event.seq) seqs.push(event.seq);
      continue;
    }
    // PTC 会先发 dispatch-start、再发 dispatch：同一个 callId 只留最后一条。
    const record = planRecord(event);
    if (record === null) continue;
    const index = plans.findIndex((item) => item.callId === record.callId);
    if (index < 0) plans.push(record);
    else plans[index] = record;
  }
  if (plans.length > PLAN_LIMIT) plans.splice(0, plans.length - PLAN_LIMIT);
  return { seqs, plans, timing, subagentTurns };
}

/**
 * 取某个会话的扫描结果（按「会话对象 + 已扫长度」缓存，日志只追加所以可以增量续扫）。
 *
 * @param ctx - 插件上下文（只读 sessions）。
 * @param cache - sessionId → `{ session, length, seqs, plans }`。
 * @param sessionId - 目标会话。
 * @returns `{ seqs, plans }`；会话不在本宿主内存里时返回空结果。
 */
export function sessionIndex(ctx, cache, sessionId) {
  const session = ctx.sessions?.get(sessionId);
  if (session === undefined || typeof session?.snapshotEvents !== 'function') {
    return { seqs: [], plans: [], timing: emptyTiming(), subagentTurns: {} };
  }
  const cached = cache.get(sessionId);
  if (cached !== undefined && cached.session === session) {
    const fresh = session.snapshotEvents(cached.length);
    if (fresh.length === 0) return cached;
    const next = { session, length: cached.length + fresh.length, ...scanLog(fresh, cached) };
    cache.set(sessionId, next);
    return next;
  }
  const events = session.snapshotEvents();
  const next = { session, length: events.length, ...scanLog(events) };
  cache.set(sessionId, next);
  return next;
}

/**
 * 处理一次路由请求：只认 `GET ?sessionId=<id>`，其余一律 400；没有记录时返回空结果（200）。
 *
 * @param ctx - 插件上下文。
 * @param cache - sessionId → 扫描结果缓存。
 * @param request - 认证路由收到的请求。
 * @returns 认证路由的响应。
 */
export function handleChangesRequest(ctx, cache, request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (sessionId === null || sessionId === '') {
    return new Response('Invalid change coordinates.', { status: 400 });
  }
  const index = sessionIndex(ctx, cache, sessionId);
  return Response.json({
    ...collectChanges(ctx, index.seqs, sessionId),
    plans: index.plans,
    timing: exportTiming(index.timing),
    // 子会话 → 派生它的轮次（卡片按轮次分组、折叠早前轮次）。
    subagentTurns: index.subagentTurns ?? {},
  }, {
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件的上下文，卸载时会连带回收其登记的资源
 */
export function apply(ctx) {
  /** sessionId -> 该会话日志的扫描结果。 */
  const cache = new Map();

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: CHANGES_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => Promise.resolve(handleChangesRequest(ctx, cache, request)),
    }),
    'status-card: changes route',
  );

  ctx.effect(() => () => cache.clear(), 'status-card: scan cache');
}
