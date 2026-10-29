/**
 * 冒烟测试：dsh-status-card/client.js
 *
 * 只读目标源文件，不写任何文件。用 node:vm 在当前全局上下文里求值该文件（它是纯脚本，
 * 顶层唯一动作是 window.__ModuleLoader__.load({...})），拿到 factory 后用最小 React 替身
 * 取出插件对象；再用 fake ctx 调 apply()，截获 slots.register 的组件，直接调用组件函数
 * 并用一棵「展开函数组件」的迷你渲染管线检查产出的元素树。
 *
 * @author liuh
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as host from '../index.js';

// 默认读同目录上一级的真实文件；SC_TARGET 仅在变异测试里指向临时副本。
// SC_ONLY=F21,F22 只跑这几条用例（变异测试用来把每条变异缩到最小重跑集）；不设则全量。
const TARGET = process.env.SC_TARGET ?? fileURLToPath(new URL('../client.js', import.meta.url));
/** Host 半边：只做静态契约检查（形状类缺陷正是从这类盲区漏过去的，见 H1）。 */
const HOST = fileURLToPath(new URL('../index.js', import.meta.url));
const SRC = readFileSync(TARGET, 'utf8');
const NS = 'status-card';
const MAIN = 'sess-main';
/** 与源码一致的闸门常量与接管标记（写成字面量，避免从源码里反抄导致断言恒真）。 */
const HIDE_BELOW_CONTENT_WIDTH = 820;
const HIDE_TODO_ATTR = 'data-status-card-hide-todo';

/* ------------------------------------------------------------------ 迷你 React */

const hooks = {
  states: [],
  index: 0,
  dirty: false,
  /**
   * 待执行的 effect 队列。模仿 React 的提交阶段：整棵树渲染完成（元素的 ref 已挂上）之后
   * 才跑 effect——useAnchor 的首测正是在 effect 里读 anchorRef.current，若在渲染中途就跑，
   * ref 还是 null，测量链永远量不到宽度。
   */
  pending: [],
  /** 按 hook 槽位登记的 ref 对象，供测试注入可控的 ref.current。 */
  refs: {},
  /** 渲染到带 ref 的元素时回调这里，等价于 React 提交阶段挂 ref。 */
  attachRef: null,
};

const ReactFake = {
  createElement(type, props, ...children) {
    const base = props === null || props === undefined ? {} : props;
    const ref = base.ref;
    if (ref !== null && typeof ref === 'object' && typeof hooks.attachRef === 'function') hooks.attachRef(ref);
    return { type, key: base.key ?? null, props: { ...base, children } };
  },
  useState(init) {
    const i = hooks.index++;
    if (!(i in hooks.states)) hooks.states[i] = typeof init === 'function' ? init() : init;
    const set = (next) => {
      hooks.states[i] = typeof next === 'function' ? next(hooks.states[i]) : next;
      hooks.dirty = true;
    };
    return [hooks.states[i], set];
  },
  useRef(init) {
    const i = hooks.index++;
    if (!(i in hooks.states)) hooks.states[i] = { current: init };
    hooks.refs[i] = hooks.states[i];
    return hooks.states[i];
  },
  // 刻意不提供 useLayoutEffect：被测源码用 `React.useLayoutEffect ?? React.useEffect` 退化，
  // 这条退化路径本身就是用例 X6 的断言对象。
  useEffect(effect, deps) {
    const i = hooks.index++;
    const prev = hooks.states[i];
    const changed = prev === undefined
      || !Array.isArray(prev.deps)
      || !Array.isArray(deps)
      || prev.deps.length !== deps.length
      || deps.some((dep, j) => !Object.is(dep, prev.deps[j]));
    if (!changed) return;
    hooks.states[i] = { deps: Array.isArray(deps) ? [...deps] : null, cleanup: prev?.cleanup };
    hooks.pending.push({ i, effect, cleanup: prev?.cleanup });
  },
};

/** 跑完本轮排队的 effect：先执行上一次的 cleanup，再执行新 effect，并记下新 cleanup。 */
function flushEffects() {
  const queue = hooks.pending;
  hooks.pending = [];
  for (const item of queue) {
    if (typeof item.cleanup === 'function') {
      try { item.cleanup(); } catch { /* 忽略清理异常 */ }
    }
    const cleanup = item.effect();
    const slot = hooks.states[item.i];
    if (slot !== undefined && slot !== null && typeof slot === 'object') slot.cleanup = cleanup;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 假计时器池：`loadPlugin` 装好 setInterval/clearInterval 后登记在这里。 */
const timers = new Map();
let timerId = 0;

/** 手动推进一轮假计时器（模拟「过了 N 毫秒」），返回触发个数。 */
function fireTimers() {
  const pending = [...timers.values()];
  for (const fn of pending) {
    if (![...timers.values()].includes(fn)) continue;
    fn();
  }
  return pending.length;
}

/* ------------------------------------------------------------------ 加载模块 */

function makeDocument(styles, contentEls = []) {
  const makeEl = (tagName) => ({
    tagName,
    attrs: {},
    textContent: '',
    isConnected: false,
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    remove() {
      this.isConnected = false;
      const at = styles.indexOf(this);
      if (at >= 0) styles.splice(at, 1);
    },
  });
  return {
    head: { appendChild(el) { el.isConnected = true; styles.push(el); } },
    body: {},
    createElement: (tagName) => makeEl(tagName),
    // 被测源码只用这一个选择器取主内容区；其余选择器一律返回空，避免误命中。
    querySelectorAll: (selector) => (selector === '[data-conversation-content]' ? contentEls : []),
  };
}

/** 可控的主内容区元素：宽度/高度由测试变量驱动，带真实的属性读写。 */
function controlledContent({ width = 1200, height = 600, sessionId = MAIN, top = 60, right = 900, chatWidth } = {}) {
  const box = { width, height, top, right };
  return {
    box,
    attrs: sessionId === undefined ? {} : { 'data-conversation-session': sessionId },
    isConnected: true,
    // 宿主把正文列宽度写在自定义属性上（真机是 clamp()，测试里给像素串走快路径）。
    customProps: chatWidth === undefined ? {} : { '--dsh-chat-content-width': `${chatWidth}px` },
    // 推让是往 style 上写 padding-right，夹具留一个可断言的 style 对象。
    style: { paddingRight: '' },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    getBoundingClientRect() {
      return {
        top: box.top,
        right: box.right,
        width: box.width,
        height: box.height,
        bottom: box.top + box.height,
        left: box.right - box.width,
      };
    },
    setWidth(value) { box.width = value; },
    setHeight(value) { box.height = value; },
  };
}

/** 锚点元素替身：offsetParent 是浮层，可给出任意矩形。 */
function makeAnchorStub(layerRect) {
  return {
    offsetParent: { getBoundingClientRect: () => ({ ...layerRect }) },
    getBoundingClientRect: () => ({ ...layerRect }),
  };
}

/** 重新求值一次模块文件，得到全新的闭包状态（模块里有 collapsedMemory 这类模块级记忆）。 */
function loadPlugin(resizeListeners = []) {
  let captured = null;
  // 正文列宽度解析靠 getComputedStyle 读自定义属性：真机读 clamp()，这里给像素串。
  globalThis.getComputedStyle = (element) => ({
    getPropertyValue(name) {
      return element?.customProps?.[name] ?? '';
    },
  });
  globalThis.window = {
    __ModuleLoader__: { load(manifest) { captured = manifest; } },
    // 记下 resize 监听器：测试据此手动触发 measure()，这是驱动空间闸门的关键路径。
    addEventListener(type, fn) {
      if (type !== 'resize') return;
      if (!resizeListeners.includes(fn)) resizeListeners.push(fn);
    },
    removeEventListener(type, fn) {
      if (type !== 'resize') return;
      const at = resizeListeners.indexOf(fn);
      if (at >= 0) resizeListeners.splice(at, 1);
    },
  };
  // client.js 用 setInterval 做「运行中轮询 / 等待计时」。测试里换成手动推进的假计时器：
  // 真实定时器既会把事件循环挂住，也会在两次断言之间偷偷改状态。
  globalThis.setInterval = (fn) => {
    const id = ++timerId;
    timers.set(id, fn);
    return id;
  };
  globalThis.clearInterval = (id) => {
    timers.delete(id);
  };
  vm.runInThisContext(SRC, { filename: TARGET });
  if (captured === null) throw new Error('window.__ModuleLoader__.load 没有被调用');
  const requiredIds = [];
  const plugin = captured.factory((id) => {
    requiredIds.push(id);
    if (id === 'react') return ReactFake;
    throw new Error(`非预期的 require('${id}')：本插件只应依赖 react`);
  });
  return { manifest: captured, plugin, requiredIds };
}

function makeT(dict) {
  return (key, params) => {
    const raw = dict?.[key];
    if (typeof raw !== 'string') return key;
    if (params === undefined) return raw;
    return raw.replace(/\{(\w+)\}/gu, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
  };
}

function setup({
  mainView = 1,
  fetchImpl,
  cwd = '/Users/me/work/status-card',
  contents = [],
  // 浮层坐标系下的锚点层矩形；contentRect 默认 top=60 / right=900。
  layer = { top: 40, right: 1000, bottom: 800, left: 0, width: 1000, height: 760 },
  // 目标操作 Remote 的返回：对象（每次同值）或 (call) => 对象；null 表示「目标服务缺席」。
  goalResult = { ok: true, value: null },
  // false 表示宿主没提供 sidebarRight（此时计划/变更都点不开，但卡片照常渲染）。
  withSidebarRight = true,
  // `sessions.subagentAddress` 的返回：undefined 表示主会话；给对象表示当前是子会话。
  subagentAddress = undefined,
  // 工作区导航服务：官方用它从子智能体行跳到子会话；null 模拟服务缺席。
  withUiWorkspace = true,
  // 后台任务行表：null 模拟「没装 job controller」（服务缺席）；给数组则挂上假服务。
  jobsRows = null,
  // `jobs.kill` 的返回对象：默认成功，给 {ok:false} 可验证失败提示。
  jobKillResult = { ok: true },
} = {}) {
  const styles = [];
  const fetchCalls = [];
  const contentEls = Array.isArray(contents) ? contents : [contents];
  globalThis.document = makeDocument(styles, contentEls);
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    return fetchImpl === undefined ? okResponse({ files: [] }) : fetchImpl(url, init);
  };

  const resizeListeners = [];
  const { manifest, plugin, requiredIds } = loadPlugin(resizeListeners);
  // 模拟 React 提交阶段把 ref 挂到元素上：useAnchor 的首测才能读到 offsetParent。
  const anchor = makeAnchorStub(layer);
  hooks.attachRef = (ref) => { ref.current = anchor; };
  const locales = [];
  const cleanups = [];
  const slots = [];
  const injections = [];
  const serviceInjections = [];
  const resources = [];
  const opens = [];
  const goalCalls = [];
  const resultOf = (call) => (typeof goalResult === 'function' ? goalResult(call) : goalResult);
  const goals = {
    edit(sessionId, ref, request) {
      const call = { kind: 'edit', sessionId, ref, request };
      goalCalls.push(call);
      return Promise.resolve(resultOf(call));
    },
    pause(sessionId, ref) {
      const call = { kind: 'pause', sessionId, ref };
      goalCalls.push(call);
      return Promise.resolve(resultOf(call));
    },
    resume(sessionId, ref) {
      const call = { kind: 'resume', sessionId, ref };
      goalCalls.push(call);
      return Promise.resolve(resultOf(call));
    },
    clear(sessionId, ref) {
      const call = { kind: 'clear', sessionId, ref };
      goalCalls.push(call);
      return Promise.resolve(resultOf(call));
    },
  };
  // 后台任务服务：`ctx.jobs`（官方 @deepseek-ai/dsh-api-job-controller 的客户端面）。
  // 行表是夹具给的固定数组；kill 记下发过的调用，供「两段确认」断言。
  const jobKills = [];
  const jobWatched = [];
  const jobListeners = new Set();
  const jobs = jobsRows === null || jobsRows === undefined ? undefined : {
    state: {
      getSnapshot: () => ({ rows: { [MAIN]: jobsRows }, observed: new Set() }),
      subscribe(listener) {
        jobListeners.add(listener);
        return () => jobListeners.delete(listener);
      },
    },
    watchRows(sessionId) {
      jobWatched.push(String(sessionId));
      return () => {};
    },
    observe() {},
    kill(sessionId, jobId) {
      jobKills.push({ sessionId: String(sessionId), jobId: String(jobId) });
      return Promise.resolve(jobKillResult);
    },
  };
  const ctx = {
    effect(fn) { const value = fn(); cleanups.push(value); return value; },
    locale: { register(ns, dicts) { locales.push({ ns, dicts }); return {}; } },
    slots: {
      inject(name, cb) { injections.push(name); return cb(); },
      register(options, Component) { slots.push({ options, Component }); return () => {}; },
    },
    // 可选服务：插件用 ctx.inject(deps, cb) 惰性获取，缺席时 apply 仍要能跑完。
    inject(deps, cb) {
      serviceInjections.push([...deps]);
      cb(ctx);
      return { dispose() {} };
    },
    // 会话服务：官方用它把「子会话」翻译成计划地址的五段形态。
    sessions: {
      subagentAddress(sessionId) {
        return typeof subagentAddress === 'function' ? subagentAddress(sessionId) : subagentAddress;
      },
    },
    // 工作区导航：官方 openSession(durable 子会话地址 | SessionId)。
    uiWorkspace: withUiWorkspace ? { openSession(target) { opens.push(target); } } : undefined,
    jobs,
    remote: goalResult === null ? {} : { goals },
    sidebarRight: withSidebarRight
      ? {
        openResource(...args) { resources.push({ kind: 'openResource', args }); },
        openResourceIn(...args) { resources.push({ kind: 'openResourceIn', args }); },
      }
      : undefined,
  };
  plugin.apply(ctx);

  const dicts = locales.find((item) => item.ns === NS)?.dicts;
  const card = slots[0]?.Component;
  if (typeof card !== 'function') throw new Error('slots.register 没有拿到卡片组件');

  return {
    manifest, plugin, requiredIds, ctx, card, locales, dicts, cleanups, slots, injections, resources, opens,
    serviceInjections, goals, goalCalls,
    jobs, jobKills, jobWatched, jobListeners,
    styles, fetchCalls, contentEls, anchor, resizeListeners,
    css: styles.map((tag) => tag.textContent).join(''),
    t: makeT(dicts?.zh),
    /** 触发窗口 resize：被测源码在 resize 监听器里重跑 measure()。 */
    fireResize() {
      for (const fn of [...resizeListeners]) fn();
      return resizeListeners.length;
    },
    resizeListenerCount: () => resizeListeners.length,
  };
}

/* ------------------------------------------------------------------ 渲染管线 */

function expand(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  const children = Array.isArray(node.props?.children) ? node.props.children.map(expand) : [];
  return { type: node.type, key: node.key, props: { ...node.props, children } };
}

async function pump(card, props) {
  let tree = null;
  for (let round = 0; round < 40; round += 1) {
    hooks.index = 0;
    hooks.dirty = false;
    tree = card(props);
    // 渲染完成后再跑 effect：此时元素的 ref 已挂上，useAnchor 的首测才读得到锚点层。
    flushEffects();
    await tick();
    if (!hooks.dirty) return tree;
  }
  return tree;
}

async function mount(card, props) {
  hooks.states = [];
  hooks.refs = {};
  hooks.pending = [];
  return pump(card, props);
}

function buildSessions({ projections = {}, cwd = '/Users/me/work/status-card', mainView = 1, subagents = [], sessionTitle } = {}) {
  const main = { id: MAIN, cwd, retainedBy: { mainView }, projectionValues: projections };
  // 宿主给的 durable 会话标题：顶栏副标题优先用它，没有才回退固定文案。
  if (typeof sessionTitle === 'string') main.title = sessionTitle;
  const byId = { [MAIN]: main };
  const ids = [MAIN];
  for (const sub of subagents) {
    byId[sub.id] = {
      id: sub.id,
      parentId: MAIN,
      displayTitle: sub.title,
      running: sub.running,
      // durable 标题（子智能体副行第一段）与投影值（身份 / token / 耗时）都是可选的。
      ...(typeof sub.sessionTitle === 'string' ? { title: sub.sessionTitle } : {}),
      ...(sub.projections === undefined ? {} : { projectionValues: sub.projections }),
    };
    ids.push(sub.id);
  }
  return {
    snapshot: { ids, byId },
    statuses: new Map(subagents.map((sub) => [sub.id, { running: sub.running }])),
  };
}

const okResponse = (value) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });
const badResponse = (status = 500) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(null) });

async function render(opts = {}) {
  const env = setup(opts);
  const { snapshot, statuses } = buildSessions(opts);
  // 面板状态：activePanelId === null 表示「正在看会话」，'plugins' / 'schedules' 等表示看全局面板。
  // panelState 传可变对象时可在两次渲染之间切换，用来验证「切走又切回」。
  const panelState = opts.panelState ?? { activePanelId: opts.activePanelId ?? null };
  const props = {
    useSessions: (selector) => selector(snapshot),
    useSessionStatus: (selector) => selector(statuses),
    // withoutPanelInfo：模拟宿主没提供 usePanelInfo 时的退化路径。
    ...(opts.withoutPanelInfo ? {} : { usePanelInfo: (selector) => selector(panelState) }),
    t: env.t,
  };
  const raw = await mount(env.card, props);
  return { env, props, raw, tree: expand(raw), snapshot, statuses, panelState };
}

/** 在指定内容区宽度下挂载（宽度由可控内容区元素驱动）。 */
async function renderAt(width, opts = {}) {
  const contentEl = controlledContent({ width, sessionId: MAIN });
  const result = await render({ ...opts, contents: [contentEl] });
  return { ...result, contentEl };
}

/** 改宽度 → 触发 resize 监听器 → 一直泵到不再 dirty → 返回展开后的新树。 */
async function resizeTo(ctx, width) {
  ctx.contentEl.setWidth(width);
  ctx.env.fireResize();
  return expand(await pump(ctx.env.card, ctx.props));
}

/** 同时给定内容区宽度与正文列宽度的夹具（推让模型需要两个数才成立）。 */
async function renderFit(width, chatWidth, opts = {}) {
  const contentEl = controlledContent({ width, sessionId: MAIN, chatWidth });
  const result = await render({ ...opts, contents: [contentEl] });
  return { ...result, contentEl };
}

/** 一起改内容区宽度与正文列宽度（真机上正文列宽度是内容区宽度的函数）。 */
async function setFit(ctx, width, chatWidth) {
  ctx.contentEl.setWidth(width);
  if (chatWidth !== undefined) {
    ctx.contentEl.customProps['--dsh-chat-content-width'] = chatWidth === null ? '' : `${chatWidth}px`;
  }
  ctx.env.fireResize();
  return expand(await pump(ctx.env.card, ctx.props));
}

/** 当前写在宿主内容区元素上的 padding-right（推让量 = 2 × push）。 */
const pushOf = (ctx) => String(ctx.contentEl.style?.paddingRight ?? '');
const fabNodes = (tree) => findAll(tree, (node) => hasClass(node, 'sc_fab'));

/* ------------------------------------------------------------------ 树工具 */

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
}

function findAll(tree, pred) {
  const out = [];
  walk(tree, (node) => { if (pred(node)) out.push(node); });
  return out;
}

const classOf = (node) => (typeof node?.props?.className === 'string' ? node.props.className.split(/\s+/u).filter(Boolean) : []);
const hasClass = (node, cls) => classOf(node).includes(cls);

function textOf(node) {
  let out = '';
  const rec = (value) => {
    if (value === null || value === undefined || value === false || value === true) return;
    if (typeof value === 'string' || typeof value === 'number') { out += String(value); return; }
    if (Array.isArray(value)) { for (const item of value) rec(item); return; }
    if (typeof value === 'object') rec(value.props?.children);
  };
  rec(node);
  return out;
}

function blockOf(tree, name) {
  const found = findAll(tree, (node) => node.props?.['data-sc-block'] === name);
  return found[0] ?? null;
}

