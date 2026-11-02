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

/** 本轮计时的可重放状态；三个区间表都保持升序、合并、不重叠。 */
export function emptyTiming() {
  return {
    turn: null,
    startedAt: null,
    endedAt: null,
    lastTime: null,
    lastSeq: null,
    modelMs: 0,
    toolMs: 0,
    models: [],
    tools: [],
    waits: [],
    openStepStart: null,
    pendingCalls: {},
    openWaits: {},
    seenCalls: {},
    seenApprovals: {},
  };
}

/** 并入一个区间，包含相邻区间，避免并行执行或重复事件重复计时。 */
function addSpan(spans, from, to) {
  if (!(to > from)) return spans;
  const next = [];
  let merged = { from, to };
  let placed = false;
  for (const span of spans) {
    if (span.to < merged.from) {
      next.push(span);
    } else if (span.from > merged.to) {
      if (!placed) next.push(merged);
      placed = true;
      next.push(span);
    } else {
      merged = { from: Math.min(span.from, merged.from), to: Math.max(span.to, merged.to) };
    }
  }
  if (!placed) next.push(merged);
  return next;
}

/** 两个已合并区间表的交集长度，线性扫描即可。 */
function overlapTotal(left, right) {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i];
    const b = right[j];
    total += Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
    if (a.to < b.to) i += 1;
    else j += 1;
  }
  return total;
}

function spanTotal(spans) {
  return spans.reduce((total, span) => total + span.to - span.from, 0);
}

/** 将尚未闭合的区间临时采样；不修改日志折叠状态。 */
function sampledSpans(closed, starts, until) {
  let spans = closed;
  for (const from of starts) {
    if (typeof from === 'number') spans = addSpan(spans, from, until);
  }
  return spans;
}

/** 关闭一条等待记录；重复 decided/result 没有起点时不做任何结算。 */
function closeWait(state, key, time) {
  if (!Object.hasOwn(state.openWaits, key)) return state;
  const openWaits = { ...state.openWaits };
  const from = openWaits[key];
  delete openWaits[key];
  return { ...state, waits: addSpan(state.waits, from, time), openWaits };
}

/**
 * 从现有事件恢复模型、工具、等待区间。重叠时按 wait > tool > model 排他归属，
 * 因此并行工具、审批与提问的重叠都只计算一次。step/start 在模型流式输出前已经存在，
 * exportTiming 可据此实时采样；turn/end 会结算所有未返回调用并冻结这一轮。
 */
export function foldTiming(state, event) {
  if (event === null || event === undefined || !Number.isFinite(event.time)) return state;
  const seq = Number.isInteger(event.seq) ? event.seq : null;
  if (seq !== null && state.lastSeq !== null && seq <= state.lastSeq) return state;
  const time = Math.max(event.time, state.lastTime ?? event.time);
  const turn = Number.isFinite(event.data?.turn) ? event.data.turn : null;
  if (event.type === 'turn/start') {
    // 重放同一轮的 start 不应清掉已经折叠的调用和区间。
    if (state.startedAt !== null && turn !== null && turn === state.turn) return state;
    return { ...emptyTiming(), turn, startedAt: time, lastTime: time, lastSeq: seq ?? state.lastSeq };
  }
  if (state.endedAt !== null) return state;
  let next = { ...state, lastTime: time, lastSeq: seq ?? state.lastSeq };
  // 旧轮次的迟到结果不能结束当前轮次中恰好同名的调用。
  if (turn !== null && state.turn !== null && turn !== state.turn) return next;
  switch (event.type) {
    case 'step/start':
      if (state.openStepStart === null) {
        next = { ...next, startedAt: state.startedAt ?? time, openStepStart: time };
      }
      break;
    case 'assistant/message':
    case 'step/end':
      if (state.openStepStart !== null) {
        next = { ...next, models: addSpan(state.models, state.openStepStart, time), openStepStart: null };
      }
      break;
    case 'tool/call': {
      const callId = event.data?.callId ?? event.data?.subCallId;
      if (typeof callId !== 'string' || callId === '' || Object.hasOwn(state.seenCalls, callId)) break;
      next = { ...next, startedAt: state.startedAt ?? time, seenCalls: { ...state.seenCalls, [callId]: true } };
      const name = event.data?.name;
      if (name === QUESTION_TOOL || name === PLAN_TOOL) {
        next = { ...next, openWaits: { ...state.openWaits, [`q:${callId}`]: time } };
      } else {
        next = { ...next, pendingCalls: { ...state.pendingCalls, [callId]: time } };
      }
      break;
    }
    case 'tool/result': {
      const callId = event.data?.toolCallId ?? event.data?.message?.toolCallId ?? event.data?.message?.source?.callId;
      if (typeof callId !== 'string' || callId === '') break;
      if (Object.hasOwn(state.pendingCalls, callId)) {
        const pendingCalls = { ...state.pendingCalls };
        const from = pendingCalls[callId];
        delete pendingCalls[callId];
        next = { ...next, tools: addSpan(state.tools, from, time), pendingCalls };
      }
      next = closeWait(next, `q:${callId}`, time);
      break;
    }
    case 'approval/asked': {
      const id = event.data?.id;
      if (typeof id !== 'string' || id === '' || Object.hasOwn(state.seenApprovals, id)) break;
      next = {
        ...next,
        startedAt: state.startedAt ?? time,
        seenApprovals: { ...state.seenApprovals, [id]: true },
        openWaits: { ...state.openWaits, [`a:${id}`]: time },
      };
      break;
    }
    case 'approval/decided': {
      const id = event.data?.id;
      if (typeof id === 'string' && id !== '') next = closeWait(next, `a:${id}`, time);
      break;
    }
    case 'turn/end':
      next = {
        ...next,
        models: sampledSpans(state.models, [state.openStepStart], time),
        tools: sampledSpans(state.tools, Object.values(state.pendingCalls), time),
        waits: sampledSpans(state.waits, Object.values(state.openWaits), time),
        endedAt: time,
        openStepStart: null,
        pendingCalls: {},
        openWaits: {},
      };
      break;
    default:
      break;
  }
  // 保留既有纯函数调用者读取的内部累计字段，口径与导出一致。
  const totals = exportTiming(next);
  return { ...next, modelMs: totals.modelMs, toolMs: totals.toolMs };
}

