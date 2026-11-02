/** Stateful Client regressions for session switches and delayed remote results. @author liuh */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

function harness() {
  let current;
  let dirty = false;
  let time = 100000;
  let timerId = 0;
  let root;
  let props;
  let tree;
  const instances = new Map();
  const timers = new Map();
  const pending = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const instance = current;
      const index = instance.index++;
      if (!(index in instance.slots)) instance.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [instance.slots[index], (next) => {
        if (!instance.live) return;
        const value = typeof next === 'function' ? next(instance.slots[index]) : next;
        if (!Object.is(value, instance.slots[index])) { instance.slots[index] = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = current.index++;
      if (!(index in current.slots)) current.slots[index] = { current: initial };
      return current.slots[index];
    },
    useEffect(effect, deps) {
      const instance = current;
      const index = instance.index++;
      const previous = instance.slots[index];
      if (previous && deps?.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      instance.slots[index] = { deps, cleanup: previous?.cleanup };
      pending.push(() => {
        previous?.cleanup?.();
        if (instance.live) instance.slots[index].cleanup = effect();
      });
    },
  };
  const addTimer = (fn, ms, interval) => {
    const id = ++timerId;
    timers.set(id, { fn, at: time + ms, interval });
    return id;
  };
  let manifest;
  const context = {
    window: { __ModuleLoader__: { load(value) { manifest = value; } } },
    Date: class extends Date { static now() { return time; } },
    setTimeout: (fn, ms) => addTimer(fn, ms, 0), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => addTimer(fn, ms, ms), clearInterval: (id) => timers.delete(id),
    console,
  };
  const marker = "    return {\n      inject: ['slots', 'sessions', 'locale'],";
  assert.ok(source.includes(marker), 'Client test exposure anchor must remain valid');
  vm.runInNewContext(source.replace(marker, `    globalThis.clientTest = { GoalBlock, JobsBlock, useJobsRows, useGoalActivation, useTimingNow, timingSegments, PreviousTasksBlock, zh };\n${marker}`), context);
  manifest.factory((name) => { assert.equal(name, 'react'); return React; });
  const api = context.clientTest;
  const t = (key, values = {}) => String(api.zh[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ''));

  function expand(node, path, seen) {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`, seen));
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name}`;
      let instance = instances.get(key);
      if (!instance) { instance = { slots: [], index: 0, live: true }; instances.set(key, instance); }
      instance.index = 0;
      seen.add(key);
      const parent = current;
      current = instance;
      const output = node.type(node.props);
      current = parent;
      return expand(output, `${path}/out`, seen);
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}/children`, seen) } };
  }
  const renderOnce = () => {
    dirty = false;
    const seen = new Set();
    tree = expand({ type: root, props }, 'root', seen);
    for (const [key, instance] of instances) {
      if (seen.has(key)) continue;
      instance.live = false;
      for (const slot of instance.slots) slot?.cleanup?.();
      instances.delete(key);
    }
  };
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) {
      if (dirty) renderOnce();
      for (const effect of pending.splice(0)) effect();
      await Promise.resolve();
    }
    if (dirty) renderOnce();
    return tree;
  };
  return {
    api, t, timers,
    async mount(Component, next) { root = Component; props = { t, ...next }; renderOnce(); return flush(); },
    // Return the first render separately: useEffect must not be required to remove old-session data.
    first(next) { props = { ...props, ...next }; renderOnce(); return tree; },
    async render(next = {}) { this.first(next); return flush(); },
    flush,
    get tree() { return tree; },
    advance(ms) {
      const until = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        time = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.fn();
      }
      time = until;
    },
    now: () => time,
    unmount() {
      for (const instance of instances.values()) {
        instance.live = false;
        for (const slot of instance.slots) slot?.cleanup?.();
      }
      instances.clear();
    },
  };
}

function all(node, predicate) {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
  return [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];
}
const action = (node, name) => all(node, (entry) => entry.props?.['data-sc-action'] === name)[0];
const area = (node) => all(node, (entry) => entry.type === 'textarea')[0];
const text = (node) => {
  if (node == null || node === false) return '';
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' ? text(node.props?.children) : String(node);
};
const goal = (id = 'a', revision = 1, phase = 'active') => ({ goal: { id, revision, phase, objective: `Objective ${id}` }, roundsStarted: 2 });
const job = (id = 'j', status = 'running') => ({ id, status, kind: 'bash', label: `command ${id}`, startedAt: 90000, finishedAt: status === 'completed' ? 99000 : undefined });
const actions = (calls, result = { ok: true }) => Object.fromEntries(['edit', 'pause', 'resume', 'clear'].map((kind) => [kind, (...args) => {
  calls.push({ kind, args });
  return typeof result === 'function' ? result(kind) : result;
}]));

async function edit(h, value) {
  action(h.tree, 'edit').props.onClick();
  await h.flush();
  area(h.tree).props.onChange({ target: { value } });
  await h.flush();
}

test('goal drafts and captured callbacks cannot cross sessions or replacement goals', async () => {
  const h = harness();
  const a = [], b = [];
  await h.mount(h.api.GoalBlock, { sessionId: 'A', goal: goal(), activation: 'armed', actions: actions(a) });
  await edit(h, 'A draft');
  const oldSave = action(h.tree, 'save-goal').props.onClick;
  h.first({ sessionId: 'B', goal: goal('b'), actions: actions(b) });
  assert.equal(area(h.tree), undefined);
  oldSave();
  await h.flush();
  assert.equal(a.length + b.length, 0);
  await edit(h, 'B draft');
  h.first({ goal: goal('c') });
  assert.equal(area(h.tree), undefined);
  assert.match(text(h.tree), /Objective c/u);
});

test('edit preserves original revision so an intervening update reaches Host CAS', async () => {
  const h = harness();
  const calls = [];
  await h.mount(h.api.GoalBlock, { sessionId: 'A', goal: goal(), activation: 'armed', actions: actions(calls, { ok: false, error: { code: 'GOAL_STALE_REVISION', message: 'changed' } }) });
  await edit(h, 'mine');
  await h.render({ goal: goal('a', 2) });
  action(h.tree, 'save-goal').props.onClick();
  await h.flush();
  assert.equal(calls[0].args[0].revision, 1);
  assert.match(text(h.tree), /GOAL_STALE_REVISION/u);
  assert.equal(area(h.tree).props.value, 'mine');
});

test('late goal success and failure do not close or poison a replacement editor', async () => {
  for (const result of [{ ok: true }, { ok: false, error: { code: 'old', message: 'old failure' } }]) {
    const h = harness();
    const pending = deferred();
    await h.mount(h.api.GoalBlock, { sessionId: 'A', goal: goal(), activation: 'armed', actions: actions([], pending.promise) });
    await edit(h, 'old draft');
    action(h.tree, 'save-goal').props.onClick();
    await h.flush();
    await h.render({ sessionId: 'B', goal: goal('b'), actions: actions([]) });
    await edit(h, 'new draft');
    pending.resolve(result);
    await h.flush();
    assert.equal(area(h.tree).props.value, 'new draft');
    assert.equal(all(h.tree, (node) => node.props.role === 'alert').length, 0);
    assert.equal(action(h.tree, 'save-goal').props.disabled, false);
  }
});

test('active activation unknown is neutral; disarmed offers Continue and armed offers Pause', async () => {
  const h = harness();
  await h.mount(h.api.GoalBlock, { sessionId: 'A', goal: goal(), actions: actions([]) });
  assert.equal(action(h.tree, 'pause'), undefined);
  assert.equal(action(h.tree, 'play'), undefined);
  await h.render({ activation: 'disarmed' });
  assert.ok(action(h.tree, 'play'));
  assert.equal(action(h.tree, 'pause'), undefined);
  assert.match(text(h.tree), /待继续/u);
  await h.render({ activation: 'armed' });
  assert.ok(action(h.tree, 'pause'));
  assert.equal(action(h.tree, 'play'), undefined);
});

function activationRuntime(get) {
  const listeners = new Set();
  const resets = new Set();
  return {
    goals: { get },
    remote: { $on(name, listener) { assert.equal(name, 'goal/activation-changed'); listeners.add(listener); return () => listeners.delete(listener); } },
    subscribeReset(listener) { resets.add(listener); return () => resets.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
    reset() { for (const listener of resets) listener(); },
    listeners, resets,
  };
}

test('official get restores activation, events override older reads, and revision mismatch stays unknown', async () => {
  const h = harness();
  const pending = deferred();
  let reads = 0;
  const runtime = activationRuntime(() => { reads += 1; return reads === 1 ? pending.promise : Promise.resolve({ ok: true, value: { id: 'a', revision: 1, activation: 'armed' } }); });
  const Probe = (props) => h.api.useGoalActivation(props.runtime, props.sessionId, props.goal, props.running) ?? 'unknown';
  await h.mount(Probe, { runtime, sessionId: 'A', goal: goal(), running: false });
  assert.equal(h.tree, 'unknown');
  runtime.emit({ sessionId: 'A', goal: { id: 'a', revision: 1, activation: 'disarmed' } });
  await h.flush();
  assert.equal(h.tree, 'disarmed');
  pending.resolve({ ok: true, value: { id: 'a', revision: 1, activation: 'armed' } });
  await h.flush();
  assert.equal(h.tree, 'disarmed');
  runtime.reset();
  await h.flush();
  assert.equal(h.tree, 'armed');
  h.first({ goal: goal('a', 2) });
  assert.equal(h.tree, 'unknown');
  await h.flush();
  assert.equal(h.tree, 'unknown');
  h.unmount();
  assert.equal(runtime.listeners.size + runtime.resets.size, 0);
});

test('a late activation read from a previous session cannot change current activation', async () => {
  const h = harness();
  const a = deferred();
  const runtime = activationRuntime((id) => id === 'A' ? a.promise : { ok: true, value: { id: 'b', revision: 1, activation: 'disarmed' } });
  const Probe = (props) => h.api.useGoalActivation(props.runtime, props.sessionId, props.goal, false) ?? 'unknown';
  await h.mount(Probe, { runtime, sessionId: 'A', goal: goal() });
  await h.render({ sessionId: 'B', goal: goal('b') });
  a.resolve({ ok: true, value: { id: 'a', revision: 1, activation: 'armed' } });
  await h.flush();
  assert.equal(h.tree, 'disarmed');
  runtime.emit({ sessionId: 'A', goal: { id: 'a', revision: 1, activation: 'armed' } });
  await h.flush();
  assert.equal(h.tree, 'disarmed');
});

test('stop remains pending beyond four seconds, prevents duplicates, and displays late failure', async () => {
  const h = harness();
  const pending = deferred();
  const calls = [];
  const jobs = { kill(...args) { calls.push(args); return pending.promise; } };
  await h.mount(h.api.JobsBlock, { sessionId: 'A', jobs, rows: [job()] });
  action(h.tree, 'stop-job').props.onClick();
  await h.flush();
  action(h.tree, 'stop-job').props.onClick();
  action(h.tree, 'stop-job').props.onClick();
  await h.flush();
  h.advance(6000);
  await h.flush();
  assert.equal(action(h.tree, 'stop-job').props['data-kill-state'], 'pending');
  assert.equal(action(h.tree, 'stop-job').props.disabled, true);
  action(h.tree, 'stop-job').props.onClick();
  await h.flush();
  assert.equal(calls.length, 1);
  pending.resolve({ ok: false });
  await h.flush();
  assert.equal(action(h.tree, 'stop-job').props['data-kill-state'], 'failed');
  assert.match(action(h.tree, 'stop-job').props.title, /停止失败/u);
});

test('stop catches synchronous throws and rejected promises; stopping jobs cannot be stopped', async () => {
  for (const kill of [() => { throw new Error('sync'); }, () => Promise.reject(new Error('async'))]) {
    const h = harness();
    await h.mount(h.api.JobsBlock, { sessionId: 'A', jobs: { kill }, rows: [job()] });
    action(h.tree, 'stop-job').props.onClick();
    await h.flush();
    action(h.tree, 'stop-job').props.onClick();
    await h.flush();
    assert.equal(action(h.tree, 'stop-job').props['data-kill-state'], 'failed');
  }
  const h = harness();
  let calls = 0;
  await h.mount(h.api.JobsBlock, { sessionId: 'A', jobs: { kill() { calls += 1; } }, rows: [{ ...job('j', 'stopping'), progress: 'outdated progress' }] });
  assert.match(text(h.tree), /正在停止/u);
  assert.doesNotMatch(text(h.tree), /outdated progress/u);
  assert.equal(action(h.tree, 'stop-job').props.disabled, true);
  action(h.tree, 'stop-job').props.onClick();
  await h.flush();
  assert.equal(calls, 0);
});

test('interleaved jobs keep independent confirmation and failure deadlines', async () => {
  const h = harness();
  await h.mount(h.api.JobsBlock, { sessionId: 'A', jobs: { kill: () => ({ ok: false }) }, rows: [job('first'), job('second')] });
  const stops = () => all(h.tree, (node) => node.props?.['data-sc-action'] === 'stop-job');
  stops()[0].props.onClick();
  await h.flush();
  h.advance(2000);
  stops()[1].props.onClick();
  await h.flush();
  h.advance(1000);
  await h.flush();
  assert.equal(stops()[0].props['data-kill-state'], 'idle');
  assert.equal(stops()[1].props['data-kill-state'], 'armed');
  stops()[1].props.onClick();
  await h.flush();
  assert.equal(stops()[1].props['data-kill-state'], 'failed');
  h.advance(2000);
  stops()[0].props.onClick();
  await h.flush();
  h.advance(2000);
  await h.flush();
  assert.equal(stops()[1].props['data-kill-state'], 'idle');
  assert.equal(stops()[0].props['data-kill-state'], 'armed');
});

test('switching sessions resets armed stop, local clear, expansion, and ignores old responses', async () => {
  const h = harness();
  const pending = deferred();
  const jobs = { kill: () => pending.promise };
  const rows = [job(), job('done', 'completed')];
  await h.mount(h.api.JobsBlock, { sessionId: 'A', jobs, rows });
  action(h.tree, 'toggle-settled-jobs').props.onClick();
  await h.flush();
  action(h.tree, 'clear-settled-jobs').props.onClick();
  action(h.tree, 'stop-job').props.onClick();
  await h.flush();
  action(h.tree, 'stop-job').props.onClick();
  await h.flush();
  h.first({ sessionId: 'B', rows });
  assert.equal(action(h.tree, 'stop-job').props['data-kill-state'], 'idle');
  assert.equal(action(h.tree, 'toggle-settled-jobs').props['aria-expanded'], false);
  await h.flush();
  action(h.tree, 'stop-job').props.onClick();
  await h.flush();
  pending.resolve({ ok: false });
  await h.flush();
  assert.equal(action(h.tree, 'stop-job').props['data-kill-state'], 'armed');
});

test('jobs rows switch on the first render and release the previous watcher/subscription', async () => {
  const h = harness();
  const rows = { A: [job('a')], B: [job('b')] };
  const listeners = new Set();
  const watched = [];
  const unwatched = [];
  const jobs = {
    state: { getSnapshot: () => ({ rows }), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    watchRows(id) { watched.push(id); return () => unwatched.push(id); },
  };
  const Probe = ({ jobs, sessionId }) => h.api.useJobsRows(jobs, sessionId).map((row) => row.id).join(',');
  await h.mount(Probe, { jobs, sessionId: 'A' });
  const oldListener = [...listeners][0];
  h.first({ sessionId: 'B' });
  assert.equal(h.tree, 'b');
  await h.flush();
  oldListener();
  await h.flush();
  assert.equal(h.tree, 'b');
  assert.deepEqual(watched, ['A', 'B']);
  assert.deepEqual(unwatched, ['A']);
  h.unmount();
  assert.equal(listeners.size, 0);
  assert.deepEqual(unwatched, ['A', 'B']);
});

test('previous task group is read only, labelled with its actual turn, and defaults collapsed', async () => {
  const h = harness();
  const previous = { turn: 3, todos: [{ content: 'old task', status: 'completed' }] };
  await h.mount(h.api.PreviousTasksBlock, { sessionId: 'A', previous });
  assert.match(text(h.tree), /历史任务 · 第 3 轮/u);
  assert.doesNotMatch(text(h.tree), /old task/u);
  assert.equal(h.tree.props['data-sc-turn'], 3);
  action(h.tree, 'toggle-previous-tasks').props.onClick();
  await h.flush();
  assert.match(text(h.tree), /old task/u);
  await h.render({ previous: { ...previous, turn: 5 } });
  assert.doesNotMatch(text(h.tree), /old task/u);
  await h.render({ previous: null });
  assert.equal(h.tree, null);
});

test('sampled timings add elapsed time only to active category and never double count waitSince', () => {
  const h = harness();
  for (const [active, expected] of [['model', ['模型', '3s']], ['tool', ['工具', '4s']], ['wait', ['等你', '5s']]]) {
    const value = { timing: { turn: 1, modelMs: 1000, toolMs: 2000, waitMs: 3000, sampledAt: 98000, active, waitSince: 90000 } };
    const values = h.api.timingSegments(h.t, value, 100000);
    assert.equal(values.find((row) => row.name === expected[0]).value, expected[1]);
    assert.equal(values[0].value, '8s');
  }
  const completed = { timing: { turn: 1, modelMs: 1000, toolMs: 2000, waitMs: 3000, sampledAt: 98000, active: null } };
  assert.equal(h.api.timingSegments(h.t, completed, 200000)[0].value, '6s');
  const legacy = { timing: { turn: 1, modelMs: 1000, toolMs: 2000, waitMs: 3000, waitSince: 98000 } };
  assert.equal(h.api.timingSegments(h.t, legacy, 100000)[0].value, '8s');
});

test('timing second hand runs independently and stops after turn settlement', async () => {
  const h = harness();
  const Probe = ({ timing }) => h.api.useTimingNow(timing);
  const timing = { sampledAt: h.now(), active: 'tool', waitSince: null };
  await h.mount(Probe, { timing });
  h.advance(3000);
  await h.flush();
  assert.equal(h.tree, 103000);
  await h.render({ timing: { ...timing, active: null } });
  const frozen = h.tree;
  h.advance(5000);
  await h.flush();
  assert.equal(h.tree, frozen);
  assert.equal(h.timers.size, 0);
});