/** 空间闸门相关的树查询。 */
const asideNodes = (tree) => findAll(tree, (node) => node.type === 'aside' && hasClass(node, 'sc_card'));
const anchorNodeOf = (tree) => findAll(tree, (node) => hasClass(node, 'sc_anchor'))[0] ?? null;
const cardVisibleOf = (tree) => anchorNodeOf(tree)?.props?.['data-card-visible'];
const anchorStateOf = (tree) => {
  const node = findAll(tree, (item) => hasClass(item, 'sc_anchor'))[0];
  return node?.props?.['data-state'];
};
const hiddenCardOf = (tree) => {
  const card = asideNodes(tree)[0];
  return card !== undefined && card.props?.['aria-hidden'] === 'true';
};
const hasHideMark = (el) => el !== null && el !== undefined
  && Object.prototype.hasOwnProperty.call(el.attrs, HIDE_TODO_ATTR)
  && el.getAttribute(HIDE_TODO_ATTR) !== null;

/* ------------------------------------------------------------------ CSS 工具 */

function cssRules(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/gu;
  let match = re.exec(css);
  while (match !== null) {
    rules.push({ selector: match[1].trim(), body: match[2].trim() });
    match = re.exec(css);
  }
  return rules;
}

function cssDecls(body) {
  const out = {};
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at <= 0) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/* ------------------------------------------------------------------ 夹具 */

const richProjections = () => ({
  todos: [
    { content: '通读 client.js', status: 'completed' },
    { content: '重写冒烟测试', status: 'in_progress' },
    { content: '跑通全部用例', status: 'pending' },
  ],
  goal: { goal: { objective: '为状态卡片重建冒烟测试并独立验证', phase: 'active' }, roundsStarted: 3 },
  agentTeam: {
    members: [
      { role: 'lead', phase: 'active' },
      { role: 'teammate', name: '阿甲', phase: 'active' },
      { role: 'teammate', name: '阿乙', phase: 'failed', error: '接线超时' },
    ],
    tasks: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }],
  },
  plan: { active: true },
  permissions: { currentValue: 'read-only' },
});

const richFetch = () => okResponse({
  files: [
    { path: '/w/dsh-status-card/client.js', display: 'dsh-status-card/client.js', added: 1200, deleted: 600, seq: 4, turn: 2, index: 0 },
    { path: '/w/dsh-status-card/README.md', display: 'dsh-status-card/README.md', added: 34, deleted: 51, seq: 4, turn: 2, index: 1 },
  ],
  added: 1234,
  deleted: 651,
  timing: { turn: 2, modelMs: 42000, toolMs: 18000, waitSince: null },
});

const richOpts = () => ({
  projections: richProjections(),
  fetchImpl: richFetch,
  cwd: '/Users/me/work/dsh-status-card',
  subagents: [
    { id: 'sub-a', title: '接线宿主', running: true },
    { id: 'sub-b', title: '回归检查', running: false },
  ],
});

/* ------------------------------------------------------------------ 断言 */

function expect(cond, detail) {
  if (!cond) throw new Error(detail);
}

// SC_ONLY：只跑指定前缀的用例（逗号分隔，如 `F21,F22`）。变异测试用它把每条变异跑成
// 「只跑期望失败的那几条」，把 103 条变异从「每条都全量跑一遍」压到秒级；不设时跑全部。
const ONLY = (process.env.SC_ONLY ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const caseIdOf = (name) => String(name).split(' ')[0];

const results = [];
async function runCase(name, fn) {
  if (ONLY.length > 0 && !ONLY.includes(caseIdOf(name))) {
    console.log(`SKIP ${name}`);
    return;
  }
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    const reason = error?.message ?? String(error);
    results.push({ name, ok: false, reason });
    console.log(`FAIL ${name} — ${reason}`);
  }
}

/* ------------------------------------------------------------------ 用例 */

// A. CSS
await runCase('A1 注入样式包含 .sc_card', async () => {
  const { env } = await render({});
  expect(env.css.includes('.sc_card'), `注入的 CSS 里没有 .sc_card（长度 ${env.css.length}）`);
});

await runCase('A2 .sc_card 的 background 为 var(--dsw-alias-bg-base)', async () => {
  const { env } = await render({});
  const rule = cssRules(env.css).find((item) => item.selector === '.sc_card');
  expect(rule, '没有找到选择器恰为 .sc_card 的规则');
  const decls = cssDecls(rule.body);
  expect(decls.background === 'var(--dsw-alias-bg-base)', `background 实际是 ${JSON.stringify(decls.background)}`);
});

await runCase('A3 整份 CSS 不含 --dsw-alias-bg-overlay', async () => {
  const { env } = await render({});
  expect(!env.css.includes('--dsw-alias-bg-overlay'), 'CSS 里仍出现 --dsw-alias-bg-overlay（遮罩灰回归）');
});

await runCase('A4 CSS 仍含隐藏官方任务面板的选择器', async () => {
  const { env } = await render({});
  const selector = '[data-conversation-content][data-status-card-hide-todo] [data-testid="todo-panel"]';
  expect(env.css.includes(selector), '缺少隐藏官方任务面板的选择器');
  const rule = cssRules(env.css).find((item) => item.selector === selector);
  expect(rule, '选择器存在但没解析出规则块');
  expect(cssDecls(rule.body).display === 'none!important', `display 实际是 ${JSON.stringify(cssDecls(rule.body).display)}`);
});

// B. 渲染契约
await runCase('B5 无 sessionId 时不渲染（null）', async () => {
  const { raw } = await render({ mainView: 0 });
  expect(raw === null, `期望 null，实际是 ${JSON.stringify(raw)?.slice(0, 120)}`);
});

await runCase('B6 全空时仍渲染卡片主体并显示「暂无任务与变更」', async () => {
  const { tree } = await render({ projections: {} });
  expect(tree !== null, '整卡返回了 null');
  expect(findAll(tree, (node) => hasClass(node, 'sc_card')).length === 1, '没找到 class 含 sc_card 的卡片根');
  expect(textOf(tree).includes('暂无任务与变更'), `卡片文本中没有空态文案，实际：${JSON.stringify(textOf(tree))}`);
});

const timingFetch = (timing) => () => okResponse({
  files: [],
  added: 0,
  deleted: 0,
  turns: 0,
  lastSeq: null,
  lastTurn: null,
  timing,
});

await runCase('B7 有本轮耗时就渲染状态条，而不是空态', async () => {
  const { tree } = await render({
    projections: {},
    fetchImpl: timingFetch({ turn: 1, modelMs: 42000, toolMs: 18000, waitSince: null }),
  });
  expect(tree !== null, '整卡返回了 null');
  const text = textOf(tree);
  const bar = blockOf(tree, 'timing');
  expect(bar && textOf(bar).startsWith('本轮'), `没有看到本轮耗时条，实际：${JSON.stringify(text)}`);
  expect(!text.includes('暂无任务与变更'), '有耗时时仍走了空态分支');
});

await runCase('B8 状态条：本轮 4m12s 后面接细分 模型 42s · 工具 18s · 等你 3m12s', async () => {
  const { tree } = await render({
    projections: {},
    fetchImpl: timingFetch({ turn: 1, modelMs: 42000, toolMs: 18000, waitMs: 0, waitSince: Date.now() - 192000 }),
  });
  const bar = blockOf(tree, 'timing');
  expect(bar, '没有渲染 data-sc-block=timing 的耗时条');
  // 总计 = 模型 42s + 工具 18s + 等你 3m12s（实时增量算进去）。
  const total = findAll(bar, (node) => hasClass(node, 'sc_timingTotalValue')).map((node) => textOf(node));
  expect(JSON.stringify(total) === '["4m12s"]', `总耗时显示为 ${JSON.stringify(total)}`);
  const values = findAll(bar, (node) => hasClass(node, 'sc_timingValue')).map((node) => textOf(node));
  expect(JSON.stringify(values) === '["42s","18s","3m12s"]', `三段耗时为 ${JSON.stringify(values)}`);
  const names = findAll(bar, (node) => hasClass(node, 'sc_timingName')).map((node) => textOf(node));
  expect(JSON.stringify(names) === '["模型","工具","等你"]', `三段标签为 ${JSON.stringify(names)}`);
  // 文案只留「本轮」——「耗时」不写出来，读者从数值形态就知道那是时长。
  const labelText = textOf(findAll(bar, (node) => hasClass(node, 'sc_timingLabel'))[0]);
  expect(labelText === '本轮', `总计标签应为「本轮」，实际 ${JSON.stringify(labelText)}`);
  expect(textOf(bar).startsWith('本轮'), `状态条应以「本轮」开头，实际 ${JSON.stringify(textOf(bar))}`);
});

await runCase('B9 任务块出现 1/3 已完成', async () => {
  const { tree } = await render(richOpts());
  const block = blockOf(tree, 'task');
  expect(block, '没有渲染 data-sc-block=task 的任务块');
  expect(textOf(block).includes('1/3 已完成'), `任务块文本实际为 ${JSON.stringify(textOf(block))}`);
});

await runCase('B10 变更块出现 +1,234 / -651 / 2 个文件', async () => {
  const { tree } = await render(richOpts());
  const block = blockOf(tree, 'changes');
  expect(block, '没有渲染 data-sc-block=changes 的变更块');
  const text = textOf(block);
  for (const needle of ['+1,234', '-651', '2 个文件']) {
    expect(text.includes(needle), `变更块文本缺少 ${JSON.stringify(needle)}，实际：${JSON.stringify(text)}`);
  }
});

await runCase('B11 子智能体块出现「队友 2 · 任务 1/3」与成员卡的活动状态', async () => {
  const { tree } = await render(richOpts());
  const block = blockOf(tree, 'agents');
  expect(block, '没有渲染 data-sc-block=agents 的子智能体块');
  const text = textOf(block);
  for (const needle of ['队友 2 · 任务 1/3', '接线宿主', '正在运行', '当前未运行']) {
    expect(text.includes(needle), `子智能体块缺少 ${JSON.stringify(needle)}，实际：${JSON.stringify(text)}`);
  }
});

await runCase('B12 目标块出现「第 3 轮」', async () => {
  const { tree } = await render(richOpts());
  const block = blockOf(tree, 'goal');
  expect(block, '没有渲染 data-sc-block=goal 的目标块');
  expect(textOf(block).includes('第 3 轮'), `目标块文本实际为 ${JSON.stringify(textOf(block))}`);
});

await runCase('B13 折叠：卡片缩到右上角并藏起来，只剩一颗圆形展开按钮（两态常驻、靠 data-state 切换）', async () => {
  const { env, props, tree } = await render({
    projections: {
      todos: [
        { content: '甲', status: 'completed' },
        { content: '乙', status: 'pending' },
      ],
    },
    fetchImpl: () => okResponse({ files: [], added: 0, deleted: 0 }),
  });
  const toggle = findAll(tree, (node) => node.props?.['aria-label'] === '收起卡片' && typeof node.props.onClick === 'function')[0];
  expect(toggle, '没找到收起按钮，无法折叠');
  toggle.props.onClick();
  const collapsedTree = expand(await pump(env.card, props));
  expect(anchorStateOf(collapsedTree) === 'fab', `锚点 data-state 为 ${JSON.stringify(anchorStateOf(collapsedTree))}，收起时应切到 fab`);
  // 卡片不卸载：卸载了就没有收缩过程，只剩硬切。
  expect(asideNodes(collapsedTree).length === 1, '收起后卡片本体不该被卸载（否则收缩动画没法播）');
  expect(hiddenCardOf(collapsedTree), '收起后卡片必须标 aria-hidden，否则读屏还能读到卡片内容');
  const fabs = findAll(collapsedTree, (node) => hasClass(node, 'sc_fab'));
  expect(fabs.length === 1, `折叠后圆钮数量为 ${fabs.length}`);
  expect(fabs[0].type === 'button', '折叠后的圆钮不是 button');
  expect(fabs[0].props?.['data-sc-action'] === 'toggle-card', `圆钮的 action 是 ${JSON.stringify(fabs[0].props?.['data-sc-action'])}`);
  expect(fabs[0].props?.['aria-label'] === '展开卡片', `圆钮 aria-label 是 ${JSON.stringify(fabs[0].props?.['aria-label'])}`);
  expect(textOf(fabs[0]) === '', `圆钮里不该有文字，实际 ${JSON.stringify(textOf(fabs[0]))}`);
  // 两态各有自己的过渡规则：收起缩向右上角、展开时圆钮缩回去。
  const foldRule = env.css.match(/\.sc_anchor\[data-state="fab"\] \.sc_card\{([^}]*)\}/)?.[1] ?? '';
  expect(/visibility:hidden/.test(foldRule) && /transform:scale\(/.test(foldRule),
    `收起规则为 ${JSON.stringify(foldRule)}，应把卡片缩小并隐藏`);
  const fabOutRule = env.css.match(/\.sc_anchor\[data-state="card"\] \.sc_fab\{([^}]*)\}/)?.[1] ?? '';
  expect(/visibility:hidden/.test(fabOutRule), `展开态圆钮规则为 ${JSON.stringify(fabOutRule)}，圆钮应缩回去隐藏`);
  // 再点圆钮回到展开态。
  fabs[0].props.onClick();
  const reopened = expand(await pump(env.card, props));
  expect(anchorStateOf(reopened) === 'card', `再点圆钮后 data-state 为 ${JSON.stringify(anchorStateOf(reopened))}`);
  expect(!hiddenCardOf(reopened), '展开后卡片不该再带 aria-hidden');
});

await runCase('B14 任务行超过阈值时出现「查看全部 9 项」', async () => {
  const todos = Array.from({ length: 9 }, (_, index) => ({ content: `步骤 ${index + 1}`, status: index === 0 ? 'completed' : 'pending' }));
  const { tree } = await render({ projections: { todos } });
  const text = textOf(tree);
  expect(text.includes('查看全部 9 项'), `没有看到展开入口，实际：${JSON.stringify(textOf(blockOf(tree, 'task')))}`);
});

await runCase('B15 变更路由失败态显示「变更数据不可用」', async () => {
  const { tree } = await render({ projections: { todos: [{ content: 'x', status: 'pending' }] }, fetchImpl: () => badResponse(500) });
  expect(textOf(tree).includes('变更数据不可用'), `实际文本：${JSON.stringify(textOf(blockOf(tree, 'changes') ?? tree))}`);
});

await runCase('B16 变更加载态显示「读取变更…」', async () => {
  const { tree } = await render({ projections: { todos: [{ content: 'x', status: 'pending' }] }, fetchImpl: () => new Promise(() => {}) });
  expect(textOf(tree).includes('读取变更…'), `实际文本：${JSON.stringify(textOf(blockOf(tree, 'changes') ?? tree))}`);
});

await runCase('B17 头部按钮可按 aria-label 找到 收起卡片 / 展开卡片（折叠态卡片让位，圆钮接管）', async () => {
  const { env, props, tree } = await render({});
  const labels = (node) => findAll(node, (item) => typeof item.props?.['aria-label'] === 'string').map((item) => item.props['aria-label']);
  expect(labels(tree).includes('收起卡片'), `展开态头部 aria-label 实际为 ${JSON.stringify(labels(tree))}`);
  expect(labels(tree).includes('刷新变更数据'), `展开态缺少刷新按钮，实际为 ${JSON.stringify(labels(tree))}`);
  const toggle = findAll(tree, (node) => node.props?.['aria-label'] === '收起卡片' && typeof node.props.onClick === 'function')[0];
  expect(toggle, '没找到收起按钮');
  toggle.props.onClick();
  const collapsedTree = expand(await pump(env.card, props));
  expect(anchorStateOf(collapsedTree) === 'fab', `折叠态锚点 data-state 实际为 ${JSON.stringify(anchorStateOf(collapsedTree))}`);
  expect(hiddenCardOf(collapsedTree), '折叠态卡片没被藏起来，读屏仍会读到刷新/收起按钮');
  const fab = findAll(collapsedTree, (node) => hasClass(node, 'sc_fab'))[0];
  expect(fab?.props?.['aria-label'] === '展开卡片', `折叠态接管按钮的 aria-label 为 ${JSON.stringify(fab?.props?.['aria-label'])}`);
});

await runCase('B18 卡片根 class 含 sc_card；任务行用勾选圆 sc_check，成员用圆点 sc_mark，都带 data-state', async () => {
  const { tree } = await render(richOpts());
  const cards = findAll(tree, (node) => node.type === 'aside' && hasClass(node, 'sc_card'));
  expect(cards.length === 1, `aside.sc_card 数量为 ${cards.length}`);
  // 任务条目走勾选圆（done / running / idle 三态），与官方任务面板语义一致。
  const checks = findAll(tree, (node) => hasClass(node, 'sc_check'));
  expect(checks.length > 0, '没有任何 sc_check 勾选圆');
  const checkStates = new Set(checks.map((node) => node.props?.['data-state']));
  for (const state of ['done', 'running', 'idle']) {
    expect(checkStates.has(state), `勾选圆缺少状态 ${state}，实际为 ${JSON.stringify([...checkStates])}`);
  }
  const marks = findAll(tree, (node) => hasClass(node, 'sc_mark'));
  expect(marks.length > 0, '没有任何 sc_mark 圆点');
  const missing = marks.filter((node) => typeof node.props?.['data-state'] !== 'string');
  expect(missing.length === 0, `${missing.length} 个 sc_mark 缺少 data-state`);
  const states = new Set(marks.map((node) => node.props['data-state']));
  for (const state of ['running', 'idle', 'error']) {
    expect(states.has(state), `data-state 缺少 ${state}，实际为 ${JSON.stringify([...states])}`);
  }
});

await runCase('B19 图标是自绘 SVG（sc_icon），且未 require 任何官方 primitives 包', async () => {
  const { env, tree } = await render(richOpts());
  const svgs = findAll(tree, (node) => node.type === 'svg');
  expect(svgs.length >= 8, `svg 图标数量只有 ${svgs.length}，少于预期下限 8`);
  // 自绘 svg 只有两个家族：单色线性图标 sc_icon（16 格、currentColor 描边）与
  // 彩色文件类型图标 sc_fileIcon（28 格、色块填充、按 data-kind 上色）。
  const isLineIcon = (node) => hasClass(node, 'sc_icon')
    && node.props?.viewBox === '0 0 16 16' && node.props?.stroke === 'currentColor';
  const isFileIcon = (node) => hasClass(node, 'sc_fileIcon')
    && node.props?.viewBox === '0 0 28 28' && typeof node.props?.['data-kind'] === 'string';
  const badClass = svgs.filter((node) => !isLineIcon(node) && !isFileIcon(node));
  expect(badClass.length === 0, `${badClass.length} 个 svg 既不是 sc_icon 也不是 sc_fileIcon`);
  const paths = findAll(tree, (node) => node.type === 'path');
  expect(paths.length >= svgs.length, `path 数量 ${paths.length} 少于 svg 数量 ${svgs.length}`);
  expect(paths.every((node) => typeof node.props?.d === 'string' && node.props.d.length > 0), '存在没有 d 的 path');
  // 图标类名只允许本插件自绘的两类；任何「官方图标组件」的类名（含 icon 字样）都会被这条抓住。
  const iconClasses = new Set();
  walk(tree, (node) => { for (const cls of classOf(node)) if (/icon/iu.test(cls)) iconClasses.add(cls); });
  const strayIconClasses = [...iconClasses].filter((cls) => cls !== 'sc_icon' && cls !== 'sc_iconBtn' && cls !== 'sc_fileIcon');
  expect(strayIconClasses.length === 0, `出现了非自绘图标的类名：${JSON.stringify(strayIconClasses)}`);
  // 除按钮容器外，凡是图标类名的元素都必须是 svg。
  const nonSvgIcons = findAll(tree, (node) => classOf(node).some((cls) => /icon/iu.test(cls)) && node.type !== 'svg' && !hasClass(node, 'sc_iconBtn'));
  expect(nonSvgIcons.length === 0, `${nonSvgIcons.length} 个图标元素不是 svg：${JSON.stringify(nonSvgIcons.map((n) => classOf(n)))}`);
  const offenders = env.requiredIds.filter((id) => id !== 'react');
  expect(offenders.length === 0, `require 了额外模块：${JSON.stringify(env.requiredIds)}`);
  const suspicious = env.requiredIds.filter((id) => /primitive|icon|ui-|@deepseek|@dsh/iu.test(id));
  expect(suspicious.length === 0, `require 命中官方包：${JSON.stringify(suspicious)}`);
});