/**
 * 采样包含尚未闭合的执行时间。默认用最后事件时刻，方便日志回放/纯函数测试；
 * HTTP 路由显式传 Date.now()，客户端只对 active 指向的一段追加 now - sampledAt。
 * waitSince 保留供旧调用者识别开放等待，新客户端不得再重复叠加它。
 */
export function exportTiming(state, now = state.lastTime ?? 0) {
  const sampledAt = state.endedAt ?? Math.max(state.lastTime ?? 0, Number.isFinite(now) ? now : 0);
  const waiting = Object.values(state.openWaits);
  const tools = sampledSpans(state.tools, Object.values(state.pendingCalls), sampledAt);
  const waits = sampledSpans(state.waits, waiting, sampledAt);
  const models = sampledSpans(state.models, [state.openStepStart], sampledAt);
  let excludedFromModel = tools;
  for (const span of waits) excludedFromModel = addSpan(excludedFromModel, span.from, span.to);
  const active = state.endedAt !== null ? null
    : waiting.length > 0 ? 'wait'
    : Object.keys(state.pendingCalls).length > 0 ? 'tool'
    : state.openStepStart !== null ? 'model' : null;
  return {
    turn: state.turn,
    modelMs: spanTotal(models) - overlapTotal(models, excludedFromModel),
    toolMs: spanTotal(tools) - overlapTotal(tools, waits),
    waitMs: spanTotal(waits),
    waitSince: waiting.length === 0 ? null : Math.min(...waiting),
    sampledAt,
    active,
  };
}

/** 官方 todo/write 是整表替换；保留最小只读字段，不持有事件对象。 */
function todoSnapshot(event) {
  const todos = event.data?.todos;
  if (!Array.isArray(todos)) return null;
  const valid = todos.every((item) => item !== null && typeof item === 'object'
    && typeof item.content === 'string' && item.content.trim() !== ''
    && ['pending', 'in_progress', 'completed'].includes(item.status));
  return valid ? todos.map(({ content, status }) => ({ content, status })) : null;
}

/**
 * 扫描现有日志，恢复变更坐标、计划、计时、子会话轮次以及最近历史任务。
 * 当前轮任务继续使用官方 todos 投影；previousTodos 只在新轮开始时接收上一轮最后快照。
 * 无写入轮保留更早的历史及真实轮次；显式 [] 则清空并遮蔽旧历史，防止列表复活。
 */
export function scanLog(events, previous) {
  const seqs = previous === undefined ? [] : [...previous.seqs];
  const plans = previous === undefined ? [] : [...previous.plans];
  const subagentTurns = previous?.subagentTurns === undefined ? {} : { ...previous.subagentTurns };
  let timing = previous?.timing ?? emptyTiming();
  let todoTurn = previous?.todoTurn ?? null;
  let currentTodos = previous?.currentTodos ?? null;
  let previousTodos = previous?.previousTodos ?? null;
  let lastEventSeq = previous?.lastEventSeq ?? null;
  for (const event of events) {
    const eventSeq = Number.isInteger(event.seq) ? event.seq : null;
    if (eventSeq !== null && lastEventSeq !== null && eventSeq <= lastEventSeq) continue;
    if (eventSeq !== null) lastEventSeq = eventSeq;
    timing = foldTiming(timing, event);
    if (event.type === 'turn/start') {
      const turn = Number.isFinite(event.data?.turn) ? event.data.turn : null;
      if (turn === null || turn !== todoTurn) {
        if (todoTurn !== null && currentTodos !== null) {
          previousTodos = currentTodos.length === 0 ? null : { turn: todoTurn, todos: currentTodos };
        }
        todoTurn = turn;
        currentTodos = null;
      }
    } else if (event.type === 'todo/write') {
      const todos = todoSnapshot(event);
      if (todos !== null) {
        currentTodos = todos;
        if (todos.length === 0) previousTodos = null;
      }
    }
    // 子目录事件只带子会话 id（label / 模式在子会话自己的投影里）：记下它属于哪一轮。
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
  return { seqs, plans, timing, subagentTurns, todoTurn, currentTodos, previousTodos, lastEventSeq };
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
    timing: exportTiming(index.timing, Date.now()),
    previousTodos: index.previousTodos ?? null,
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
