/**
 * Host state regressions: exclusive wall-clock accounting and read-only task history.
 * Run with `node --test test/host-state.mjs`.
 * @author liuh
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTiming, exportTiming, foldTiming, scanLog, sessionIndex, handleChangesRequest,
} from '../index.js';

const event = (type, time, data = {}) => ({ type, time, data });
const start = (time = 0, turn = 1) => event('turn/start', time, { turn });
const call = (time, callId, name = 'bash') => event('tool/call', time, { callId, name });
const result = (time, callId) => event('tool/result', time, { message: { source: { callId } } });
const end = (time, turn = 1) => event('turn/end', time, { turn });
const todo = (time, content, status = 'pending') => event('todo/write', time, {
  todos: content === null ? [] : [{ content, status }],
});
const indexed = (events) => events.map((item, seq) => ({ ...item, seq }));
const folded = (events) => events.reduce(foldTiming, emptyTiming());
const total = (timing) => timing.modelMs + timing.toolMs + timing.waitMs;
const durations = (timing) => ({ model: timing.modelMs, tool: timing.toolMs, wait: timing.waitMs });

function immutable(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') immutable(child);
  }
  return Object.freeze(value);
}

function session(events) {
  return { snapshotEvents: (from = 0) => events.slice(from) };
}

function context(sessions) {
  return {
    sessions: { get: (id) => sessions[id] },
    workspaceChanges: { summary: () => undefined },
    shell: {},
  };
}

test('two overlapping 2s tools take 3s of wall time', () => {
  const state = folded([start(), call(1000, 'a'), call(2000, 'b'), result(3000, 'a'), result(4000, 'b'), end(4000)]);
  assert.deepEqual(durations(exportTiming(state)), { model: 0, tool: 3000, wait: 0 });
});

test('closed and still-open parallel calls merge during live sampling', () => {
  const state = folded([start(), call(1000, 'a'), call(2000, 'b'), result(3000, 'a')]);
  const timing = exportTiming(state, 4000);
  assert.equal(timing.toolMs, 3000);
  assert.equal(timing.active, 'tool');
  assert.equal(timing.sampledAt, 4000);
  assert.equal(exportTiming(state).toolMs, 2000, 'default sampling must use the last event');
});

test('an unfinished model stream accrues time before assistant/message', () => {
  const state = folded([start(1000), event('step/start', 1200, { turn: 1, step: 1 })]);
  assert.equal(exportTiming(state, 3200).modelMs, 2000);
  assert.equal(exportTiming(state, 4200).modelMs, 3000);
  assert.equal(exportTiming(state, 4200).active, 'model');
  assert.equal(state.modelMs, 0, 'sampling must not mutate the replay state');
});

test('wait takes precedence over tools and tools over model', () => {
  const state = folded([
    start(), event('step/start', 0), call(2000, 'a'), call(3000, 'b'),
    event('approval/asked', 4000, { id: 'one' }), event('approval/asked', 5000, { id: 'two' }),
    call(5500, 'question', 'ask_user_question'), event('approval/decided', 6000, { id: 'one' }),
    event('approval/decided', 7000, { id: 'two' }), result(8000, 'question'),
    result(8500, 'a'), result(9000, 'b'), event('assistant/message', 10000), end(10000),
  ]);
  const timing = exportTiming(state);
  assert.deepEqual(durations(timing), { model: 3000, tool: 3000, wait: 4000 });
  assert.equal(total(timing), 10000);
});

test('open overlapping approvals and questions count once, including over closed waits', () => {
  const state = folded([
    start(), call(0, 'tool'), event('approval/asked', 1000, { id: 'a' }),
    call(2000, 'q1', 'ask_user_question'), event('approval/decided', 3000, { id: 'a' }),
    call(3500, 'q2', 'exit_plan_mode'),
  ]);
  const timing = exportTiming(state, 5000);
  assert.deepEqual(durations(timing), { model: 0, tool: 1000, wait: 4000 });
  assert.equal(timing.active, 'wait');
  assert.equal(timing.waitSince, 2000);
  assert.equal(timing.sampledAt, 5000);
});

test('ending a turn seals unfinished model, tool and wait spans', () => {
  const state = folded([
    start(), event('step/start', 0), call(2000, 'never-returned'),
    event('approval/asked', 4000, { id: 'unanswered' }), end(6000),
  ]);
  const atEnd = exportTiming(state);
  assert.deepEqual(durations(atEnd), { model: 2000, tool: 2000, wait: 2000 });
  assert.equal(atEnd.active, null);
  assert.equal(atEnd.waitSince, null);
  assert.equal(atEnd.sampledAt, 6000);
  assert.deepEqual(exportTiming(state, 600000), atEnd, 'idle time after turn/end is excluded');
  assert.deepEqual(exportTiming(foldTiming(state, result(9000, 'never-returned')), 9000), atEnd);
});

test('step/end without assistant/message seals an interrupted stream', () => {
  const state = folded([start(), event('step/start', 1000), event('step/end', 3000), end(5000)]);
  assert.equal(exportTiming(state).modelMs, 2000);
  assert.equal(exportTiming(state).active, null);
});

test('duplicate calls, results and approvals do not restart completed spans', () => {
  const state = folded([
    start(), call(1000, 'a'), call(1500, 'a'), result(3000, 'a'), result(4000, 'a'),
    call(4500, 'a'), event('approval/asked', 5000, { id: 'b' }),
    event('approval/asked', 5500, { id: 'b' }), event('approval/decided', 6000, { id: 'b' }),
    event('approval/decided', 7000, { id: 'b' }), event('approval/asked', 7500, { id: 'b' }), end(8000),
  ]);
  assert.deepEqual(durations(exportTiming(state)), { model: 0, tool: 2000, wait: 1000 });
});

test('empty ids and orphan results never create elapsed time', () => {
  const state = folded([
    start(), call(100, ''), call(200, null), result(300, 'missing'),
    event('approval/asked', 400, { id: '' }), event('approval/decided', 500, { id: 'missing' }), end(1000),
  ]);
  assert.deepEqual(durations(exportTiming(state)), { model: 0, tool: 0, wait: 0 });
});

test('call ids which match object prototype keys still pair correctly', () => {
  const state = folded([start(), call(1000, '__proto__'), call(2000, 'constructor'), result(3000, '__proto__'), result(4000, 'constructor'), end(5000)]);
  assert.equal(exportTiming(state).toolMs, 3000);
});

test('a new turn resets time and rejects late results from the old turn', () => {
  const state = folded([
    start(), call(1000, 'a'), end(2000), start(3000, 2), call(4000, 'a'),
    event('tool/result', 5000, { turn: 1, toolCallId: 'a' }),
  ]);
  assert.equal(exportTiming(state, 6000).toolMs, 2000);
  assert.equal(exportTiming(state, 6000).turn, 2);
  assert.equal(exportTiming(state, 6000).active, 'tool');
});

test('clock rollback and invalid event times do not produce negative intervals', () => {
  let state = folded([start(1000), call(2000, 'a'), result(1500, 'a')]);
  assert.equal(exportTiming(state, 1500).toolMs, 0);
  state = foldTiming(state, call(Number.NaN, 'ignored'));
  assert.equal(exportTiming(state, 3000).active, null);
  assert.equal(total(exportTiming(state)), 0);
});

test('replayed event seqs do not reset timing or duplicate history', () => {
  const events = indexed([start(), call(1000, 'a'), result(3000, 'a'), todo(4000, 'remember'), end(5000), start(6000, 2)]);
  const once = scanLog(events);
  assert.deepEqual(scanLog(events, once), once);
  const timing = events.reduce(foldTiming, emptyTiming());
  assert.deepEqual(events.reduce(foldTiming, timing), timing);
});

test('every possible batch split matches full replay and does not mutate earlier results', () => {
  const events = indexed([
    start(), event('step/start', 0), todo(500, 'original'), call(1000, 'a'), call(2000, 'b'),
    event('approval/asked', 2500, { id: 'q' }), todo(2700, 'original', 'completed'),
    result(3000, 'a'), event('approval/decided', 3500, { id: 'q' }), result(4000, 'b'),
    event('assistant/message', 4500), end(5000), start(6000, 2),
  ]);
  const expected = scanLog(events);
  for (let split = 0; split <= events.length; split += 1) {
    const first = immutable(scanLog(events.slice(0, split)));
    assert.deepEqual(scanLog(events.slice(split), first), expected, `split=${split}`);
  }
});

test('previousTodos appears only after a new turn and uses the last whole-list write', () => {
  const events = [start(0, 7), todo(100, 'first'), todo(200, 'first', 'completed'), end(300, 7)];
  const current = scanLog(events);
  assert.equal(current.previousTodos, null);
  const next = scanLog([start(400, 8)], current);
  assert.deepEqual(next.previousTodos, { turn: 7, todos: [{ content: 'first', status: 'completed' }] });
  assert.equal(next.currentTodos, null);
});

test('turns without writes keep history under its real original turn', () => {
  const state = scanLog([start(0, 3), todo(100, 'from turn 3'), start(200, 4), start(300, 5), start(400, 6)]);
  assert.equal(state.todoTurn, 6);
  assert.deepEqual(state.previousTodos, { turn: 3, todos: [{ content: 'from turn 3', status: 'pending' }] });
});

test('explicit empty list clears old snapshots instead of reviving them next turn', () => {
  const previous = scanLog([start(), todo(100, 'old'), start(200, 2), todo(300, 'new')]);
  assert.equal(previous.previousTodos.turn, 1);
  const cleared = scanLog([todo(400, null)], previous);
  assert.equal(cleared.previousTodos, null);
  assert.deepEqual(cleared.currentTodos, []);
  assert.equal(scanLog([start(500, 3), start(600, 4)], cleared).previousTodos, null);
});

test('cleared current snapshot cannot return as a historical nonempty list', () => {
  const state = scanLog([start(), todo(100, 'do not revive'), todo(200, null), start(300, 2)]);
  assert.equal(state.previousTodos, null);
});

test('a fresh write after clear can become a new historical snapshot', () => {
  const state = scanLog([start(), todo(100, 'old'), todo(200, null), todo(300, 'replacement'), start(400, 2)]);
  assert.deepEqual(state.previousTodos, { turn: 1, todos: [{ content: 'replacement', status: 'pending' }] });
});

test('unknown turns are never relabelled as a known current or historical turn', () => {
  const state = scanLog([todo(10, 'before start'), start(20, 1), todo(30, 'known'), start(40, null), todo(50, 'unknown'), start(60, 3)]);
  assert.deepEqual(state.previousTodos, { turn: 1, todos: [{ content: 'known', status: 'pending' }] });
  assert.equal(state.todoTurn, 3);
});

test('duplicate turn/start cannot hide a current todo snapshot', () => {
  const state = scanLog([start(0, 1), todo(100, 'keep current'), start(200, 1)]);
  assert.equal(state.previousTodos, null);
  assert.deepEqual(state.currentTodos, [{ content: 'keep current', status: 'pending' }]);
});

test('malformed writes do not replace valid whole-list snapshots', () => {
  const state = scanLog([
    start(), todo(100, 'valid'), event('todo/write', 200, { todos: null }),
    event('todo/write', 300, { todos: [{ content: 'wrong status', status: 'done' }] }), start(400, 2),
  ]);
  assert.deepEqual(state.previousTodos, { turn: 1, todos: [{ content: 'valid', status: 'pending' }] });
});

test('task history and timing remain independent across cached sessions and restart replay', () => {
  const eventsA = indexed([start(), todo(100, 'A'), end(200), start(300, 2)]);
  const eventsB = indexed([start(), todo(100, 'B'), end(200), start(300, 2)]);
  const ctx = context({ A: session(eventsA), B: session(eventsB) });
  const cache = new Map();
  assert.equal(sessionIndex(ctx, cache, 'A').previousTodos.todos[0].content, 'A');
  assert.equal(sessionIndex(ctx, cache, 'B').previousTodos.todos[0].content, 'B');
  eventsA.push({ ...todo(400, 'A latest'), seq: eventsA.length });
  eventsA.push({ ...start(500, 3), seq: eventsA.length });
  const grown = sessionIndex(ctx, cache, 'A');
  assert.equal(grown.previousTodos.turn, 2);
  assert.equal(grown.previousTodos.todos[0].content, 'A latest');
  assert.equal(sessionIndex(ctx, cache, 'B').previousTodos.todos[0].content, 'B');
  assert.deepEqual(sessionIndex(ctx, new Map(), 'A').previousTodos, grown.previousTodos);
  assert.deepEqual(sessionIndex(ctx, new Map(), 'A').timing, grown.timing);
});

test('the authenticated route samples now, exports history, and retains other fields', async () => {
  const events = indexed([start(0, 4), todo(100, 'previous'), end(200, 4), start(1000, 5), event('step/start', 1200)]);
  const ctx = context({ A: session(events) });
  const originalNow = Date.now;
  try {
    Date.now = () => 5000;
    const response = handleChangesRequest(ctx, new Map(), { url: 'http://localhost/api/status-card.changes?sessionId=A' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.timing.sampledAt, 5000);
    assert.equal(body.timing.modelMs, 3800);
    assert.equal(body.timing.active, 'model');
    assert.deepEqual(body.previousTodos, { turn: 4, todos: [{ content: 'previous', status: 'pending' }] });
    assert.deepEqual(body.files, []);
    assert.deepEqual(body.plans, []);
    assert.deepEqual(body.subagentTurns, {});
    assert.equal(body.total, 0);
  } finally {
    Date.now = originalNow;
  }
});

test('missing sessions have empty history and invalid coordinates still fail', async () => {
  const ctx = context({});
  const response = handleChangesRequest(ctx, new Map(), { url: 'http://localhost/api/status-card.changes?sessionId=missing' });
  const body = await response.json();
  assert.equal(body.previousTodos, null);
  assert.deepEqual(durations(body.timing), { model: 0, tool: 0, wait: 0 });
  assert.equal(body.timing.active, null);
  assert.equal(handleChangesRequest(ctx, new Map(), { url: 'http://localhost/api/status-card.changes' }).status, 400);
});