// X. 加载方式自检（证明上面这些断言确实读到了真实的插件产出）
await runCase('X1 apply 注册 shell.overlay 座位、status-card 词典、并请求 slots/sessions/locale', async () => {
  const env = setup({});
  expect(env.manifest.id === '@liuhusk/dsh-status-card', `模块 id 实际为 ${env.manifest.id}`);
  expect(JSON.stringify(env.plugin.inject) === JSON.stringify(['slots', 'sessions', 'locale']),
    `inject 实际为 ${JSON.stringify(env.plugin.inject)}`);
  expect(env.injections.includes('shell.overlay'), `slots.inject 实际为 ${JSON.stringify(env.injections)}`);
  expect(env.slots[0]?.options?.name === 'shell.overlay', `座位 options 实际为 ${JSON.stringify(env.slots[0]?.options)}`);
  expect(env.slots[0]?.options?.locale === NS, `座位 locale 实际为 ${JSON.stringify(env.slots[0]?.options?.locale)}`);
  expect(env.locales.some((item) => item.ns === NS), `locale.register 实际为 ${JSON.stringify(env.locales.map((i) => i.ns))}`);
});

await runCase('X2 zh / en 词典键集逐字对齐', async () => {
  const env = setup({});
  const zhKeys = Object.keys(env.dicts?.zh ?? {}).sort();
  const enKeys = Object.keys(env.dicts?.en ?? {}).sort();
  expect(zhKeys.length > 0, 'zh 词典为空');
  expect(JSON.stringify(zhKeys) === JSON.stringify(enKeys), `zh/en 键集不一致：zh=${zhKeys.length} en=${enKeys.length}`);
});

await runCase('X3 变更路由按会话请求：api/status-card.changes?sessionId=sess-main（文档相对）', async () => {
  const { env } = await render({});
  expect(env.fetchCalls.length > 0, '没有发起任何 fetch');
  expect(env.fetchCalls[0].url === `api/status-card.changes?sessionId=${MAIN}`, `请求地址实际为 ${env.fetchCalls[0].url}`);
  expect(!env.fetchCalls[0].url.startsWith('/'),
    '请求用了绝对路径：以「剥前缀代理」挂载时会打到源站根而落空（官方用文档相对形式）');
});

await runCase('X4 卸载时样式可被回收（injectStyles 的清理函数生效）', async () => {
  const env = setup({});
  expect(env.styles.length === 1, `注入后 style 数量为 ${env.styles.length}`);
  expect(env.cleanups.some((item) => typeof item === 'function'), 'ctx.effect 没有拿到任何清理函数');
  for (const cleanup of env.cleanups) if (typeof cleanup === 'function') cleanup();
  expect(env.styles.length === 0, `清理后 style 数量为 ${env.styles.length}`);
});

/* ------------------------------------------------------------------ C. 空间闸门（内容区过窄自动隐藏） */

await runCase('C1 内容区宽 1200 ≥ 820：渲染 aside.sc_card，锚点根 data-card-visible="true"', async () => {
  const { tree, contentEl } = await renderAt(1200);
  expect(contentEl.box.width === 1200, `夹具宽度没生效：${contentEl.box.width}`);
  const asides = asideNodes(tree);
  expect(asides.length === 1, `aside.sc_card 数量为 ${asides.length}（期望 1）`);
  const anchor = anchorNodeOf(tree);
  expect(anchor, '没有找到 .sc_anchor 锚点根');
  expect(cardVisibleOf(tree) === 'true', `锚点根 data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(tree))}`);
});

await runCase('C2 内容区宽 700 < 820：不渲染 aside.sc_card，但锚点根仍在且 data-card-visible="false"', async () => {
  const { tree } = await renderAt(700);
  const asides = asideNodes(tree);
  expect(asides.length === 0, `期望不渲染卡片，实际有 ${asides.length} 个 aside.sc_card`);
  const anchor = anchorNodeOf(tree);
  expect(anchor, '锚点根 .sc_anchor 跟着卡片一起消失了——测量链会断，卡片将反复抖动');
  expect(cardVisibleOf(tree) === 'false', `锚点根 data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(tree))}`);
  expect(typeof anchor.props?.ref === 'object' && anchor.props.ref !== null, '锚点根丢了 ref，offsetParent 将无法测量');
});

await runCase('C3 边界两侧：820 → 显示；819 → 隐藏（比较是 >=）', async () => {
  const at820 = await renderAt(820);
  expect(asideNodes(at820.tree).length === 1, '宽度 820 时没有渲染卡片（820 应属于可见侧）');
  expect(cardVisibleOf(at820.tree) === 'true', `宽度 820 时 data-card-visible 为 ${JSON.stringify(cardVisibleOf(at820.tree))}`);
  const at819 = await renderAt(819);
  expect(asideNodes(at819.tree).length === 0, '宽度 819 时仍渲染了卡片（819 应属于隐藏侧）');
  expect(cardVisibleOf(at819.tree) === 'false', `宽度 819 时 data-card-visible 为 ${JSON.stringify(cardVisibleOf(at819.tree))}`);
  // contentWidth 是取整后的整数：819.6 → 820 → 可见（Math.round 契约，也顺带证明比较用的是取整值）。
  const atFraction = await renderAt(819.6);
  expect(asideNodes(atFraction.tree).length === 1,
    '宽度 819.6 应取整为 820 而可见，实际被隐藏（contentWidth 没有 Math.round）');
});

await runCase('C4 窄 700 → 宽 1200：卡片重新出现（不是一次性隐藏后失效）', async () => {
  const ctx = await renderAt(700);
  expect(asideNodes(ctx.tree).length === 0, '初始宽度 700 时应隐藏卡片');
  const wide = await resizeTo(ctx, 1200);
  expect(asideNodes(wide).length === 1, '宽度恢复到 1200 后卡片没有回来');
  expect(cardVisibleOf(wide) === 'true', `恢复后 data-card-visible 为 ${JSON.stringify(cardVisibleOf(wide))}`);
  const narrowAgain = await resizeTo(ctx, 700);
  expect(asideNodes(narrowAgain).length === 0, '再次收窄到 700 后卡片没有隐藏');
  const wideAgain = await resizeTo(ctx, 900);
  expect(asideNodes(wideAgain).length === 1, '第二次恢复宽度后卡片没有回来');
});

await runCase('C5a 量不到内容区（content === null）→ 卡片仍然渲染', async () => {
  const { tree, env } = await render({ contents: [] });
  expect(env.contentEls.length === 0, '夹具本应没有内容区元素');
  const asides = asideNodes(tree);
  expect(asides.length === 1, `内容区取不到时应按「有空间」处理并渲染卡片，实际 aside.sc_card 数量 ${asides.length}`);
  expect(cardVisibleOf(tree) === 'true', `data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(tree))}`);
});

await runCase('C5b 内容区矩形 width === 0 → 卡片仍然渲染', async () => {
  const contentEl = controlledContent({ width: 0, height: 600, sessionId: MAIN });
  const { tree } = await render({ contents: [contentEl] });
  expect(contentEl.box.width === 0, '夹具宽度没生效');
  const asides = asideNodes(tree);
  expect(asides.length === 1, `width=0（测量失败）时应渲染卡片，实际 aside.sc_card 数量 ${asides.length}`);
  expect(cardVisibleOf(tree) === 'true', `width=0 时 data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(tree))}`);
});

await runCase('C5c 内容区矩形 height === 0 → 即使宽度看似很窄也当作未知，卡片仍然渲染', async () => {
  const wide = controlledContent({ width: 1200, height: 0, sessionId: MAIN });
  const { tree: wideTree } = await render({ contents: [wide] });
  expect(wide.box.height === 0, '夹具高度没生效');
  const wideAsides = asideNodes(wideTree);
  expect(wideAsides.length === 1, `height=0（测量失败）时应渲染卡片，实际 aside.sc_card 数量 ${wideAsides.length}`);
  const narrow = controlledContent({ width: 700, height: 0, sessionId: MAIN });
  const { tree: narrowTree } = await render({ contents: [narrow] });
  const narrowAsides = asideNodes(narrowTree);
  expect(narrowAsides.length === 1, 'height=0 且宽度 700 时应按「宽度未知」处理并渲染卡片，实际被隐藏（height===0 这一支被绕过）');
  expect(cardVisibleOf(narrowTree) === 'true', `data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(narrowTree))}`);
});

await runCase('C6 折叠态在宽度 < 820 时同样不渲染；宽度恢复后仍是折叠态', async () => {
  const ctx = await renderAt(1200);
  const toggle = findAll(ctx.tree, (node) => node.props?.['aria-label'] === '收起卡片' && typeof node.props.onClick === 'function')[0];
  expect(toggle, '没找到收起按钮');
  toggle.props.onClick();
  const collapsed = expand(await pump(ctx.env.card, ctx.props));
  expect(anchorStateOf(collapsed) === 'fab', `折叠后 data-state 实际为 ${JSON.stringify(anchorStateOf(collapsed))}`);
  expect(hiddenCardOf(collapsed), '折叠后卡片应被 CSS 藏起来');
  expect(findAll(collapsed, (node) => hasClass(node, 'sc_fab')).length === 1, '折叠后没有圆钮');
  const narrow = await resizeTo(ctx, 700);
  expect(asideNodes(narrow).length === 0, '折叠态在窄内容区下仍然渲染了卡片');
  expect(findAll(narrow, (node) => hasClass(node, 'sc_fab')).length === 0, '窄内容区下圆钮也应一并隐藏');
  expect(anchorNodeOf(narrow), '窄内容区下锚点根不应消失');
  const wide = await resizeTo(ctx, 1200);
  expect(hiddenCardOf(wide), '宽度恢复后仍是折叠态，卡片不该自动展开');
  expect(findAll(wide, (node) => hasClass(node, 'sc_fab')).length === 1, '宽度恢复后折叠态丢失');
});

await runCase('C7 闸门与官方任务面板接管联动：≥820 有标记，<820 无标记，窄→宽 重新加上', async () => {
  const ctx = await renderAt(1200);
  expect(hasHideMark(ctx.contentEl), '宽度 1200 时主内容区缺少 data-status-card-hide-todo');
  const narrow = await resizeTo(ctx, 700);
  expect(anchorNodeOf(narrow), '窄内容区下整棵树不应为 null');
  expect(!hasHideMark(ctx.contentEl), '宽度 700 时仍保留 data-status-card-hide-todo：官方面板被藏、替代卡片又不显示');
  await resizeTo(ctx, 1200);
  expect(hasHideMark(ctx.contentEl), '宽度恢复后 data-status-card-hide-todo 没有被重新加上');
});

await runCase('C8 CSS 里 .sc_anchor 仍是绝对定位的常驻容器（锚点保留才有意义）', async () => {
  const { env } = await render({});
  const rule = cssRules(env.css).find((item) => item.selector === '.sc_anchor');
  expect(rule, '没有找到选择器恰为 .sc_anchor 的规则');
  const decls = cssDecls(rule.body);
  expect(decls.position === 'absolute', `.sc_anchor 的 position 实际为 ${JSON.stringify(decls.position)}`);
  expect(decls['pointer-events'] === 'none', `.sc_anchor 的 pointer-events 实际为 ${JSON.stringify(decls['pointer-events'])}`);
  expect(decls.display !== 'none', '.sc_anchor 被 display:none 藏掉了：锚点等于不存在，测量链会断');
});

/* ------------------------------------------------------------------ C（续）. 面板闸门（非会话页不渲染） */

await runCase('C9 看全局面板（activePanelId="plugins"）时不渲染卡片，锚点根仍在', async () => {
  const { tree } = await renderAt(1200, { activePanelId: 'plugins' });
  const asides = asideNodes(tree);
  expect(asides.length === 0, `在插件页仍渲染了 ${asides.length} 个 aside.sc_card（应整卡不渲染，否则压住插件界面）`);
  expect(anchorNodeOf(tree), '锚点根不应消失');
  expect(cardVisibleOf(tree) === 'false', `data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(tree))}`);
});

await runCase('C10 从全局面板切回会话：卡片重新出现（面板闸门不是一次性隐藏）', async () => {
  const ctx = await renderAt(1200, { panelState: { activePanelId: 'plugins' } });
  expect(asideNodes(ctx.tree).length === 0, '初始在插件页时应隐藏卡片');
  ctx.panelState.activePanelId = null;
  const back = expand(await pump(ctx.env.card, ctx.props));
  expect(asideNodes(back).length === 1, '回到会话后卡片没有回来');
  expect(cardVisibleOf(back) === 'true', `回到会话后 data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(back))}`);
  ctx.panelState.activePanelId = 'schedules';
  const away = expand(await pump(ctx.env.card, ctx.props));
  expect(asideNodes(away).length === 0, '切到定时任务面板后卡片仍在渲染');
});

await runCase('C11 宿主没提供 usePanelInfo 时退化：照常渲染卡片', async () => {
  const { tree } = await renderAt(1200, { withoutPanelInfo: true });
  const asides = asideNodes(tree);
  expect(asides.length === 1, `缺少 usePanelInfo 时应兜底为「在看会话」并渲染，实际 ${asides.length} 个 aside.sc_card`);
  expect(cardVisibleOf(tree) === 'true', `data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(tree))}`);
});

await runCase('C12 两个闸门是 AND：会话页窄内容区隐藏；宽内容区但看全局面板同样不渲染', async () => {
  const narrow = await renderAt(700, { activePanelId: null });
  expect(asideNodes(narrow.tree).length === 0, '会话页窄内容区应隐藏卡片');
  const panel = await renderAt(1200, { activePanelId: 'plugins' });
  expect(asideNodes(panel.tree).length === 0, '宽内容区但看全局面板时仍不应渲染卡片');
  expect(cardVisibleOf(panel.tree) === 'false', `看全局面板时 data-card-visible 实际为 ${JSON.stringify(cardVisibleOf(panel.tree))}`);
});

/* ------------------------------------------------------------------ X. 驱动路径自检 */

await runCase('X5 驱动路径自检：resize 监听器已注册且恰好 1 个；触发后测量的宽度真实生效', async () => {
  const ctx = await renderAt(1200);
  expect(ctx.env.resizeListenerCount() === 1, `resize 监听器数量为 ${ctx.env.resizeListenerCount()}（期望 1）`);
  // 层矩形 {top:40,right:1000} + 内容矩形 {top:60,right:900} + ANCHOR_GAP 12
  // → top 32 / right 112。兜底位置是 {top:78,right:20}，两者不同：几何对不上就说明
  // 首测根本没拿到锚点层或内容区（测量链路没接通）。
  const style = anchorNodeOf(ctx.tree)?.props?.style;
  expect(style?.top === 32 && style?.right === 112,
    `首测几何为 ${JSON.stringify(style)}，与量出来的 {top:32,right:112} 不符（说明 measure() 拿到的是兜底值）`);
  ctx.contentEl.setWidth(819);
  ctx.env.fireResize();
  const narrow = expand(await pump(ctx.env.card, ctx.props));
  expect(cardVisibleOf(narrow) === 'false', '触发 resize 后宽度 819 没有生效（驱动路径没接通）');
  ctx.contentEl.setWidth(820);
  ctx.env.fireResize();
  const wide = expand(await pump(ctx.env.card, ctx.props));
  expect(cardVisibleOf(wide) === 'true', '触发 resize 后宽度 820 没有生效（驱动路径没接通）');
});

await runCase('X6 宿主没有 useLayoutEffect 时退化到 useEffect：不抛错且首测仍能量到宽度', async () => {
  expect(ReactFake.useLayoutEffect === undefined, 'React 替身本应不提供 useLayoutEffect（否则测不到退化路径）');
  const { tree } = await renderAt(1200);
  expect(asideNodes(tree).length === 1, '退化路径下卡片没有渲染（组件抛错或宽度读回 null 之外的值）');
  const style = anchorNodeOf(tree)?.props?.style;
  expect(style?.top === 32 && style?.right === 112, `退化路径下首测几何为 ${JSON.stringify(style)}，measure() 没有真正执行`);
});

/* ------------------------------------------------------------------ H. Host 半边静态契约 */

await runCase('H1 Host 半的 inject 必须是数组形式（对象形式会被 cordis 当成服务名，fiber 永远 PENDING）', async () => {
  const source = readFileSync(HOST, 'utf8');
  expect(/export const inject\s*=\s*\[/u.test(source), 'Host 半的 inject 不是数组形式');
  expect(!/export const inject\s*=\s*\{/u.test(source),
    'inject 用了对象形式：cordis 的「对象形式」是「服务名 → 拦截配置」映射，会解析出 required/optional 两个不存在的服务，fiber 永远停在 PENDING——apply 不执行、不报错，路由静默缺失');
  const deps = source.match(/export const inject\s*=\s*\[([^\]]*)\]/u)?.[1] ?? '';
  for (const name of ['connection', 'workspaceChanges', 'sessions', 'shell']) {
    expect(deps.includes(`'${name}'`), `inject 数组里缺少 '${name}'`);
  }
});

await runCase('H2 Host 半不再依赖 session/event 监听找 seq（真机上监听收不到事件时整块静默为空）', async () => {
  const source = readFileSync(HOST, 'utf8');
  expect(!/ctx\.on\(\s*['"`]session\/event/u.test(source),
    'Host 半又回去监听 session/event 了：真机上该监听拿不到 workspace/changes（内存表空 → 卡片无数据，且没有任何可见信号）。seq 必须从会话日志现读');
  expect(/snapshotEvents/u.test(source), 'Host 半没有读会话日志（ctx.sessions.get(...).snapshotEvents）');
});

await runCase('H3 scanLog 抽出 workspace/changes 的 seq 与 exit_plan_mode 的计划（PTC 重复只留最后一条）', async () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'workspace/changes', data: { turn: 1 } },
    { seq: 2, type: 'tool/ptc-dispatch-start', data: { name: 'exit_plan_mode', subCallId: 'call-a', arguments: '{"plan":"# 第一版"}' } },
    { seq: 3, type: 'tool/ptc-dispatch', data: { name: 'exit_plan_mode', subCallId: 'call-a', arguments: '{"plan":"# 第二版"}' } },
    { seq: 4, type: 'tool/call', data: { name: 'read_file', arguments: '{}' } },
    { seq: 5, type: 'workspace/changes', data: { turn: 2 } },
  ];
  const { seqs, plans } = host.scanLog(events);
  expect(JSON.stringify(seqs) === '[1,5]', `seq 抽取不对：${JSON.stringify(seqs)}`);
  expect(plans.length === 1, `同一 callId 应只留一条，实际 ${plans.length} 条`);
  expect(plans[0].callId === 'call-a' && plans[0].title === '第二版', `计划应取最后一条（第二版），实际 ${JSON.stringify(plans[0])}`);
  const grown = host.scanLog([{ seq: 6, type: 'workspace/changes', data: { turn: 3 } }], { seqs, plans });
  expect(JSON.stringify(grown.seqs) === '[1,5,6]', `增量续扫没有接上旧结果：${JSON.stringify(grown.seqs)}`);
  expect(grown.plans.length === 1, '增量续扫把计划弄丢了');
});

await runCase('H4 sessionIndex 按「会话对象 + 日志长度」增量扫描，换会话对象时整段重扫', async () => {
  const events = [{ seq: 0, type: 'workspace/changes', data: { turn: 1 } }];
  const session = { id: 's1', snapshotEvents: (from = 0) => events.slice(from) };
  const sessions = new Map([['s1', session]]);
  const ctx = { sessions: { get: (id) => sessions.get(id) } };
  const cache = new Map();
  const first = host.sessionIndex(ctx, cache, 's1');
  expect(JSON.stringify(first.seqs) === '[0]', `首扫结果不对：${JSON.stringify(first.seqs)}`);
  events.push({ seq: 1, type: 'workspace/changes', data: { turn: 2 } });
  const second = host.sessionIndex(ctx, cache, 's1');
  expect(JSON.stringify(second.seqs) === '[0,1]', `续扫结果不对：${JSON.stringify(second.seqs)}`);
  expect(second.length === 2, `缓存长度没更新：${second.length}`);
  const reclaimed = { id: 's1', snapshotEvents: (from = 0) => events.slice(from) };
  sessions.set('s1', reclaimed);
  const third = host.sessionIndex(ctx, cache, 's1');
  expect(third.session === reclaimed && third.length === 2, '换了会话对象没有整段重扫（会漏掉历史 seq）');
  const missing = host.sessionIndex(ctx, cache, 'nope');
  expect(missing.seqs.length === 0 && missing.plans.length === 0, '会话不在内存里时应返回空结果');
});

await runCase('H5 路由：缺 sessionId → 400；有会话 → 汇总文件 + 计划 + no-store', async () => {
  const summaries = new Map([[0, {
    turn: 1,
    files: [{ path: '/w/a.ts', display: 'a.ts', added: 3, deleted: 1 }],
    total: 1,
    added: 3,
    deleted: 1,
  }]]);
  const events = [
    { seq: 0, type: 'workspace/changes', data: { turn: 1 } },
    { seq: 1, type: 'tool/call', data: { name: 'exit_plan_mode', callId: 'call-z', arguments: '{"plan":"# 计划 Z"}' } },
  ];
  const ctx = {
    sessions: { get: () => ({ id: 's1', snapshotEvents: (from = 0) => events.slice(from) }) },
    workspaceChanges: { summary: (_sid, seq) => summaries.get(seq) },
    shell: { sandboxMode: 'workspace-write' },
  };
  const cache = new Map();
  const bad = host.handleChangesRequest(ctx, cache, { url: 'http://127.0.0.1/api/status-card.changes' });
  expect(bad.status === 400, `缺 sessionId 应为 400，实际 ${bad.status}`);
  const good = host.handleChangesRequest(ctx, cache, { url: 'http://127.0.0.1/api/status-card.changes?sessionId=s1' });
  expect(good.status === 200, `正常请求应为 200，实际 ${good.status}`);
  expect(good.headers.get('cache-control') === 'no-store', '响应没有 no-store');
  const body = await good.json();
  expect(body.total === 1 && body.files[0].turn === 1 && body.files[0].seq === 0, `文件汇总不对：${JSON.stringify(body.files)}`);
  expect(body.lastSeq === 0 && body.lastTurn === 1 && body.turns === 1, `轮次坐标不对：${JSON.stringify({ lastSeq: body.lastSeq, lastTurn: body.lastTurn, turns: body.turns })}`);
  expect(body.sandboxMode === 'workspace-write', 'sandboxMode 没带上');
  expect(body.plans.length === 1 && body.plans[0].callId === 'call-z', `计划没下发：${JSON.stringify(body.plans)}`);
});

/* ------------------------------------------------------------------ G. 任务块折叠 */

const actionNode = (tree, action) => findAll(tree, (node) => node.props?.['data-sc-action'] === action)[0];

await runCase('G1 任务块默认展开；点折叠按钮后条目消失但进度仍在，再点恢复', async () => {
  const { env, props, tree } = await render(richOpts());
  const toggle = actionNode(tree, 'toggle-task');
  expect(toggle, '任务块没有折叠按钮');
  expect(toggle.props['aria-expanded'] === true, `默认应为展开态，aria-expanded 实际为 ${JSON.stringify(toggle.props['aria-expanded'])}`);
  expect(findAll(blockOf(tree, 'task'), (node) => hasClass(node, 'sc_row')).length === 3, '展开态应渲染 3 条任务');
  toggle.props.onClick();
  const collapsed = expand(await pump(env.card, props));
  const block = blockOf(collapsed, 'task');
  expect(textOf(block).includes('1/3 已完成'), `折叠后进度丢了吗？文本为 ${JSON.stringify(textOf(block))}`);
  expect(findAll(block, (node) => hasClass(node, 'sc_row')).length === 0, '折叠后仍渲染了任务条目');
  const reopen = actionNode(collapsed, 'toggle-task');
  expect(reopen.props['aria-expanded'] === false, '折叠态 aria-expanded 应为 false');
  reopen.props.onClick();
  const reopened = expand(await pump(env.card, props));
  expect(findAll(blockOf(reopened, 'task'), (node) => hasClass(node, 'sc_row')).length === 3, '再点一次没有恢复条目');
});

await runCase('G2 折叠时「查看全部 N 项」入口一并收起（折叠优先于展开）', async () => {
  const todos = Array.from({ length: 9 }, (_, index) => ({ content: `步骤 ${index + 1}`, status: 'pending' }));
  const { env, props, tree } = await render({ projections: { todos } });
  expect(textOf(tree).includes('查看全部 9 项'), '前置条件不成立：默认应出现「查看全部 9 项」');
  actionNode(tree, 'toggle-task').props.onClick();
  const collapsed = expand(await pump(env.card, props));
  expect(!textOf(collapsed).includes('查看全部'), `折叠后仍出现展开入口：${JSON.stringify(textOf(blockOf(collapsed, 'task')))}`);
});

/* ------------------------------------------------------------------ P. 计划块 */

const plansFetch = (plans) => () => okResponse({ files: [], added: 0, deleted: 0, plans });
const planRow = (callId, title, seq = 1) => ({ callId, title, seq });
const planText = (tree) => textOf(blockOf(tree, 'plan') ?? '');

await runCase('P1 有已提交计划时渲染计划块（标题 + 数量）', async () => {
  const { tree } = await render({ projections: { todos: [] }, fetchImpl: plansFetch([planRow('call-1', '重建状态卡片')]) });
  const block = blockOf(tree, 'plan');
  expect(block, '没有渲染 data-sc-block=plan 的计划块');
  expect(textOf(block).includes('重建状态卡片'), `计划块文本实际为 ${JSON.stringify(textOf(block))}`);
  expect(textOf(block).includes('1 个计划'), `计划数量文案实际为 ${JSON.stringify(textOf(block))}`);
});

await runCase('P2 点计划行 → 用官方 plan 预览类型在右栏打开 dsh-resource://plan/<sid>/<callId>', async () => {
  const { env, tree } = await render({ projections: { todos: [] }, fetchImpl: plansFetch([planRow('call-1', '重建状态卡片')]) });
  const row = actionNode(tree, 'open-plan');
  expect(row, '计划行不是可点按钮');
  row.props.onClick();
  await tick();
  const open = env.resources.filter((item) => item.kind === 'openResourceIn');
  expect(open.length === 1, `右栏调用次数为 ${open.length}`);
  expect(open[0].args[0] === MAIN, `会话参数实际为 ${JSON.stringify(open[0].args[0])}`);
  // 普通会话只有两段：官方 parsePlanAddress 不接受 `plan/session/...` 这种多一层的写法。
  expect(open[0].args[1] === `dsh-resource://plan/${MAIN}/call-1`, `地址实际为 ${JSON.stringify(open[0].args[1])}`);
});

await runCase('P3 多份计划新的在前；缺标题时退回「未命名计划」', async () => {
  const { env, tree } = await render({
    projections: { todos: [] },
    // 下发顺序故意打乱：卡片按 seq 倒序（新的在前），而不是照抄数组顺序。
    fetchImpl: plansFetch([planRow('call-old', '旧计划', 3), { callId: 'call-bare', seq: 5 }, planRow('call-new', '新计划', 9)]),
  });
  const rows = findAll(blockOf(tree, 'plan'), (node) => node.props?.['data-sc-action'] === 'open-plan');
  expect(rows.length === 3, `计划行数为 ${rows.length}`);
  expect(rows[0].props.title === '新计划', `首行应是最新的「新计划」，实际为 ${JSON.stringify(rows[0].props.title)}`);
  expect(rows[1].props.title === env.t('plan.untitled'), `缺标题的行应显示兜底文案，实际为 ${JSON.stringify(rows[1].props.title)}`);
  expect(rows[2].props.title === '旧计划', `末行应是最旧的「旧计划」，实际为 ${JSON.stringify(rows[2].props.title)}`);
});

await runCase('P4 没有计划时整块不渲染（不占位）', async () => {
  const { tree } = await render({ projections: { todos: [] }, fetchImpl: plansFetch([]) });
  expect(blockOf(tree, 'plan') === null, '没有计划仍渲染了计划块');
});

await runCase('P5 宿主没提供 sidebarRight 时计划块照常渲染，点击不抛错也不调右栏', async () => {
  const { env, tree } = await render({
    projections: { todos: [] },
    fetchImpl: plansFetch([planRow('call-1', '重建状态卡片')]),
    withSidebarRight: false,
  });
  expect(blockOf(tree, 'plan'), '缺 sidebarRight 时计划块不该消失');
  actionNode(tree, 'open-plan').props.onClick();
  await tick();
  expect(env.resources.length === 0, `缺 sidebarRight 时仍调用了右栏 ${env.resources.length} 次`);
});

/* ------------------------------------------------------------------ O. 目标块操作 */

const goalFixture = (goal) => ({ projections: { todos: [{ content: '写用例', status: 'pending' }], goal: { goal, roundsStarted: 3 } } });
const activeGoal = { id: 'goal-1', revision: 2, objective: '给卡片补目标操作', phase: 'active' };
const settled = async (env, props) => { await tick(); return expand(await pump(env.card, props)); };
const alertText = (tree) => textOf(findAll(tree, (node) => node.props?.role === 'alert')[0] ?? '');

await runCase('O1 目标有 CAS 引用且 active：出 暂停 / 编辑 / 清除 三个按钮，无「继续」', async () => {
  const { tree } = await render(goalFixture(activeGoal));
  expect(actionNode(tree, 'pause'), 'active 目标缺少暂停按钮');
  expect(actionNode(tree, 'edit'), '缺少编辑按钮');
  expect(actionNode(tree, 'trash'), '缺少清除按钮');
  expect(!actionNode(tree, 'play'), 'active 目标不该出现「继续」');
});

await runCase('O2 paused 目标出「继续」而不是「暂停」', async () => {
  const { tree } = await render(goalFixture({ ...activeGoal, phase: 'paused' }));
  expect(actionNode(tree, 'play'), 'paused 目标缺少继续按钮');
  expect(!actionNode(tree, 'pause'), 'paused 目标不该出现暂停');
});

await runCase('O3 点暂停 → remote.goals.pause(sessionId, {id, revision})', async () => {
  const { env, props, tree } = await render(goalFixture(activeGoal));
  actionNode(tree, 'pause').props.onClick();
  await settled(env, props);
  expect(env.goalCalls.length === 1, `目标调用次数为 ${env.goalCalls.length}`);
  const call = env.goalCalls[0];
  expect(call.kind === 'pause', `动作实际为 ${call.kind}`);
  expect(call.sessionId === MAIN, `会话参数实际为 ${JSON.stringify(call.sessionId)}`);
  expect(call.ref.id === 'goal-1' && call.ref.revision === 2, `CAS 引用实际为 ${JSON.stringify(call.ref)}`);
});

await runCase('O4 点编辑 → 内联 textarea 预填当前目标；保存走 edit(ref, {objective})', async () => {
  const { env, props, tree } = await render(goalFixture(activeGoal));
  actionNode(tree, 'edit').props.onClick();
  const editing = expand(await pump(env.card, props));
  const area = findAll(editing, (node) => node.type === 'textarea')[0];
  expect(area, '进入编辑态后没有 textarea');
  expect(area.props.value === activeGoal.objective, `预填值实际为 ${JSON.stringify(area.props.value)}`);
  area.props.onChange({ target: { value: '  换个说法  ' } });
  const filled = expand(await pump(env.card, props));
  actionNode(filled, 'save-goal').props.onClick();
  const after = await settled(env, props);
  const call = env.goalCalls[0];
  expect(call?.kind === 'edit', `动作实际为 ${JSON.stringify(call?.kind)}`);
  expect(call.request?.objective === '换个说法', `提交的目标没 trim：${JSON.stringify(call?.request)}`);
  expect(findAll(after, (node) => node.type === 'textarea').length === 0, '保存成功后应退出编辑态');
});

await runCase('O5 编辑态里草稿为空或全空白时保存按钮禁用', async () => {
  const { env, props, tree } = await render(goalFixture(activeGoal));
  actionNode(tree, 'edit').props.onClick();
  const editing = expand(await pump(env.card, props));
  findAll(editing, (node) => node.type === 'textarea')[0].props.onChange({ target: { value: '   ' } });
  const filled = expand(await pump(env.card, props));
  expect(actionNode(filled, 'save-goal').props.disabled === true, '空白草稿的保存按钮没有禁用');
});

await runCase('O6 Host 拒绝（GOAL_INVALID_TRANSITION）→ role=alert 原样显示错误码，不算成功', async () => {
  const goalResult = { ok: false, error: { code: 'GOAL_INVALID_TRANSITION', message: 'goal is not active' } };
  const { env, props, tree } = await render({ ...goalFixture({ ...activeGoal, phase: 'paused' }), goalResult });
  actionNode(tree, 'play').props.onClick();
  const after = await settled(env, props);
  const text = alertText(after);
  expect(text.includes('GOAL_INVALID_TRANSITION'), `错误提示里没有错误码：${JSON.stringify(text)}`);
  expect(text.includes('goal is not active'), `错误提示里没有 Host 的 message：${JSON.stringify(text)}`);
});

await runCase('O7 清除成功后目标块立即消失（等投影追平的乐观隐藏）', async () => {
  const { env, props, tree } = await render(goalFixture(activeGoal));
  expect(blockOf(tree, 'goal'), '前置条件不成立：初始应有目标块');
  actionNode(tree, 'trash').props.onClick();
  const after = await settled(env, props);
  expect(env.goalCalls[0]?.kind === 'clear', `动作实际为 ${JSON.stringify(env.goalCalls[0]?.kind)}`);
  expect(blockOf(after, 'goal') === null, '清除成功后目标块仍在（投影还没追平时会闪回旧目标）');
});

await runCase('O8 目标服务缺席（ctx.inject 没回调）→ 只读，不摆按钮也不报错', async () => {
  const { tree } = await render({ ...goalFixture(activeGoal), goalResult: null });
  expect(blockOf(tree, 'goal'), '目标服务缺席时目标块不该消失');
  const actions = ['pause', 'play', 'edit', 'trash'].filter((name) => actionNode(tree, name));
  expect(actions.length === 0, `目标服务缺席仍摆了按钮：${JSON.stringify(actions)}`);
  expect(alertText(tree) === '', '目标服务缺席时不该显示错误');
});

await runCase('O9 投影缺 id/revision 时退化为只读（不摆点不动的按钮）', async () => {
  const { tree } = await render(goalFixture({ objective: '没有 CAS 引用的目标', phase: 'active' }));
  expect(blockOf(tree, 'goal'), '目标块不该消失');
  const actions = ['pause', 'play', 'edit', 'trash'].filter((name) => actionNode(tree, name));
  expect(actions.length === 0, `缺 CAS 引用仍摆了按钮：${JSON.stringify(actions)}`);
});

/* ------------------------------------------------------------------ X（续）. 可选依赖契约 */

await runCase('X7 右栏/目标服务走 ctx.inject 惰性获取，不写进插件 inject（缺失时卡片不得整卡消失）', async () => {
  const env = setup({});
  expect(JSON.stringify(env.plugin.inject) === JSON.stringify(['slots', 'sessions', 'locale']),
    `插件 inject 被改成了 ${JSON.stringify(env.plugin.inject)}（数组 inject 全是必需项，缺服务会整卡 PENDING）`);
  const wanted = env.serviceInjections.map((deps) => deps.join(','));
  expect(wanted.includes('sidebarRight'), `ctx.inject 依赖里缺少 sidebarRight：${JSON.stringify(wanted)}`);
  expect(wanted.includes('remote,remote.goals'), `ctx.inject 依赖里缺少 remote.goals：${JSON.stringify(wanted)}`);
});

/* ------------------------------------------------------------------ E. 变更块的轮次分组 */

const changesFetch = (files, extra = {}) => () => okResponse({
  files,
  added: 0,
  deleted: 0,
  turns: 1,
  lastSeq: 4,
  lastTurn: 1,
  ...extra,
});
const fileRow = (path, turn, seq = 4, added = 3, deleted = 1) => ({ path, display: path, added, deleted, seq, index: 0, turn });
const changeText = (tree) => textOf(blockOf(tree, 'changes') ?? '');

await runCase('E1 只有一轮改动时不摆轮次分组头', async () => {
  const { tree } = await render({
    projections: { todos: [] },
    fetchImpl: changesFetch([fileRow('a.js', 1), fileRow('b.js', 1)], { lastTurn: 1 }),
  });
  const text = changeText(tree);
  expect(text.includes('a.js') && text.includes('b.js'), `变更块缺少文件行，实际：${JSON.stringify(text)}`);
  expect(!text.includes('本轮'), `单轮时不该出现「本轮」分组头：${JSON.stringify(text)}`);
  expect(!text.includes('更早改动'), `单轮时不该出现「更早改动」分组头：${JSON.stringify(text)}`);
});

await runCase('E2 多轮改动时按「本轮 / 更早」分组且本轮在前', async () => {
  const { tree } = await render({
    projections: { todos: [] },
    fetchImpl: changesFetch([fileRow('new.js', 2, 6, 9, 0), fileRow('old.js', 1, 4, 2, 3)], { lastTurn: 2, turns: 2 }),
  });
  const text = changeText(tree);
  for (const needle of ['本轮 · 1 个文件', '更早改动 · 1 个文件']) {
    expect(text.includes(needle), `变更块缺少 ${JSON.stringify(needle)}，实际：${JSON.stringify(text)}`);
  }
  const lists = findAll(blockOf(tree, 'changes'), (node) => hasClass(node, 'sc_rows'));
  expect(lists.length === 2, `应当渲染两段列表，实际 ${lists.length} 段`);
  expect(textOf(lists[0]).includes('new.js'), `本轮列表应在前，实际：${JSON.stringify(textOf(lists[0]))}`);
  expect(textOf(lists[1]).includes('old.js'), `更早列表应在后，实际：${JSON.stringify(textOf(lists[1]))}`);
});

await runCase('E3 折叠时分组只作用于展示出的行，展开后补齐更早分组', async () => {
  const files = [
    ...Array.from({ length: 8 }, (_, index) => fileRow(`new-${index + 1}.js`, 2, 6, 1, 0)),
    fileRow('old.js', 1, 3, 1, 0),
  ];
  const { env, props, tree } = await render({
    projections: { todos: [] },
    fetchImpl: changesFetch(files, { lastTurn: 2, turns: 2 }),
  });
  const collapsedText = changeText(tree);
  expect(!collapsedText.includes('更早改动'), `折叠时展示行里没有更早轮次，不该出现分组头：${JSON.stringify(collapsedText)}`);
  const more = findAll(blockOf(tree, 'changes'), (node) => hasClass(node, 'sc_more'))[0];
  expect(more, '没有出现「查看全部」入口');
  more.props.onClick();
  const expandedTree = expand(await pump(env.card, props));
  const expandedText = changeText(expandedTree);
  for (const needle of ['本轮 · 8 个文件', '更早改动 · 1 个文件']) {
    expect(expandedText.includes(needle), `展开后缺少 ${JSON.stringify(needle)}，实际：${JSON.stringify(expandedText)}`);
  }
});

/* ------------------------------------------------------------------ F. 卡片版式（Codex 式留白与高亮） */

const ruleOf = (css, selector) => cssRules(css).find((item) => item.selector === selector);
// 同一个类名可能散在多条规则里（`.sc_badge,.sc_rowBtn{…}` 定网格、`.sc_rowBtn{…}` 定尺寸），
// 按「选择器列表里含该类名」把它们的声明按顺序合并后再断言。
const ruleFor = (css, className) => {
  const bodies = cssRules(css)
    .filter((item) => item.selector.split(',').map((part) => part.trim()).includes(className))
    .map((item) => item.body);
  return bodies.length === 0 ? undefined : { selector: className, body: bodies.join(';') };
};

await runCase('F1 卡片尺寸与内边距符合 Codex 式留白（372 宽、16 内边距）', async () => {
  const { env } = await render({ projections: { todos: [] } });
  const decls = cssDecls(ruleOf(env.css, '.sc_card')?.body ?? '');
  expect(decls.width === '372px', `.sc_card 宽度为 ${JSON.stringify(decls.width)}，挤不挤全靠它`);
  expect(decls['--sc-pad'] === '16px', `.sc_card 内边距为 ${JSON.stringify(decls['--sc-pad'])}`);
  const row = cssDecls(ruleFor(env.css, '.sc_rowBtn')?.body ?? '');
  expect(row['min-height'] === '28px', `行高为 ${JSON.stringify(row['min-height'])}，28px 才有 Codex 那种呼吸感`);
  const lead = cssDecls(ruleFor(env.css, '.sc_rowLead')?.body ?? '');
  expect(lead.width === '16px' && lead.height === '16px', `图标列应为 16px 见方，实际 ${JSON.stringify([lead.width, lead.height])}`);
});

await runCase('F2 分区用 1px 细线 + 14px 间距分段，第一个分区不画线（不留双线）', async () => {
  const { env } = await render({ projections: { todos: [] } });
  const block = cssDecls(ruleOf(env.css, '.sc_block')?.body ?? '');
  expect((block['border-top'] ?? '').includes('1px solid'), `.sc_block 没有细分隔线：${JSON.stringify(block['border-top'])}`);
  expect(block['margin-top'] === '12px', `.sc_block 上方间距为 ${JSON.stringify(block['margin-top'])}`);
  const first = cssDecls(ruleOf(env.css, '.sc_block:first-of-type')?.body ?? '');
  expect(first['border-top'] === 'none', '缺少 .sc_block:first-of-type 覆盖：卡片首段会多出一条悬空的分隔线');
});

await runCase('F3 可点行 hover 胶囊向两侧各溢出 6px（整行高亮而不是只亮文字）', async () => {
  const { env } = await render({ projections: { todos: [] } });
  const btn = cssDecls(ruleFor(env.css, '.sc_rowBtn')?.body ?? '');
  expect(btn['width'] === 'calc(100% + 12px)', `.sc_rowBtn 宽度为 ${JSON.stringify(btn['width'])}`);
  expect(btn['margin'] === '0 -6px', `.sc_rowBtn 负边距为 ${JSON.stringify(btn['margin'])}`);
  expect((btn['padding'] ?? '').startsWith('0 6px'), `.sc_rowBtn 内边距为 ${JSON.stringify(btn['padding'])}，需与负边距对称`);
});

await runCase('F4 变更合计单独成块并加粗（+added / -deleted 是整卡最醒目的数字）', async () => {
  const { env, tree } = await render({
    projections: { todos: [] },
    fetchImpl: changesFetch([fileRow('a.js', 1, 4, 1200, 34)], { added: 1200, deleted: 34 }),
  });
  const total = findAll(blockOf(tree, 'changes'), (node) => node.props?.['data-sc-total'] === 'changes')[0];
  expect(total, '变更块里没有独立的合计块（data-sc-total="changes"）');
  expect(hasClass(total, 'sc_total'), '合计块缺少 sc_total class');
  const nums = findAll(total, (node) => hasClass(node, 'sc_num'));
  expect(nums.length === 2, `合计块里应有增、删两个数值，实际 ${nums.length} 个`);
  expect(textOf(total) === '+1,200-34', `合计文本为 ${JSON.stringify(textOf(total))}`);
  expect(nums.every((node) => hasClass(node, 'sc_add') || hasClass(node, 'sc_del')), '合计数值丢了增删配色 class');
  const decls = cssDecls(ruleOf(env.css, '.sc_total .sc_num')?.body ?? '');
  expect(decls['font-weight'] === '600', `.sc_total .sc_num 的字重为 ${JSON.stringify(decls['font-weight'])}，没有加粗就不算高亮`);
});

await runCase('F5 增删数字用 marker 前景色 token（alpha 底色 token 会把数字画成透明）', async () => {
  const { env } = await render({ projections: { todos: [] } });
  const addColor = cssDecls(ruleOf(env.css, '.sc_add')?.body ?? '').color ?? '';
  const delColor = cssDecls(ruleOf(env.css, '.sc_del')?.body ?? '').color ?? '';
  expect(addColor.includes('--dsw-alias-file-diff-added-marker'), `.sc_add 用的是 ${JSON.stringify(addColor)}`);
  expect(delColor.includes('--dsw-alias-file-diff-deleted-marker'), `.sc_del 用的是 ${JSON.stringify(delColor)}`);
  for (const name of [addColor, delColor]) {
    expect(!name.includes('--dsw-alias-code-diff-'), `${JSON.stringify(name)} 是 8%~12% 透明的底色 token，不能当文字色`);
  }
});

await runCase('F6 色阶收敛为 strong/fg/weak 三档，不再用 caption 与 dimmed（对比度太低）', async () => {
  const { env } = await render({ projections: { todos: [] } });
  for (const banned of ['--dsw-alias-label-caption', '--dsw-alias-label-dimmed']) {
    expect(!env.css.includes(banned), `样式里还在用 ${banned}：浅色底上几乎看不见`);
  }
  const decls = cssDecls(ruleOf(env.css, '.sc_card')?.body ?? '');
  const wanted = {
    '--sc-fg-strong': 'var(--dsw-alias-label-primary)',
    '--sc-fg': 'var(--dsw-alias-label-secondary)',
    '--sc-fg-weak': 'var(--dsw-alias-label-tertiary)',
  };
  for (const [name, value] of Object.entries(wanted)) {
    expect(decls[name] === value, `${name} 为 ${JSON.stringify(decls[name])}，期望 ${value}`);
  }
});

await runCase('F7 成员卡、数据行共用同一套三列网格，分组头保持 -6px 缩进（元素对齐）', async () => {
  const { env } = await render({ projections: { todos: [] } });
  for (const cls of ['.sc_rowInner', '.sc_rowBtn']) {
    const decls = cssDecls(ruleFor(env.css, cls)?.body ?? '');
    expect(decls['grid-template-columns'] === '16px minmax(0,1fr) auto',
      `${cls} 的网格为 ${JSON.stringify(decls['grid-template-columns'])}，三列（16px 图标列 · 弹性文本 · 右对齐数值）必须一致`);
    expect(decls.display === 'grid', `${cls} 没有走 grid 布局`);
  }
  // 成员卡是四列：状态圆点 · 弹性文本 · 右对齐指标 · 展开箭头（与官方子智能体目录行同构）。
  const member = cssDecls(ruleFor(env.css, '.sc_member')?.body ?? '');
  expect(member['grid-template-columns'] === 'auto minmax(0,1fr) auto 12px',
    `成员卡网格为 ${JSON.stringify(member['grid-template-columns'])}，应是圆点列 · 弹性文本 · 指标列 · 箭头列`);
  expect(member.display === 'grid', '成员卡没有走 grid 布局');
  const head = cssDecls(ruleFor(env.css, '.sc_blockHead')?.body ?? '');
  expect(head.margin === '0 -6px', `分组头左边距为 ${JSON.stringify(head.margin)}，要与数据行的 -6px 对齐`);
  expect(head.padding === '0 6px', `分组头内边距为 ${JSON.stringify(head.padding)}`);
});

await runCase('F8 图标尺寸收敛（勾选 14 / 成员箭头 12 / 行内 14 / 顶栏按钮 16），不再出现随手值', async () => {
  const { env, tree } = await render(richOpts());
  const icon = cssDecls(ruleFor(env.css, '.sc_icon')?.body ?? '');
  expect(icon.width === '14px' && icon.height === '14px',
    `.sc_icon 的基准尺寸为 ${JSON.stringify([icon.width, icon.height])}，行内图标应为 14px`);
  const svgs = findAll(tree, (node) => hasClass(node, 'sc_icon'));
  expect(svgs.length > 0, '卡片里一个图标都没渲染');
  const sizes = [...new Set(svgs.map((node) => `${node.props.width}x${node.props.height}`))];
  const allowed = ['10x10', '12x12', '14x14', '16x16'];
  const stray = sizes.filter((size) => !allowed.includes(size));
  expect(stray.length === 0, `出现计划外的图标尺寸：${JSON.stringify(stray)}（允许 ${allowed.join(' / ')}）`);
  expect(sizes.includes('14x14'), `行内图标没渲染成 14px，实际 ${JSON.stringify(sizes)}`);
});

await runCase('F9 顶栏：会话标题作副标题 + 刷新/收起两个圆形按钮（折叠后只剩一颗按钮）', async () => {
  const { env, props, tree } = await render({ projections: { todos: [] }, sessionTitle: '状态卡片接管系统组件' });
  const head = findAll(tree, (node) => hasClass(node, 'sc_head'))[0];
  expect(head, '没有 .sc_head 顶栏');
  expect(findAll(head, (node) => hasClass(node, 'sc_tile')).length === 0, '顶栏不该再有图标砖');
  const subtitles = findAll(head, (node) => hasClass(node, 'sc_subtitle'));
  expect(subtitles.length === 1, `副标题数量为 ${subtitles.length}`);
  expect(textOf(subtitles[0]) === '状态卡片接管系统组件', `副标题文本为 ${JSON.stringify(textOf(subtitles[0]))}`);
  const squares = findAll(head, (node) => hasClass(node, 'sc_square'));
  expect(squares.length === 2, `头部按钮数量为 ${squares.length}`);
  expect(findAll(head, (node) => node.props?.['data-sc-action'] === 'refresh').length === 1, '缺少刷新按钮');
  expect(findAll(head, (node) => node.props?.['data-sc-action'] === 'toggle-card').length === 1, '缺少收起按钮');
  // 圆形按钮：无描边 + 全圆角，与宿主图标按钮同一手感。
  const squareRule = cssDecls(ruleOf(env.css, '.sc_square')?.body ?? '');
  expect(squareRule['border-radius'] === '999px', `.sc_square 圆角为 ${JSON.stringify(squareRule['border-radius'])}`);
  expect(squareRule.border === '1px solid var(--sc-line)',
    `.sc_square 描边为 ${JSON.stringify(squareRule.border)}，应与宿主图标按钮同款（1px 细描边圆形）`);

  const toggle = actionNode(tree, 'toggle-card');
  toggle.props.onClick();
  const collapsed = expand(await pump(env.card, props));
  // 折叠后卡片整块缩到右上角藏起来，只剩一颗圆钮接管。
  expect(anchorStateOf(collapsed) === 'fab', `折叠后 data-state 实际为 ${JSON.stringify(anchorStateOf(collapsed))}`);
  expect(hiddenCardOf(collapsed), '折叠后卡片应被 CSS 藏起来（aria-hidden + visibility:hidden）');
  const fab = findAll(collapsed, (node) => hasClass(node, 'sc_fab'))[0];
  expect(fab, '折叠态没有圆钮');
  expect(findAll(fab, (node) => hasClass(node, 'sc_icon')).length === 1, '圆钮里应只有一颗图标');
  const fabRule = cssDecls(ruleOf(env.css, '.sc_fab')?.body ?? '');
  // 圆钮渲染在 .sc_card 之外，取不到卡片局部变量，必须直接用全局 token。
  expect(fabRule['border-radius'] === '999px' && fabRule.border === '1px solid var(--dsw-alias-border-l2)',
    `圆钮样式为 ${JSON.stringify([fabRule['border-radius'], fabRule.border])}，应与宿主回到底部按钮同款`);
  expect(fabRule.color === 'var(--dsw-alias-label-primary)',
    `圆钮前景色为 ${JSON.stringify(fabRule.color)}，不能引用 .sc_card 上的局部变量`);
  // 伸缩动画：卡片绕「收起按钮中心」缩放，圆钮绕自身中心缩放 —— 两点必须重合，收放才像一颗按钮在原地变身。
  const cardRule = cssDecls(ruleOf(env.css, '.sc_card')?.body ?? '');
  const origin = cardRule['transform-origin'] ?? '';
  const originMatch = /^calc\(100% - ([\d.]+)px\) ([\d.]+)px$/.exec(origin);
  expect(originMatch, `卡片 transform-origin 为 ${JSON.stringify(origin)}，应写成 calc(100% - Npx) Npx（= 收起按钮中心）`);
  expect(/transform/.test(cardRule.transition ?? ''), `卡片过渡为 ${JSON.stringify(cardRule.transition)}，应包含 transform`);
  expect(fabRule['transform-origin'] === 'center' && /transform/.test(fabRule.transition ?? ''),
    `圆钮过渡为 ${JSON.stringify([fabRule['transform-origin'], fabRule.transition])}，应绕自身中心缩放`);

  // 圆钮尺寸 + 定位必须让它的中心正好压在那颗收起按钮的中心上。
  const fabSize = Number.parseFloat(fabRule.width ?? '0');
  const headRule = cssDecls(ruleOf(env.css, '.sc_head')?.body ?? '');
  const padTop = Number.parseFloat((headRule.padding ?? '').split(' ')[0] ?? '0');
  const padRight = Number.parseFloat((headRule.padding ?? '').split(' ')[1] ?? '0');
  const buttonSize = Number.parseFloat(squareRule.width ?? '0');
  const cardBorder = Number.parseFloat(cardRule.border ?? '0');
  // 按钮必须贴在头部内边距的顶端（align-items:flex-start），否则标题/副标题一变高，按钮就被居中推下去，
  // 静态的 transform-origin 立刻和圆钮不同心 —— 真机上正是这样差了 4.5px。
  expect(headRule['align-items'] === 'flex-start',
    `.sc_head 的 align-items 为 ${JSON.stringify(headRule['align-items'])}，必须是 flex-start，按钮位置才可预测`);
  const buttonCenterRight = cardBorder + padRight + buttonSize / 2;
  const buttonCenterTop = cardBorder + padTop + buttonSize / 2;
  expect(Math.abs(Number.parseFloat(originMatch[1]) - buttonCenterRight) < 0.01
    && Math.abs(Number.parseFloat(originMatch[2]) - buttonCenterTop) < 0.01,
    `卡片缩放原点 ${JSON.stringify([originMatch[1], originMatch[2]])} 与收起按钮中心 ${JSON.stringify([buttonCenterRight, buttonCenterTop])} 不重合`);
  const fabCenterRight = Number.parseFloat(fabRule.right ?? '0') + fabSize / 2;
  const fabCenterTop = Number.parseFloat(fabRule.top ?? '0') + fabSize / 2;
  expect(Math.abs(fabCenterRight - buttonCenterRight) < 0.01 && Math.abs(fabCenterTop - buttonCenterTop) < 0.01,
    `折叠圆钮中心 ${JSON.stringify([fabCenterRight, fabCenterTop])} 与收起按钮中心 ${JSON.stringify([buttonCenterRight, buttonCenterTop])} 不重合：收放时会跳位`);
  expect(/prefers-reduced-motion/.test(env.css), '缺少 prefers-reduced-motion 降级，系统关动画时会硬切');

  // 宿主没给会话标题时退回固定文案，避免顶栏只剩一个大标题。
  const fallback = await render({ projections: { todos: [] } });
  const plainHead = findAll(fallback.tree, (node) => hasClass(node, 'sc_head'))[0];
  const plainSubtitle = findAll(plainHead, (node) => hasClass(node, 'sc_subtitle'))[0];
  expect(plainSubtitle && textOf(plainSubtitle) === 'Agent 工作区', `没有副标题时回退为 ${JSON.stringify(textOf(plainSubtitle))}`);
});

await runCase('F10 任务进度条按完成率换算（4/4 → 100%、2/4 → 50%），勾选圆三态与官方任务面板一致', async () => {
  const all = await render({ projections: { todos: [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'completed' },
    { content: '丙', status: 'completed' },
    { content: '丁', status: 'completed' },
  ] } });
  const block = blockOf(all.tree, 'task');
  const bar = findAll(block, (node) => hasClass(node, 'sc_progress'))[0];
  expect(bar, '任务块没有进度条');
  expect(bar.props['data-sc-progress'] === 100, `满进度为 ${JSON.stringify(bar.props['data-sc-progress'])}`);
  expect(bar.props['aria-valuenow'] === 100, `aria-valuenow 为 ${JSON.stringify(bar.props['aria-valuenow'])}`);
  const fill = findAll(bar, (node) => hasClass(node, 'sc_progressFill'))[0];
  expect(fill && fill.props.style.width === '100%', `填充宽度为 ${JSON.stringify(fill?.props?.style)}`);
  const checks = findAll(block, (node) => hasClass(node, 'sc_check'));
  expect(checks.length === 4 && checks.every((node) => node.props['data-state'] === 'done'),
    `全完成时四条勾选圆应都是 done，实际 ${JSON.stringify(checks.map((node) => node.props['data-state']))}`);

  const half = await render({ projections: { todos: [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'completed' },
    { content: '丙', status: 'in_progress' },
    { content: '丁', status: 'pending' },
  ] } });
  const halfBlock = blockOf(half.tree, 'task');
  const halfBar = findAll(halfBlock, (node) => hasClass(node, 'sc_progress'))[0];
  expect(halfBar.props['data-sc-progress'] === 50, `2/4 的进度为 ${JSON.stringify(halfBar.props['data-sc-progress'])}`);
  expect(findAll(halfBar, (node) => hasClass(node, 'sc_progressFill'))[0].props.style.width === '50%', '2/4 的填充宽度不是 50%');
  const states = findAll(halfBlock, (node) => hasClass(node, 'sc_check')).map((node) => node.props['data-state']);
  expect(states.join(',') === 'done,done,running,idle', `勾选圆三态为 ${JSON.stringify(states.join(','))}`);
});

await runCase('F11 计划行不铺底色（与上方内容同宽）：行首无图标、右侧外链图标，仍是官方 plan 预览入口', async () => {
  const { env, tree } = await render({ projections: { todos: [] }, fetchImpl: plansFetch([planRow('call-1', '重建状态卡片')]) });
  const row = actionNode(tree, 'open-plan');
  expect(row, '计划行不是可点节点');
  expect(hasClass(row, 'sc_planRow'), '计划行没有走卡式样式（sc_planRow）');
  const svgs = findAll(row, (node) => node.type === 'svg');
  expect(svgs.length === 2, `计划行应有 2 颗图标（行首灯泡 + 右端外链），实际 ${svgs.length}`);
  const bulb = findAll(row, (node) => hasClass(node, 'sc_planIcon'));
  expect(bulb.length === 1, '计划行缺少行首的灯泡图标');
  expect(textOf(bulb[0]) === '' && findAll(bulb[0], (node) => node.type === 'svg').length === 1,
    '灯泡应是纯图标节点');
  // 灯泡是线性的（用户否掉了实心版），灯罩 + 灯座 + 周围闪光点一共 8 条路径。
  const bulbSvg = findAll(bulb[0], (node) => node.type === 'svg')[0];
  expect(bulbSvg.props.fill === 'none', `灯泡不该画成实心，实际 fill=${JSON.stringify(bulbSvg.props.fill)}`);
  expect(findAll(bulb[0], (node) => node.type === 'path').length === 8,
    `灯泡应为「灯罩 + 2 条灯座 + 5 颗闪光点」，实际路径数 ${findAll(bulb[0], (node) => node.type === 'path').length}`);
  expect(bulb[0].props['aria-hidden'] === undefined || bulb[0].props['aria-hidden'] === 'true',
    '灯泡是装饰性图标，不该占用无障碍名');
  const kids = (row.props.children ?? []).flat(Infinity).filter((node) => node && typeof node === 'object');
  expect(hasClass(kids[0], 'sc_planIcon'), '灯泡要在行内最左边（第一颗子节点）');
  const bulbBox = cssDecls(ruleOf(env.css, '.sc_planIcon')?.body ?? '');
  expect(bulbBox.color === 'var(--sc-accent)', `灯泡颜色应走强调色 token，实际 ${JSON.stringify(bulbBox.color)}`);
  // 发光：两层 drop-shadow 光晕（一层太硬、像投影）。
  const glow = String(bulbBox.filter ?? '');
  expect((glow.match(/drop-shadow\(0 0 \d+px var\(--sc-accent\)\)/gu) ?? []).length >= 2,
    `灯泡要有柔光晕（两层 accent drop-shadow），实际 ${JSON.stringify(glow)}`);
  expect(findAll(row, (node) => hasClass(node, 'sc_planLabel')).length === 1, '计划行缺少标题');
  expect(textOf(row).includes('重建状态卡片'), `计划行文本为 ${JSON.stringify(textOf(row))}`);
  const decls = cssDecls(ruleOf(env.css, '.sc_planRow')?.body ?? '');
  // 计划不再自带底色（上层要求去掉），宽高按内容对齐：-6px 外边距 + 6px 内边距，悬停才浮出胶囊。
  expect(!String(decls.background ?? '').includes('--sc-surface'),
    `.sc_planRow 不该再铺底色，实际 ${JSON.stringify(decls.background)}`);
  expect(decls.width === 'calc(100% + 12px)' && decls.margin === '1px -6px 0' && decls.padding === '4px 6px',
    `计划行应撑到内容宽，实际 ${JSON.stringify([decls.width, decls.margin, decls.padding])}`);
  expect(decls.color === 'var(--sc-fg-strong)', `.sc_planRow 字色为 ${JSON.stringify(decls.color)}`);
  // 目标正文同样不铺底色，裸文本与内容同左缘。
  const goal = cssDecls(ruleOf(env.css, '.sc_goal')?.body ?? '');
  expect(!String(goal.background ?? '').includes('--sc-surface'),
    `.sc_goal 不该再铺底色，实际 ${JSON.stringify(goal.background)}`);
  expect(goal.padding === '0', `.sc_goal 不该再留内边距，实际 ${JSON.stringify(goal.padding)}`);
});

/** 子智能体行 fixture：label / 任务行 / 模式 / token / 耗时都对得上官方子智能体目录行。 */
const agentOpts = () => ({
  projections: { todos: [] },
  subagents: [
    {
      id: 'sub-a',
      title: '接线宿主',
      running: false,
      sessionTitle: '任务：只做调研，不改任何文',
      projections: {
        subagent: { mode: 'continuable', label: '调研计划文件与侧栏预览通道', seq: 1 },
        // 四桶合计 4.8M：1.2M 未缓存输入 + 0.8M 输出 + 2.4M 缓存读 + 0.4M 缓存写。
        tokenUsage: {
          uncachedInputTokens: 1200000,
          outputTokens: 800000,
          cacheReadTokens: 2400000,
          cacheWriteTokens: 400000,
        },
        subagentTiming: { settledMs: 213000, lastTurnCompleted: true },
      },
    },
    {
      id: 'sub-b',
      title: '回归检查',
      running: true,
      projections: {
        subagent: { mode: 'one-shot', label: '跑回归', seq: 2 },
        subagentTiming: { settledMs: 30000, active: { since: Date.now() - 5000 } },
      },
    },
  ],
});

await runCase('F12 子智能体行与官方目录行同构：label 主行 + 任务·模式·活动副行 + token/耗时两行指标', async () => {
  const { env, tree } = await render(agentOpts());
  const block = blockOf(tree, 'agents');
  expect(block, '没有渲染 data-sc-block=agents 的子智能体块');
  const rows = findAll(block, (node) => hasClass(node, 'sc_member'));
  expect(rows.length === 2, `成员卡数量为 ${rows.length}`);
  expect(findAll(block, (node) => hasClass(node, 'sc_ordinal')).length === 0, '成员卡不该再有序号圆');
  const text = textOf(block);
  expect(!text.includes('空闲'), `成员卡不该再显示「空闲」状态，实际：${JSON.stringify(text)}`);
  // 主行是 spawn 时给的 label，不是「子智能体 01」这种拼出来的标题。
  const names = rows.map((row) => textOf(findAll(row, (node) => hasClass(node, 'sc_memberName'))[0]));
  expect(names.join('|') === '调研计划文件与侧栏预览通道|跑回归', `主行应是子智能体的 label，实际为 ${JSON.stringify(names)}`);
  // 副行 = 会话标题 · 可继续 · 已完成（顺序与官方一致）。
  const lines = rows.map((row) => textOf(findAll(row, (node) => hasClass(node, 'sc_memberDesc'))[0]));
  expect(lines[0] === '任务：只做调研，不改任何文 · 可继续 · 已完成', `副行实际为 ${JSON.stringify(lines[0])}`);
  // 第二行没有 durable 标题（= 会话标题就是 displayTitle 时的退化形态），副行只剩模式与活动。
  expect(lines[1] === '一次性 · 正在运行', `副行实际为 ${JSON.stringify(lines[1])}`);
  // 右端指标是两行：token 一行、耗时一行（不并成一行），都靠右。
  const tokens = rows.map((row) => textOf(findAll(row, (node) => hasClass(node, 'sc_metrics'))[0] ?? { props: {} }));
  const durations = rows.map((row) => textOf(findAll(row, (node) => hasClass(node, 'sc_metricsSub'))[0] ?? { props: {} }));
  expect(tokens[0] === '4.8M tok', `token 行为 ${JSON.stringify(tokens[0])}`);
  expect(durations[0] === '3分33秒', `耗时行为 ${JSON.stringify(durations[0])}`);
  // 没有 tokenUsage 投影时不摆空的 token 行；30s 已结算 + 5s 活跃窗（按渲染时刻算）。
  expect(tokens[1] === '', `没有 token 数据时不该有空行，实际为 ${JSON.stringify(tokens[1])}`);
  expect(/^3[5-9]秒$/u.test(durations[1]), `没有 token 数据时耗时行为 ${JSON.stringify(durations[1])}`);
  const tail = cssDecls(ruleOf(env.css, '.sc_memberTail')?.body ?? '');
  expect(tail['flex-direction'] === 'column' && tail['align-items'] === 'flex-end',
    `指标列应为两行靠右堆叠，实际 ${JSON.stringify([tail['flex-direction'], tail['align-items']])}`);
  // 圆点语义：已完成 → done，正在运行 → running。
  const marks = rows.map((row) => findAll(row, (node) => hasClass(node, 'sc_mark'))[0].props['data-state']);
  expect(marks.join() === 'done,running', `圆点状态为 ${JSON.stringify(marks)}`);
  // 行本身不再各带一块底色：靠 -6px 外边距 + 6px 内边距让内容与分区标题同左缘，行间用一条 inset 细线。
  const member = cssDecls(ruleOf(env.css, '.sc_member')?.body ?? '');
  expect(!String(member.background ?? '').includes('--sc-surface'),
    `子智能体行不该再自带底色，实际 background: ${JSON.stringify(member.background)}`);
  expect(member.width === 'calc(100% + 12px)' && member.margin === '0 -6px 2px' && member.padding === '6px',
    `行宽应撑到内容宽（-6px 外边距 + 6px 内边距），实际 ${JSON.stringify([member.width, member.margin, member.padding])}`);
  // 同一块里的多条记录之间不加分隔线（用户明确说丑），靠 2px 行距 + 悬停胶囊区分。
  expect(!/\.sc_row \+ \.sc_row/u.test(env.css), '内容区里多条记录之间不该再加分隔线');
  expect(member.margin === '0 -6px 2px', `行距应靠外边距给，实际 ${JSON.stringify(member.margin)}`);
  // 每张子智能体卡都有右端箭头（可打开的入口），分区标题旁仍有计数 pill。
  expect(findAll(block, (node) => hasClass(node, 'sc_memberChevron')).length === 2, '成员卡缺少右端箭头');
  const count = findAll(block, (node) => hasClass(node, 'sc_countPill'))[0];
  expect(textOf(count) === '2', `计数 pill 为 ${JSON.stringify(textOf(count))}`);
});

await runCase('F19 子智能体按委派轮次分组：当前轮摊开、早前轮折成一行、点开才逐轮列出', async () => {
  const roundsOpts = () => ({
    ...agentOpts(),
    fetchImpl: changesFetch([], {
      timing: { turn: 2, modelMs: 1000, toolMs: 0, waitMs: 0, waitSince: null },
      // 宿主随路由下发「子会话 → 它被派生的轮次」。
      subagentTurns: { 'sub-a': 1, 'sub-b': 2 },
    }),
  });
  const memberNames = (root) => findAll(root, (node) => hasClass(node, 'sc_member'))
    .map((row) => textOf(findAll(row, (node) => hasClass(node, 'sc_memberName'))[0]));
  const { env, props, tree } = await render(roundsOpts());
  const block = blockOf(tree, 'agents');
  expect(block, '没有渲染 data-sc-block=agents 的子智能体块');
  // 当前轮（第 2 轮）只摊开 sub-b；第 1 轮的 sub-a 先折起来。
  expect(memberNames(block).join('|') === '跑回归', `当前轮只该摊开本轮的行，实际 ${JSON.stringify(memberNames(block))}`);
  expect(textOf(block).includes('本轮 · 1 个'), `当前轮分组头缺失，实际 ${JSON.stringify(textOf(block))}`);
  // 标题旁的计数始终是总数（不随折叠变），与「队友 2 · 任务 1/3」同在一条分隔线上。
  const pill = findAll(block, (node) => hasClass(node, 'sc_countPill'))[0];
  expect(textOf(pill) === '2', `计数 pill 应是总数 2，实际 ${JSON.stringify(textOf(pill))}`);
  const toggle = actionNode(block, 'toggle-agent-rounds');
  expect(toggle, '没有「早前轮次」折叠按钮');
  expect(textOf(toggle) === '早前 1 轮 · 1 个', `折叠按钮文案为 ${JSON.stringify(textOf(toggle))}`);
  expect(toggle.props['aria-expanded'] === false, `默认应是折叠态，aria-expanded 实际为 ${JSON.stringify(toggle.props['aria-expanded'])}`);

  toggle.props.onClick();
  const openedBlock = blockOf(expand(await pump(env.card, props)), 'agents');
  expect(memberNames(openedBlock).join('|') === '跑回归|调研计划文件与侧栏预览通道',
    `展开后应先当前轮再第 1 轮，实际 ${JSON.stringify(memberNames(openedBlock))}`);
  expect(textOf(openedBlock).includes('第 1 轮'), `展开后缺少轮次分组头，实际 ${JSON.stringify(textOf(openedBlock))}`);
  expect(textOf(actionNode(openedBlock, 'toggle-agent-rounds')).includes('收起'), '展开后按钮应变成「收起」');
  actionNode(openedBlock, 'toggle-agent-rounds').props.onClick();
  expect(memberNames(blockOf(expand(await pump(env.card, props)), 'agents')).length === 1, '再点一次没有折回当前轮');

  // 宿主没下发轮次归属（老版本 / 还没扫到）：退回平铺，不摆分组头也不摆折叠按钮。
  const flat = await render({ ...agentOpts(), fetchImpl: changesFetch([]) });
  const flatBlock = blockOf(flat.tree, 'agents');
  expect(memberNames(flatBlock).length === 2, `没有轮次归属时应平铺两行，实际 ${JSON.stringify(memberNames(flatBlock))}`);
  expect(findAll(flatBlock, (node) => hasClass(node, 'sc_group')).length === 0, '没有轮次归属时不该摆分组头');
  expect(actionNode(flatBlock, 'toggle-agent-rounds') === undefined, '没有轮次归属时不该摆折叠按钮');
});

await runCase('F21 后台任务块：结构照宿主面板、运行中常显、已结束折叠、停止走两段确认', async () => {
  const now = Date.now();
  const jobRow = (over) => ({
    kind: 'bash',
    output: { total: 0, earliest: 0 },
    ...over,
  });
  const rows = [
    jobRow({ id: 'job-live', label: 'pnpm run dev', status: 'running', startedAt: now - 5000, progress: '3/10' }),
    jobRow({ id: 'job-ok', label: 'pnpm test', status: 'completed', startedAt: now - 90000, finishedAt: now - 45000, detail: 'exit code: 0' }),
    jobRow({ id: 'job-bad', label: 'pnpm run lint', status: 'failed', startedAt: now - 60000, finishedAt: now - 59000, detail: 'exit code: 3' }),
  ];
  const { env, props, tree } = await render({ projections: {}, jobsRows: rows });
  const block = blockOf(tree, 'jobs');
  expect(block, '没有渲染 data-sc-block=jobs 的后台任务块');
  expect(textOf(block).includes('后台任务'), `块标题缺失，实际 ${JSON.stringify(textOf(block))}`);
  // 标题旁的计数与宿主面板同措辞。
  expect(textOf(block).includes('1 个后台任务运行中'), `运行中计数文案不对，实际 ${JSON.stringify(textOf(block))}`);
  // 只有活行常显，且是宿主面板那种「铺底 + 两行」的排布。
  const liveLine = findAll(block, (node) => hasClass(node, 'sc_jobLine') && node.props['data-live'] === 'true');
  expect(liveLine.length === 1, `应只有一条运行中的行，实际 ${liveLine.length}`);
  const liveText = textOf(liveLine[0]);
  expect(liveText.includes('pnpm run dev'), `活行没显示命令，实际 ${JSON.stringify(liveText)}`);
  expect(liveText.includes('3/10'), `活行没显示宿主进度，实际 ${JSON.stringify(liveText)}`);
  // 类型标签、等宽命令、进度、时长各就各位（与官方面板的行内构成一致）。
  expect(findAll(liveLine[0], (node) => hasClass(node, 'sc_jobKind')).length === 1, '活行缺少类型标签');
  expect(findAll(liveLine[0], (node) => hasClass(node, 'sc_jobLabel')).length === 1, '活行缺少等宽命令行');
  expect(findAll(liveLine[0], (node) => hasClass(node, 'sc_jobSecondary')).length === 1, '活行缺少副行');
  expect(textOf(findAll(liveLine[0], (node) => hasClass(node, 'sc_jobDuration'))[0]).includes('5秒'),
    `活行时长应为 5秒，实际 ${JSON.stringify(textOf(liveLine[0]))}`);
  // 「停止」是 20×20 的方形图标按钮（不是文字胶囊），初态不带文字。
  const stopNode = actionNode(block, 'stop-job');
  expect(stopNode, '运行中的行没有停止按钮');
  expect(stopNode.props['data-kill-state'] === 'idle', `初态应为 idle，实际 ${JSON.stringify(stopNode.props['data-kill-state'])}`);
  expect(textOf(stopNode) === '', `初态按钮只该有一颗图标，实际 ${JSON.stringify(textOf(stopNode))}`);
  expect(findAll(stopNode, (node) => node.type === 'svg').length === 1, '停止按钮里没有方形图标');
  expect(stopNode.props.title.includes('pnpm run dev'), `按钮 title 该带上命令，实际 ${JSON.stringify(stopNode.props.title)}`);

  // 分组头：折叠开关 + 清空，箭头闭上时指右。
  const section = findAll(block, (node) => hasClass(node, 'sc_jobSection'))[0];
  expect(section, '没有「已结束」分组头');
  const toggle = actionNode(block, 'toggle-settled-jobs');
  expect(toggle, '分组头里没有折叠开关');
  expect(textOf(toggle) === '已结束 2', `折叠开关文案为 ${JSON.stringify(textOf(toggle))}`);
  expect(toggle.props['aria-expanded'] === false, '默认应是折叠态');
  const chevron = findAll(toggle, (node) => hasClass(node, 'sc_jobChevron'))[0];
  expect(chevron?.props['data-open'] === 'false', `折叠时箭头应为闭合态，实际 ${JSON.stringify(chevron?.props['data-open'])}`);
  expect(actionNode(block, 'clear-settled-jobs'), '分组头里没有「清空」');

  toggle.props.onClick();
  const opened = blockOf(expand(await pump(env.card, props)), 'jobs');
  expect(findAll(opened, (node) => hasClass(node, 'sc_jobLine')).length === 3, '展开后应铺开全部三行');
  expect(textOf(opened).includes('exit code: 3'), `已结束行应显示结算原因，实际 ${JSON.stringify(textOf(opened))}`);
  expect(findAll(opened, (node) => hasClass(node, 'sc_jobChevron'))[0].props['data-open'] === 'true', '展开后箭头应转正');
  // 已结束的行是单行弱色、且不再有停止按钮。
  const settledLine = findAll(opened, (node) => hasClass(node, 'sc_jobRow') && node.props['data-settled'] === 'true');
  expect(settledLine.length === 2, `已结束的行应为 2 条，实际 ${settledLine.length}`);
  expect(findAll(settledLine[0], (node) => hasClass(node, 'sc_stop')).length === 0, '已结束的行不该有停止按钮');

  // 两段确认：第一下只上膛（按钮展开成「确认停止」），第二下才真的发 kill。
  actionNode(opened, 'stop-job').props.onClick();
  const armed = blockOf(expand(await pump(env.card, props)), 'jobs');
  const armedStop = actionNode(armed, 'stop-job');
  expect(armedStop.props['data-kill-state'] === 'armed', `上膛态应为 armed，实际 ${JSON.stringify(armedStop.props['data-kill-state'])}`);
  expect(textOf(armedStop) === '确认停止', `上膛后按钮应显示「确认停止」，实际 ${JSON.stringify(textOf(armedStop))}`);
  expect(env.jobKills.length === 0, `第一下不该发给服务，实际 ${JSON.stringify(env.jobKills)}`);
  armedStop.props.onClick();
  await tick();
  const killed = blockOf(expand(await pump(env.card, props)), 'jobs');
  expect(env.jobKills.length === 1, `应只发一次停止，实际 ${JSON.stringify(env.jobKills)}`);
  expect(env.jobKills[0].jobId === 'job-live', `停止的对象不对，实际 ${JSON.stringify(env.jobKills[0])}`);
  expect(env.jobKills[0].sessionId === MAIN, `停止没带主会话 id，实际 ${JSON.stringify(env.jobKills[0])}`);
  expect(env.jobWatched.includes(MAIN), `roster 流没为本会话打开，实际 ${JSON.stringify(env.jobWatched)}`);
  expect(actionNode(killed, 'stop-job').props['data-kill-state'] === 'idle', '成功后按钮应回到 idle');

  // 服务回 ok:false：按钮进入 failed 态，不假装成功。
  const failing = await render({ projections: {}, jobsRows: [rows[0]], jobKillResult: { ok: false } });
  actionNode(blockOf(failing.tree, 'jobs'), 'stop-job').props.onClick();
  actionNode(blockOf(expand(await pump(failing.env.card, failing.props)), 'jobs'), 'stop-job').props.onClick();
  await tick();
  const failedStop = actionNode(blockOf(expand(await pump(failing.env.card, failing.props)), 'jobs'), 'stop-job');
  expect(failedStop.props['data-kill-state'] === 'failed', `失败态应为 failed，实际 ${JSON.stringify(failedStop.props['data-kill-state'])}`);
  expect(failedStop.props.title === '停止失败', `失败后 title 应提示停止失败，实际 ${JSON.stringify(failedStop.props.title)}`);

  // 「清空」只清这张卡的表：已结束的行消失，运行中的行照旧。
  actionNode(opened, 'clear-settled-jobs').props.onClick();
  const cleared = blockOf(expand(await pump(env.card, props)), 'jobs');
  expect(findAll(cleared, (node) => hasClass(node, 'sc_jobLine')).length === 1, '清空后应只剩运行中的那一行');
  expect(findAll(cleared, (node) => hasClass(node, 'sc_jobSection')).length === 0, '没有已结束的行时不该再摆分组头');
});

await runCase('F22 后台任务服务缺席时整块不出现；只有已结束任务时默认摊开', async () => {
  const { tree } = await render(richOpts());
  expect(blockOf(tree, 'jobs') === null, '没有 jobs 服务却渲染了后台任务块');
  expect(blockOf(tree, 'task'), '后端任务服务缺席时卡片其余分区仍应渲染');

  const now = Date.now();
  const onlySettled = await render({
    projections: {},
    jobsRows: [{ id: 'job-done', kind: 'bash', label: 'pnpm build', status: 'completed', startedAt: now - 9000, finishedAt: now - 1000, output: { total: 0, earliest: 0 } }],
  });
  const block = blockOf(onlySettled.tree, 'jobs');
  expect(block, '只有已结束任务时也该渲染后台任务块');
  expect(textOf(block).includes('已结束 1'), `折叠文案为 ${JSON.stringify(textOf(block))}`);
  expect(findAll(block, (node) => hasClass(node, 'sc_jobLine')).length === 1, '没有活任务时应默认摊开已结束的行');
  expect(actionNode(block, 'stop-job') === undefined, '已结束的行不该有停止按钮');
});

await runCase('F20 轮次结束后「等你」定格（路由即使带上 idleSince 也不算，对话结束不该继续涨）', async () => {
  const now = Date.now();
  const { tree } = await render({
    projections: { todos: [] },
    fetchImpl: changesFetch([], {
      // 这一轮已经结束（waitSince 为 null）；即使路由还带着 `idleSince`，也只是轮次之间的空闲，不能计入。
      timing: { turn: 2, modelMs: 1000, toolMs: 2000, waitMs: 30000, waitSince: null, idleSince: now - 10000 },
    }),
  });
  const bar = blockOf(tree, 'timing');
  const items = findAll(bar, (node) => hasClass(node, 'sc_timingItem'));
  expect(items.length === 3, `这一轮有人等过决策，该摆「等你」，实际 ${items.length} 段`);
  expect(textOf(items[2]).includes('等你'), `第三段不是「等你」，实际 ${JSON.stringify(textOf(items[2]))}`);
  // 等你 = 已结算的 waitMs（30s），轮次结束后的 10s 空闲不算。
  expect(textOf(items[2]).includes('30s'), `等你应为 30s（不含轮次间的空闲），实际 ${JSON.stringify(textOf(items[2]))}`);
  const total = textOf(findAll(bar, (node) => hasClass(node, 'sc_timingTotalValue'))[0]);
  expect(total === '33s', `本轮总耗时应为 33s（1s + 2s + 30s），实际 ${JSON.stringify(total)}`);
});

await runCase('F13 耗时条：本轮总耗时打头、细分在后，等你只在真等人时出现', async () => {
  const both = await render(richOpts());
  const bar = blockOf(both.tree, 'timing');
  expect(bar, '没有耗时条');
  expect(hasClass(bar, 'sc_bar'), '耗时条没走 sc_bar 样式');
  // 与下方内容行等宽：左右不能再额外缩进一个 --sc-pad，也不再自铺底色/圆角（不是一张小卡片）。
  const barRule = cssDecls(ruleOf(both.env.css, '.sc_bar')?.body ?? '');
  expect(barRule.margin === '2px 0 8px', `耗时条外边距为 ${JSON.stringify(barRule.margin)}，应与下方内容同宽`);
  expect(barRule.background === undefined && barRule['background-color'] === undefined,
    `耗时条不该有底色，实际 ${JSON.stringify(barRule.background)}`);
  expect(barRule['border-radius'] === undefined && barRule.border === undefined,
    `耗时条不该有卡片外观（圆角 / 描边），实际 ${JSON.stringify([barRule['border-radius'], barRule.border])}`);
  // 只有一行（不是一个格子代表一件事），段与段之间是淡点而不是竖线。
  expect(findAll(bar, (node) => hasClass(node, 'sc_timing')).length === 1, '耗时条里不是单行布局');
  expect(findAll(bar, (node) => hasClass(node, 'sc_barDivider')).length === 0, '耗时条不该再插竖线');
  // 总耗时单独一颗（sc_timingTotal），细分是 sc_timingItem；总计与细分在字号/颜色上分层。
  const totalNodes = findAll(bar, (node) => hasClass(node, 'sc_timingTotal'));
  expect(totalNodes.length === 1, `应有且只有一个总耗时节点，实际 ${totalNodes.length}`);
  const totalValues = findAll(bar, (node) => hasClass(node, 'sc_timingTotalValue')).map((node) => textOf(node));
  expect(totalValues.length === 1, `总耗时数值应为 1 个，实际 ${JSON.stringify(totalValues)}`);
  const items = findAll(bar, (node) => hasClass(node, 'sc_timingItem'));
  expect(items.length === 2, `本轮还在跑时应只有模型 / 工具两段，实际 ${items.length} 段`);
  const dots = findAll(bar, (node) => hasClass(node, 'sc_timingDot'));
  expect(dots.length === items.length - 1, `分隔点数 ${dots.length} 应比段数少 1`);

  const waiting = await render({
    projections: {},
    fetchImpl: changesFetch([], {
      timing: { turn: 1, modelMs: 1000, toolMs: 2000, waitMs: 30000, waitSince: Date.now() - 10000 },
    }),
  });
  const waitBar = blockOf(waiting.tree, 'timing');
  const waitItems = findAll(waitBar, (node) => hasClass(node, 'sc_timingItem'));
  expect(waitItems.length === 3, `有等人耗时应出现第三段「等你」，实际 ${waitItems.length} 段`);
  expect(textOf(waitItems[2]).includes('等你'), `第三段不是「等你」，实际 ${JSON.stringify(textOf(waitItems[2]))}`);
  // 等你 = 已结算的 waitMs + 当前这一段的增量（30s + 10s）。
  expect(textOf(waitItems[2]).includes('40s'), `等你应为 40s，实际 ${JSON.stringify(textOf(waitItems[2]))}`);

  // 层级：总计与细分**同一档**（12px / fg / 600），只有标签弱色；不再有「总计放大一档」的分层。
  const label = cssDecls(ruleOf(both.env.css, '.sc_timingLabel')?.body ?? '');
  const name = cssDecls(ruleOf(both.env.css, '.sc_timingName')?.body ?? '');
  const totalValue = cssDecls(ruleOf(both.env.css, '.sc_timingTotalValue')?.body ?? '');
  const value = cssDecls(ruleOf(both.env.css, '.sc_timingValue')?.body ?? '');
  expect(label.color === 'var(--sc-fg-weak)' && label.color === name.color,
    `总计标签色为 ${JSON.stringify(label.color)}，应与细分量词 ${JSON.stringify(name.color)} 一致`);
  // 「保持一致」的实现方式：两段都不声明字号，一起继承 `.sc_timing` 的 12px。
  expect(label['font-size'] === undefined && totalValue['font-size'] === undefined,
    `总计与细分都不该单独声明字号，实际 ${JSON.stringify([label['font-size'], totalValue['font-size']])}`);
  expect(totalValue.color === 'var(--sc-fg)' && totalValue.color === value.color,
    `总计数值色为 ${JSON.stringify(totalValue.color)}，应与细分数值 ${JSON.stringify(value.color)} 一致`);
  expect(totalValue['font-weight'] === '600' && totalValue['font-weight'] === value['font-weight'],
    `总计字重为 ${JSON.stringify(totalValue['font-weight'])}，应与细分数值 ${JSON.stringify(value['font-weight'])} 一致`);
  expect(totalValue['font-variant-numeric'] === 'tabular-nums' && value['font-variant-numeric'] === 'tabular-nums',
    '数值没有用等宽数字');

  const none = await render({ projections: { todos: [] }, fetchImpl: changesFetch([]) });
  expect(blockOf(none.tree, 'timing') == null, '没有本轮耗时的会话里不该渲染耗时条');
});

await runCase('F14 分区顺序：状态条 → 计划 → 目标 → 任务 → 变更 → 子智能体 → 后台任务', async () => {
  // 富 fixture 一次凑齐六个分区：todos/goal/team/permissions 走投影，计划与变更走路由响应。
  const { tree } = await render({
    ...richOpts(),
    // 一条运行中的后台作业：顺带钉住「后台任务排在子智能体之后」。
    jobsRows: [{ id: 'job-order', kind: 'bash', label: 'npm test', status: 'running', startedAt: 1e12 }],
    fetchImpl: () => okResponse({
      files: [
        { path: '/w/dsh-status-card/client.js', display: 'dsh-status-card/client.js', added: 12, deleted: 6, seq: 4, turn: 2, index: 0 },
      ],
      added: 12,
      deleted: 6,
      timing: { turn: 2, modelMs: 42000, toolMs: 18000, waitSince: null },
      plans: [planRow('call-1', '重建状态卡片')],
    }),
  });
  const body = findAll(tree, (node) => hasClass(node, 'sc_body'))[0];
  expect(body, '没有 .sc_body');
  const order = findAll(body, (node) => typeof node.props?.['data-sc-block'] === 'string')
    .map((node) => node.props['data-sc-block']);
  const expected = ['timing', 'plan', 'goal', 'task', 'changes', 'agents', 'jobs'];
  expect(JSON.stringify(order) === JSON.stringify(expected),
    `分区顺序为 ${JSON.stringify(order)}，应为 ${JSON.stringify(expected)}`);
});

await runCase('F15 变更行用彩色文件类型图标：按语言分类（js/ts/json/py…各有类型与颜色）', async () => {
  const files = [
    fileRow('dsh-status-card/README.md'),
    fileRow('dsh-status-card/client.js'),
    fileRow('dsh-status-card/package.json'),
    fileRow('tools/build.py'),
    fileRow('theme/styles.css'),
    fileRow('assets/logo.png'),
  ];
  const { env, tree } = await render({ fetchImpl: changesFetch(files) });
  const icons = findAll(tree, (node) => hasClass(node, 'sc_fileIcon'));
  expect(icons.length === files.length, `文件类型图标数量 ${icons.length} 与文件行数 ${files.length} 不一致`);
  const kinds = icons.map((node) => node.props['data-kind']);
  expect(kinds.join() === 'markdown,javascript,json,python,stylesheet,image',
    `类型分类为 ${JSON.stringify(kinds)}，与扩展名不符`);
  expect(new Set(kinds).size === kinds.length, '不同类型的文件必须落到不同类型（不允许都挤成 code）');
  expect(icons.every((node) => node.props.width === 16 && node.props.height === 16 && node.props.viewBox === '0 0 28 28'),
    '文件类型图标必须是 16px、28 格视图');
  // 每颗图标都有「页形 + 折角 + 类型标记」三部分（other 只有页形 + 折角）。
  const markCount = icons.map((node) => findAll(node, (item) => item.props?.['data-file-type-mark'] === true).length);
  expect(markCount.join() === '1,1,1,1,1,1', `类型标记组数量为 ${JSON.stringify(markCount)}`);
  // 标记本身的笔画数也要按类型不同：markdown 一个 MD 字标 · javascript 三条括号 · json 一对花括号 ·
  // python 三条括号 · css 井号四条 · image 三块山路。
  const markPaths = icons.map((node) => {
    const group = findAll(node, (item) => item.props?.['data-file-type-mark'] === true)[0];
    return group === undefined ? 0 : findAll(group, (item) => item.type !== undefined && item.props?.d !== undefined).length;
  });
  expect(markPaths.join() === '1,3,2,3,4,3', `类型标记笔画数为 ${JSON.stringify(markPaths)}，各类型应各不相同`);
  // 颜色只允许来自 token：类型色是 --dsw-static-*，标记是 --dsw-static-neutral-00。
  const colorOf = (kind) => new RegExp(`\\.sc_fileIcon\\[data-kind=${kind}\\][^{]*\\{color:var\\(--dsw-static-[a-z0-9-]+\\)`).test(env.css);
  for (const kind of ['code', 'markdown', 'excel', 'image', 'pdf',
    'javascript', 'typescript', 'json', 'python', 'rust', 'go', 'java', 'clang',
    'shell', 'stylesheet', 'config', 'sql']) {
    expect(colorOf(kind), `缺少 .sc_fileIcon[data-kind=${kind}] 的颜色规则`);
  }
  // 语言之间颜色必须两两不同（否则「按类型区分」只是说说）。
  const colorTokenOf = (kind) => {
    const rule = new RegExp('\\.sc_fileIcon\\[data-kind=' + kind + '\\]\\{color:var\\((--dsw-static-[a-z0-9-]+)\\)');
    return (rule.exec(env.css) ?? [])[1] ?? '';
  };
  const languageColors = ['javascript', 'typescript', 'json', 'python', 'rust', 'go', 'java', 'clang', 'stylesheet']
    .map(colorTokenOf);
  expect(languageColors.every((item) => item !== ''), `语言颜色解析失败：${JSON.stringify(languageColors)}`);
  expect(new Set(languageColors).size === languageColors.length,
    `语言颜色出现了重复：${JSON.stringify(languageColors)}`);
  expect(/\.sc_fileIcon\[data-kind=markdown\][^{]*\{color:var\(--dsw-static-deepseek-500\)/.test(env.css),
    'markdown 的颜色应与侧边栏一致（deepseek-500）');
  expect(/\.sc_fileIcon\[data-kind=excel\][^{]*\{color:var\(--dsw-static-green-500\)/.test(env.css),
    'excel 的颜色应与侧边栏一致（green-500）');
  expect(/\.sc_fileIcon\[data-kind=pdf\][^{]*\{color:var\(--dsw-static-red-600\)/.test(env.css),
    'pdf 的颜色应与侧边栏一致（red-600）');
  // 图标里不许出现字面色值（颜色只能走 token）。
  expect(!/#[0-9a-f]{3,8}\b|rgba?\(/iu.test(env.css), '样式里出现了字面色值，颜色必须走 --dsw-* token');
});

await runCase('F16 子会话的计划用官方五段地址（plan/subagent/<parent>/<child>/<mode>/<callId>）', async () => {
  const { env, tree } = await render({
    projections: { todos: [] },
    fetchImpl: plansFetch([planRow('call-9', '子会话计划')]),
    subagentAddress: { parentSessionId: MAIN, childSessionId: 'sub-9', mode: 'continuable' },
  });
  const row = actionNode(tree, 'open-plan');
  expect(row, '计划行不是可点节点');
  row.props.onClick();
  await tick();
  const open = env.resources.filter((item) => item.kind === 'openResourceIn');
  expect(open.length === 1, `右栏调用次数为 ${open.length}`);
  expect(open[0].args[1] === `dsh-resource://plan/subagent/${MAIN}/sub-9/continuable/call-9`,
    `地址实际为 ${JSON.stringify(open[0].args[1])}`);
});

await runCase('F17 分区标题无前置图标、字号 15px（标题只剩文字 + 计数 + 操作）', async () => {
  const { env, tree } = await render(richOpts());
  for (const key of ['task', 'goal', 'agents']) {
    const block = blockOf(tree, key);
    expect(block, `没有渲染 data-sc-block=${key} 的块`);
    const head = findAll(block, (node) => hasClass(node, 'sc_blockHead'))[0];
    expect(head, `${key} 块没有分区头`);
    // 分区头的第一颗子节点必须是标题本身：图标列（sc_secLead）已删，图标只可能出现在右侧操作按钮里。
    const flat = head.props.children.flat(Infinity).filter((node) => node !== null && node !== undefined);
    expect(flat.length > 0 && hasClass(flat[0], 'sc_blockTitle'),
      `${key} 块的分区头前面还挂着图标列`);
    expect(findAll(head, (node) => hasClass(node, 'sc_secLead')).length === 0, `${key} 块还有 sc_secLead 图标列`);
    const titles = findAll(head, (node) => hasClass(node, 'sc_blockTitle'));
    expect(titles.length === 1, `${key} 块的分区标题数量为 ${titles.length}`);
  }
  const decls = cssDecls(ruleOf(env.css, '.sc_blockTitle')?.body ?? '');
  expect(decls['font-size'] === '15px', `分区标题字号为 ${JSON.stringify(decls['font-size'])}，应比正文 13px 大一档`);
  expect(!env.css.includes('sc_secLead'), '分区头的图标列（sc_secLead）应已删除');
});

await runCase('F18 子智能体行整行可点：走官方 uiWorkspace.openSession 跳子会话，队友行不冒充可点', async () => {
  const { env, tree } = await render(agentOpts());
  const rows = findAll(blockOf(tree, 'agents'), (node) => node.props?.['data-sc-action'] === 'open-agent');
  expect(rows.length === 2, `可点行应为 2 行，实际 ${rows.length}`);
  expect(rows.every((node) => node.type === 'button'), '可点行应渲染成 button 才有键盘可达');
  rows[0].props.onClick();
  expect(env.opens.length === 1, `点击子智能体行后 openSession 调用 ${env.opens.length} 次`);
  // 官方地址形态：durable 直系子会话 {parentSessionId, childSessionId, mode}。
  expect(JSON.stringify(env.opens[0]) === JSON.stringify({ parentSessionId: MAIN, childSessionId: 'sub-a', mode: 'continuable' }),
    `openSession 收到 ${JSON.stringify(env.opens[0])}`);
  rows[1].props.onClick();
  expect(env.opens[1]?.mode === 'one-shot', `一次性子智能体的 mode 应为 one-shot，实际 ${JSON.stringify(env.opens[1])}`);

  // 队友（agentTeam 成员）拿不到 durable 地址，不能做成可点行。
  const teamOnly = await render({ ...richOpts(), subagents: [] });
  const teamRows = findAll(blockOf(teamOnly.tree, 'agents'), (node) => node.props?.['data-sc-action'] === 'open-agent');
  expect(teamRows.length === 0, `队友行不该可点，实际有 ${teamRows.length} 行`);

  // 服务缺席时点击不能抛（纯展示卡片不因导航服务缺失而崩）。
  const bare = await render({ ...agentOpts(), withUiWorkspace: false });
  const bareRows = findAll(blockOf(bare.tree, 'agents'), (node) => node.props?.['data-sc-action'] === 'open-agent');
  bareRows[0].props.onClick();
  expect(bare.env.opens.length === 0, '服务缺席时不该有调用');
});


/* ------------------------------------------------------------------ L 组：会话区自适应（卡片推让正文） */

await runCase('L1 宽屏放得下：不推让（padding-right 保持空），卡片展开', async () => {
  const ctx = await renderFit(2280, 920);
  expect(asideNodes(ctx.tree).length === 1, '宽屏应渲染卡片');
  expect(!hiddenCardOf(ctx.tree), '宽屏卡片不该被收起');
  expect(pushOf(ctx) === '', `宽屏不该推让，实际 padding-right=${JSON.stringify(pushOf(ctx))}`);
});

await runCase('L2 中等宽度：按 fitOf 算出的量推让正文（push 184 → padding 368）', async () => {
  // need = 768/2 − 1200/2 + (12 + 372 + 16) = 184；available = (1200 − 768)/2 − 12 = 204 → 推满 184。
  const ctx = await renderFit(1200, 768);
  expect(pushOf(ctx) === '368px', `推让应为 368px（2 × 184），实际 ${JSON.stringify(pushOf(ctx))}`);
  expect(asideNodes(ctx.tree).length === 1 && !hiddenCardOf(ctx.tree), '放得下就该展开');
});

await runCase('L3 再窄一点：推到极限就自动收起，只剩圆钮，且推让量按圆钮算', async () => {
  // need = 360 > available = 28 → tight；收起态 reserve 换成 PUSH_FAB=54 → need = 14，push = 14 → padding 28。
  const ctx = await renderFit(1000, 920);
  expect(hiddenCardOf(ctx.tree), '推不动时应自动收起卡片');
  expect(anchorStateOf(ctx.tree) === 'fab', `锚点 data-state 为 ${JSON.stringify(anchorStateOf(ctx.tree))}`);
  expect(fabNodes(ctx.tree).length === 1, '收起后应有且只有一颗圆钮');
  expect(pushOf(ctx) === '28px', `收起态推让应为 28px，实际 ${JSON.stringify(pushOf(ctx))}`);
});

await runCase('L4 收起是自己收的，不是不让开：手动点圆钮能展开（当前宽度下有效）', async () => {
  const ctx = await renderFit(1000, 920);
  fabNodes(ctx.tree)[0].props.onClick();
  const opened = expand(await pump(ctx.env.card, ctx.props));
  expect(!hiddenCardOf(opened), '手动展开后卡片不该立刻被自动逻辑收回');
  expect(anchorStateOf(opened) === 'card', `手动展开后 data-state 为 ${JSON.stringify(anchorStateOf(opened))}`);
  expect(pushOf(ctx) === '56px', `手动展开后应按卡片推让（28 × 2 = 56），实际 ${JSON.stringify(pushOf(ctx))}`);
});

await runCase('L6 宽度大到阈值之后自动展开（不用手动点）', async () => {
  const ctx = await renderFit(1000, 920);
  expect(hiddenCardOf(ctx.tree), '前置条件：窄格局应自动收起');
  const wide = await setFit(ctx, 1400, 920);
  expect(!hiddenCardOf(wide), '宽度恢复到 1400 后应自动展开');
  expect(pushOf(ctx) === '320px', `展开后推让应为 320px（need 160 × 2），实际 ${JSON.stringify(pushOf(ctx))}`);
});

await runCase('L7 量不到正文列宽度时退回 820 保险丝，且不往宿主 DOM 上写 padding', async () => {
  // 宿主没暴露 --dsh-chat-content-width（夹具不传 chatWidth）→ chatWidth 为 null。
  const wide = await renderAt(1200);
  expect(asideNodes(wide.tree).length === 1, '量不到正文列宽但内容区够宽时仍应渲染卡片');
  expect(pushOf(wide) === '', `降级路径不该推让，实际 padding-right=${JSON.stringify(pushOf(wide))}`);
  const narrow = await renderAt(700);
  expect(asideNodes(narrow.tree).length === 0, '降级路径仍要用 820 保险丝隐藏卡片');
});

await runCase('L8 推让有过渡，且尊重 prefers-reduced-motion', async () => {
  const { env } = await renderFit(1200, 768);
  expect(/\[data-conversation-content\]\{transition:padding-right/u.test(env.css), '缺少 padding-right 过渡规则（收放时正文会瞬移）');
  expect(/prefers-reduced-motion:reduce\)\{\[data-conversation-content\]\{transition:none\}/u.test(env.css),
    '缺少 prefers-reduced-motion 下关闭过渡的规则');
});

await runCase('L9 滞回：自动收起后要多让出 FIT_HYSTERESIS 才展开（临界点不抖）', async () => {
  // C=920 时自动展开阈值 W≥1332；已收起时要到 W≥1356（多出 24）才展开。
  const ctx = await renderFit(1300, 920);
  expect(hiddenCardOf(ctx.tree), '1300 应自动收起（need 210 > available 178）');
  const stillFolded = await setFit(ctx, 1340, 920);
  expect(hiddenCardOf(stillFolded), '1340 仍在滞回死区（>1332 但 <1356），应继续保持收起');
  const opened = await setFit(ctx, 1360, 920);
  expect(!hiddenCardOf(opened), '1360 超过滞回阈值后应自动展开');
});

await runCase('L5 手动展开只对当前宽度有效：宽度一变就回到自动判定（继续收起）', async () => {
  const ctx = await renderFit(1000, 920);
  fabNodes(ctx.tree)[0].props.onClick();
  expect(!hiddenCardOf(expand(await pump(ctx.env.card, ctx.props))), '前置条件：手动展开应生效');
  const after = await setFit(ctx, 1010, 920);
  expect(hiddenCardOf(after), '宽度一变就应重新按自动逻辑收起（手动展开不再豁免）');
});

await runCase('H6 foldTiming：模型 = step/start→assistant/message、工具 = tool/call→tool/result、等你只算审批与提问', async () => {
  let state = host.emptyTiming();
  const events = [
    { type: 'turn/start', time: 1000, data: { turn: 3 } },
    { type: 'step/start', time: 1100, data: { turn: 3, step: 1 } },
    { type: 'assistant/message', time: 3100, data: { turn: 3, step: 1 } },
    { type: 'tool/call', time: 3200, data: { turn: 3, step: 1, callId: 'c1', name: 'bash' } },
    { type: 'tool/result', time: 5200, data: { turn: 3, step: 1, toolCallId: 'c1' } },
    // 权限审批：人点了 4 秒才决定 → 只进「等你」，不进工具时间。
    { type: 'approval/asked', time: 6000, data: { id: 'a1', toolName: 'bash' } },
    { type: 'approval/decided', time: 10000, data: { id: 'a1', outcome: 'allowed' } },
    // 提问：模型问完到人回答之间 6 秒，同样算「等你」，且这段不算工具执行时间。
    { type: 'tool/call', time: 11000, data: { turn: 3, step: 1, callId: 'q1', name: 'ask_user_question' } },
    { type: 'tool/result', time: 17000, data: { turn: 3, step: 1, toolCallId: 'q1' } },
    { type: 'turn/end', time: 20000, data: { turn: 3, reason: { kind: 'completed' } } },
  ];
  for (const event of events) state = host.foldTiming(state, event);
  const wire = host.exportTiming(state);
  expect(wire.turn === 3, `轮次为 ${JSON.stringify(wire.turn)}`);
  expect(wire.modelMs === 2000, `模型耗时 ${wire.modelMs}，应为 2000（3100 - 1100）`);
  expect(wire.toolMs === 2000, `工具耗时 ${wire.toolMs}，应为 2000（5200 - 3200，提问那段不算工具）`);
  expect(wire.waitMs === 10000, `等你耗时 ${wire.waitMs}，应为 10000（审批 4s + 提问 6s）`);
  expect(wire.waitSince === null, `轮次结束后没有在等人的段落，waitSince 应为 null，实际 ${JSON.stringify(wire.waitSince)}`);

  // 轮次没结束时还在等人：waitSince 给出起点，客户端据此算实时增量。
  const asked = host.exportTiming(host.foldTiming(
    host.foldTiming(host.emptyTiming(), { type: 'turn/start', time: 100, data: { turn: 5 } }),
    { type: 'approval/asked', time: 900, data: { id: 'a9', toolName: 'bash' } },
  ));
  expect(asked.waitSince === 900, `等人的起点应为 900，实际 ${JSON.stringify(asked.waitSince)}`);
  expect(asked.waitMs === 0, `还没决定时已结算的等你应为 0，实际 ${asked.waitMs}`);

  // 新的一轮重新开账。
  const fresh = host.exportTiming(host.foldTiming(state, { type: 'turn/start', time: 20000, data: { turn: 4 } }));
  expect(fresh.turn === 4 && fresh.modelMs === 0 && fresh.toolMs === 0 && fresh.waitMs === 0 && fresh.waitSince === null,
    `新轮次没有重置：${JSON.stringify(fresh)}`);

  // 没有配对的 tool/call 不算时间（PTC 的子调用可能没有 result）。
  const orphan = host.exportTiming(host.foldTiming(host.emptyTiming(), { type: 'tool/result', time: 500, data: { toolCallId: 'x' } }));
  expect(orphan.toolMs === 0, `孤立的 tool/result 被计成 ${orphan.toolMs}`);
});

await runCase('H7 增量扫描保留耗时状态，路由把 timing 一并下发', async () => {
  const events = [
    { seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } },
    { seq: 1, type: 'step/start', time: 1000, data: { turn: 1, step: 1 } },
    { seq: 2, type: 'assistant/message', time: 4000, data: { turn: 1, step: 1 } },
  ];
  const first = host.scanLog(events);
  expect(first.timing.modelMs === 3000, `首扫模型耗时 ${first.timing.modelMs}`);
  const grown = host.scanLog([
    { seq: 3, type: 'approval/asked', time: 5000, data: { id: 'a1', toolName: 'bash' } },
    { seq: 4, type: 'approval/decided', time: 7000, data: { id: 'a1', outcome: 'allowed' } },
  ], first);
  expect(grown.timing.modelMs === 3000, `增量续扫把模型耗时弄丢了：${grown.timing.modelMs}`);
  expect(host.exportTiming(grown.timing).waitMs === 2000,
    `增量续扫没接上等你耗时：${host.exportTiming(grown.timing).waitMs}`);

  const ctx = {
    sessions: { get: () => ({ id: 's1', snapshotEvents: (from = 0) => events.slice(from) }) },
    workspaceChanges: { summary: () => undefined },
    shell: {},
  };
  const response = host.handleChangesRequest(ctx, new Map(), { url: 'http://x/api/status-card.changes?sessionId=s1' });
  const body = await response.json();
  expect(body.timing !== undefined && body.timing !== null, '响应里没有 timing');
  expect(body.timing.turn === 1 && body.timing.modelMs === 3000, `响应里的 timing 不对：${JSON.stringify(body.timing)}`);
  expect(body.timing.waitMs === 0, `这一轮没人等过决策，waitMs 应为 0，实际 ${body.timing.waitMs}`);
  expect(body.timing.waitSince === null, `没有在等人的段落时 waitSince 应为 null，实际 ${JSON.stringify(body.timing.waitSince)}`);
});

await runCase('H8 等你三段互不重叠：计划批准算等你、审批时间从工具里扣掉、轮次结束后不再有未结算的等待', async () => {
  let state = host.emptyTiming();
  const events = [
    { type: 'turn/start', time: 0, data: { turn: 7 } },
    // exit_plan_mode：从调用到人点「批准」全是人的时间 → 只进「等你」，不进工具耗时。
    { type: 'tool/call', time: 1000, data: { callId: 'p1', name: 'exit_plan_mode' } },
    { type: 'tool/result', time: 5000, data: { toolCallId: 'p1' } },
    // plugin_manager 这类会弹审批的工具：工具窗口 10s（10s→20s），其中 6s 人在点批准。
    { type: 'tool/call', time: 10000, data: { callId: 'm1', name: 'plugin_manager' } },
    { type: 'approval/asked', time: 12000, data: { id: 'a1', toolName: 'plugin_manager' } },
    { type: 'approval/decided', time: 18000, data: { id: 'a1', outcome: 'allowed' } },
    { type: 'tool/result', time: 20000, data: { toolCallId: 'm1' } },
    { type: 'turn/end', time: 30000, data: { turn: 7, reason: { kind: 'completed' } } },
  ];
  for (const event of events) state = host.foldTiming(state, event);
  const wire = host.exportTiming(state);
  expect(wire.toolMs === 4000, `工具耗时 ${wire.toolMs}，应为 4000（10s 窗口里 6s 在审批，得扣掉）`);
  expect(wire.waitMs === 10000, `等你 ${wire.waitMs}，应为 10000（计划批准 4s + 审批 6s）`);
  // 三段互不重叠，所以加起来不会超过这一轮的墙钟（30s）。
  expect(wire.modelMs + wire.toolMs + wire.waitMs <= 30000,
    `三段和 ${wire.modelMs + wire.toolMs + wire.waitMs} 超过了这一轮墙钟 30000（有重叠记账）`);
  // 这一轮已经交回给用户：没有未结算的等待了，「等你」随之定格（轮次之间的空闲不算）。
  expect(wire.waitSince === null, `轮次结束后 waitSince 应为 null，实际 ${JSON.stringify(wire.waitSince)}`);
  expect(wire.idleSince === undefined, `路由不该再下发 idleSince（轮次间空闲不算等你），实际 ${JSON.stringify(wire.idleSince)}`);
  // 下一轮重新开账：上一轮的等待不会漏到新一轮里。
  const next = host.exportTiming(host.foldTiming(state, { type: 'turn/start', time: 90000, data: { turn: 8 } }));
  expect(next.waitMs === 0 && next.waitSince === null, `新一轮应是干净的账，实际 ${JSON.stringify(next)}`);
});

/* ------------------------------------------------------------------ 主题（高亮色） */

/** 主题预设与它们对应的宿主静态色阶 token（与 client.js 的 THEMES 一一对应）。 */
const THEME_PRESETS = [
  ['green', 'var(--dsw-static-green-500)'],
  // 蓝色档用 deepseek-500 而不是 blue-500：#3b82f6 与 #4176e6 肉眼几乎同色，
  // 两档都摆出来等于让用户挑一个看不出差别的色（TH1 会读出这条映射）。
  ['blue', 'var(--dsw-static-deepseek-500)'],
  ['amber', 'var(--dsw-static-amber-500)'],
  ['red', 'var(--dsw-static-red-500)'],
];
const THEME_STORE_KEY = 'dsh-status-card:theme';

/** 取某个座位的注册项；没注册就直接抛，避免断言悄悄变成「什么都没测」。 */
function slotEntry(env, name) {
  const entry = env.slots.find((item) => item.options.name === name);
  if (entry === undefined) throw new Error(`座位 ${name} 没有注册（已注册：${env.slots.map((i) => i.options.name).join(',')}）`);
  return entry;
}

/**
 * 单独渲染一个座位组件。hooks 槽位按「一次独立挂载」重置，
 * 否则会和卡片的 hook 序号串在一起（迷你 React 替身只有一个全局槽位表）。
 */
function renderSlot(entry, props) {
  hooks.states = [];
  hooks.refs = {};
  hooks.index = 0;
  hooks.dirty = false;
  hooks.pending = [];
  const tree = expand(entry.Component(props));
  flushEffects();
  return tree;
}

/** 替身 localStorage：只实现本插件用到的那三个方法。 */
function makeStorage(initial = {}, { throws = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) { if (throws) throw new Error('storage 被禁用'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (throws) throw new Error('storage 被禁用'); map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

/** 主题色点：按 `data-sc-theme` 找按钮，顺序即 THEME_PRESETS 的顺序。 */
const themeChips = (tree) => findAll(tree, (node) => node.type === 'button' && node.props?.['data-sc-theme'] !== undefined);
const chipOf = (tree, id) => themeChips(tree).find((node) => node.props['data-sc-theme'] === id) ?? null;
const cardThemeOf = (tree) => asideNodes(tree)[0]?.props?.['data-sc-theme'];

await runCase('TH1 CSS：四档预设都映射到宿主色阶，accent 由 --sc-theme 现场派生（ok/accent 合一）', async () => {
  const { env } = await render({ projections: { todos: [] } });
  for (const [id, token] of THEME_PRESETS) {
    const rule = ruleOf(env.css, `.sc_card[data-sc-theme=${id}],.sc_themeChip[data-sc-theme=${id}]`);
    expect(rule !== undefined, `缺少主题映射规则 data-sc-theme=${id}`);
    expect(cssDecls(rule.body)['--sc-theme'] === token, `${id} 的 --sc-theme 为 ${JSON.stringify(cssDecls(rule.body)['--sc-theme'])}，应为 ${token}`);
  }
  const card = cssDecls(ruleOf(env.css, '.sc_card')?.body ?? '');
  expect(card['--sc-theme'] === 'var(--dsw-static-green-500)', `默认主题为 ${JSON.stringify(card['--sc-theme'])}，应为绿色`);
  expect(card['--sc-accent'] === 'var(--sc-theme)', `--sc-accent 为 ${JSON.stringify(card['--sc-accent'])}，应直接跟随 --sc-theme`);
  expect(String(card['--sc-accent-weak']).startsWith('color-mix(in srgb,var(--sc-theme)'),
    `--sc-accent-weak 为 ${JSON.stringify(card['--sc-accent-weak'])}，弱底色应由 --sc-theme 混合出来`);
  expect(!('--sc-ok' in card) && !('--sc-ok-weak' in card), '旧的 --sc-ok/--sc-ok-weak 还在，高亮色没有真正统一');
  expect(!/--sc-ok/iu.test(env.css), '样式表里仍残留 --sc-ok 的引用');
  // 勾选环、状态点、进度条、pill 四处高亮必须都吃同一族变量。
  const unified = [
    ['.sc_pill[data-tone=ok]', 'background', 'var(--sc-accent-weak)'],
    ['.sc_mark[data-state=done]', 'background', 'var(--sc-accent)'],
    ['.sc_progressFill', 'background', 'var(--sc-accent)'],
    ['.sc_check[data-state=done]', 'color', 'var(--sc-accent)'],
  ];
  for (const [selector, prop, want] of unified) {
    const actual = cssDecls(ruleOf(env.css, selector)?.body ?? '')[prop];
    expect(actual === want, `${selector} 的 ${prop} 为 ${JSON.stringify(actual)}，应为 ${want}`);
  }
});

await runCase('TH2 卡片默认是绿色主题：根节点带 data-sc-theme=green', async () => {
  delete globalThis.localStorage;
  const { tree } = await render({ projections: { todos: [] } });
  expect(cardThemeOf(tree) === 'green', `卡片 data-sc-theme 为 ${JSON.stringify(cardThemeOf(tree))}，默认应为 green`);
});

await runCase('TH3 插件详情页出现「高亮色」设置块：四个色点、绿为当前选中、摘要视图不渲染', async () => {
  delete globalThis.localStorage;
  const { env } = await render({ projections: { todos: [] } });
  const entry = slotEntry(env, 'plugins.bundle.config');
  expect(entry.options.key === '@liuhusk/dsh-status-card', `座位 key 为 ${JSON.stringify(entry.options.key)}，应等于包名（宿主按包名判断是否渲染这一段）`);
  expect(entry.options.locale === NS, `座位 locale 为 ${JSON.stringify(entry.options.locale)}`);
  expect(env.injections.includes('plugins.bundle.config'), 'slots.inject 没有请求 plugins.bundle.config');
  expect(renderSlot(entry, { view: 'summary', t: env.t }) === null, '摘要视图不该渲染设置块（那里是插件行）');

  const panel = renderSlot(entry, { view: 'page', t: env.t });
  const chips = themeChips(panel);
  expect(chips.length === THEME_PRESETS.length, `色点数量为 ${chips.length}，应为 ${THEME_PRESETS.length}`);
  for (const [id] of THEME_PRESETS) expect(chipOf(panel, id) !== null, `缺少 ${id} 色点`);
  expect(chipOf(panel, 'green')?.props['aria-pressed'] === 'true', '绿色的 aria-pressed 不是 true');
  expect(themeChips(panel).filter((node) => node.props['aria-pressed'] === 'true').length === 1, '同时有多个色点被标成选中');
  // 文案走 locale：译不到会原样吐 key，上面两处会一起露馅。
  const text = textOf(panel);
  expect(text.includes(env.t('theme.title')), `设置块里没有标题「${env.t('theme.title')}」：${text}`);
  expect(!text.includes('theme.'), `设置块里出现了未翻译的 key：${text}`);
  expect(themeChips(panel).every((node) => String(node.props.title ?? '').length > 0), '有色点没有 title（无障碍标签）');
});

await runCase('TH4 点色点即换色并落盘：卡片跟着变、刷新（重新挂载）后仍是这档', async () => {
  globalThis.localStorage = makeStorage();
  try {
    const first = await render({ projections: { todos: [] } });
    const entry = slotEntry(first.env, 'plugins.bundle.config');
    expect(cardThemeOf(first.tree) === 'green', '初始不是绿色');
    renderSlot(entry, { view: 'page', t: first.env.t }).props; // 先渲一次，确认设置块可渲染
    chipOf(renderSlot(entry, { view: 'page', t: first.env.t }), 'blue').props.onClick();
    expect(globalThis.localStorage.map.get(THEME_STORE_KEY) === 'blue',
      `落盘值为 ${JSON.stringify(globalThis.localStorage.map.get(THEME_STORE_KEY))}`);
    expect(chipOf(renderSlot(entry, { view: 'page', t: first.env.t }), 'blue').props['aria-pressed'] === 'true',
      '点完蓝色后设置块没把蓝色标成选中');
    // 重新挂载卡片 == 页面刷新后重渲染：主题要从内存状态读出来，不能退回默认。
    const remounted = expand(await mount(first.env.card, first.props));
    expect(cardThemeOf(remounted) === 'blue', `换色后卡片 data-sc-theme 为 ${JSON.stringify(cardThemeOf(remounted))}`);
    // 刷新（重新求值 client.js）后：从 localStorage 读回 blue。
    const reloaded = await render({ projections: { todos: [] } });
    expect(cardThemeOf(reloaded.tree) === 'blue', `刷新后卡片 data-sc-theme 为 ${JSON.stringify(cardThemeOf(reloaded.tree))}`);
    expect(chipOf(renderSlot(slotEntry(reloaded.env, 'plugins.bundle.config'), { view: 'page', t: reloaded.env.t }), 'blue')
      ?.props['aria-pressed'] === 'true', '刷新后设置块没回显蓝色');
  } finally {
    delete globalThis.localStorage;
  }
});

await runCase('TH5 落盘值非法或 storage 不可用时不炸：一律回落绿色默认', async () => {
  globalThis.localStorage = makeStorage({ [THEME_STORE_KEY]: 'purple' });
  try {
    const bad = await render({ projections: { todos: [] } });
    expect(cardThemeOf(bad.tree) === 'green', `非法主题 id 实际渲染成 ${JSON.stringify(cardThemeOf(bad.tree))}`);
  } finally {
    delete globalThis.localStorage;
  }
  globalThis.localStorage = makeStorage({}, { throws: true });
  try {
    const broken = await render({ projections: { todos: [] } });
    expect(cardThemeOf(broken.tree) === 'green', `storage 抛异常时卡片渲染失败或变了色：${JSON.stringify(cardThemeOf(broken.tree))}`);
    // 写入失败也不能挡住本次生效（隐私模式下至少当前页面要能换色）。
    chipOf(renderSlot(slotEntry(broken.env, 'plugins.bundle.config'), { view: 'page', t: broken.env.t }), 'amber').props.onClick();
    const remounted = expand(await mount(broken.env.card, broken.props));
    expect(cardThemeOf(remounted) === 'amber', `写入失败时本次换色没生效：${JSON.stringify(cardThemeOf(remounted))}`);
  } finally {
    delete globalThis.localStorage;
  }
});

/* ------------------------------------------------------------------ 汇总 */

const passed = results.filter((item) => item.ok).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) {
  console.log('失败用例：');
  for (const item of results.filter((entry) => !entry.ok)) console.log(`- ${item.name}: ${item.reason}`);
  process.exitCode = 1;
}
