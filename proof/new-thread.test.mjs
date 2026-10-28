import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { bounded, correlate, observedResponse, requireLiveConnection, selectedSession } from './new-thread.mjs';

const key = 'agent:main:dashboard:created', marker = 'NT186215-0123456789abcdef0123456789abcdef';
const request = (method, id, extra = {}) => ({ side: 'req', t: 1, conn: 'native', id,
  client: 'openclaw-macos', role: 'operator', method, key, ...extra });
const response = (method, id, extra = {}) => ({ ...request(method, id), side: 'res', ok: true, ...extra });
const fixture = () => [response('connect', 'connect', { t: 0 }),
  request('sessions.create', 'create'), response('sessions.create', 'create'),
  request('sessions.messages.subscribe', 'sub'), response('sessions.messages.subscribe', 'sub'),
  request('chat.history', 'history'), response('chat.history', 'history')];

test('RPC verdict accepts causal order within one wall-clock millisecond', () => assert.equal(correlate(fixture(), 1), key));
for (const [name, mutate] of [
  ['zero requests', r => []],
  ['duplicate create', r => [...r, { ...r[1], id: 'duplicate' }]],
  ['no connection admission', r => r.slice(1)],
  ['another connection admission', r => r.map(x => x.id === 'connect' ? { ...x, conn: 'other' } : x)],
  ['failed create', r => r.map(x => x.id === 'create' && x.side === 'res' ? { ...x, ok: false } : x)],
  ['wrong client', r => r.map(x => ({ ...x, client: 'browser' }))],
  ['wrong role', r => r.map(x => ({ ...x, role: 'node' }))],
  ['other connection', r => r.map(x => x.id === 'sub' ? { ...x, conn: 'other' } : x)],
  ['other selected session', r => r.map(x => x.id === 'sub' ? { ...x, key: 'agent:main:other' } : x)],
  ['selection before creation response', r => [...r.slice(0, 2), ...r.slice(3), r[2]]],
  ['missing selection receipt', r => r.filter(x => !(x.id === 'sub' && x.side === 'res'))],
]) test('RPC verdict rejects ' + name, () => assert.throws(() => correlate(mutate(fixture()), 1)));

const row = { key, sessionId: 'persisted', label: marker };
const ax = { complete: true, buttonCount: 1, enabled: true, selection: [[marker]] };
test('observer never substitutes a requested key for a missing canonical response', () => {
  const rows = fixture();
  rows[2] = { ...rows[2], ...observedResponse({ method: 'sessions.create', key }, { ok: true, payload: {} }) };
  assert.throws(() => correlate(rows, 1), /canonical creation key/);
});

test('real persisted label uniquely identifies the selected native row', () => {
  assert.deepEqual(selectedSession(new Set(), { sessions: [row] }, key, ax, marker), row);
});
for (const [name, rows, snapshot] of [
  ['no persisted session', [], ax],
  ['two new persisted sessions', [row, { ...row, key: 'other' }], ax],
  ['no durable session ID', [{ key, label: marker }], ax],
  ['missing observer label', [{ key, sessionId: 'persisted', label: 'New session' }], ax],
  ['incomplete AX read', [row], { ...ax, complete: false }],
  ['disabled New Thread', [row], { ...ax, enabled: false }],
  ['duplicate control', [row], { ...ax, buttonCount: 2 }],
  ['generic title on old selected row', [row], { ...ax, selection: [['New session']] }],
  ['multiple selected rows', [row], { ...ax, selection: [[marker], ['Main Session']] }],
]) test('selection verdict rejects ' + name, () => assert.throws(() =>
  selectedSession(new Set(), { sessions: rows }, key, snapshot, marker)));
test('an old generic New session row cannot satisfy identity or final stability checks', () => {
  const old = { key: 'agent:main:dashboard:old', sessionId: 'old', label: 'New session' };
  const after = { sessions: [old, row] };
  const before = new Set([old.key]);
  selectedSession(before, after, key, ax, marker);
  assert.throws(() => selectedSession(before, after, key, { ...ax, selection: [['New session']] }, marker));
});
test('missing and duplicated marker identity fail closed', () => {
  assert.throws(() => selectedSession(new Set(), { sessions: [row] }, key, ax));
  assert.throws(() => selectedSession(new Set(['old']), { sessions: [row, { ...row, key: 'old' }] }, key, ax, marker));
});
const live = { client: 'openclaw-macos', role: 'operator', admitted: true, closed: false, frontendState: 1, upstreamState: 1 };
test('live native admission is required independently of cached row/RPC history', () => requireLiveConnection(live));
for (const patch of [
  { client: 'browser' }, { role: 'node' }, { admitted: false }, { closed: true },
  { frontendState: 3 }, { upstreamState: 3 },
]) test('native liveness rejects ' + JSON.stringify(patch), () => {
  assert.throws(() => requireLiveConnection({ ...live, ...patch }));
});
test('missing current native connection cannot pass', () => assert.throws(() => requireLiveConnection()));

test('cleanup settlement is bounded', async () => {
  assert.equal(await bounded('ready', Promise.resolve(7), 100), 7);
  await assert.rejects(bounded('stuck', new Promise(() => {}), 10), /deadline exceeded/);
});

const axSource = await readFile(new URL('./new-thread-ax.js', import.meta.url), 'utf8');
function axFixture({ duplicate = false, enabled = true, unreadable = false } = {}) {
  let presses = 0, front = false;
  function element(values, children = []) {
    values = { ...values, AXChildren: children };
    const names = Object.keys(values);
    const attrs = () => names.map(name => ({ name: () => name }));
    attrs.byName = name => ({ value: () => {
      if (unreadable && name === 'AXRole') throw Error('AX read failed');
      return values[name];
    } });
    const actions = () => [{ name: () => 'AXPress' }];
    actions.byName = () => ({ perform: () => { presses++; } });
    return { attributes: attrs, actions };
  }
  const button = () => element({ AXRole: 'AXButton', AXIdentifier: 'chat-new-thread', AXEnabled: enabled });
  const row = element({ AXRole: 'AXRow', AXSelected: true }, [element({ AXRole: 'AXStaticText', AXValue: 'New session' })]);
  const window = element({ AXRole: 'AXWindow' }, duplicate ? [button(), button(), row] : [button(), row]);
  const proc = { windows: () => [window] };
  Object.defineProperty(proc, 'frontmost', { get: () => () => front, set: value => { front = value; } });
  const context = vm.createContext({ Application: () => ({ processes: { whose: () => () => [proc] } }) });
  vm.runInContext(axSource, context);
  return { invoke: action => JSON.parse(context.run(['42', action])), presses: () => presses };
}
test('AX helper performs exactly one action after a complete unique traversal', () => {
  const f = axFixture(); const result = f.invoke('click');
  assert.equal(result.complete, true); assert.equal(result.clicked, true); assert.equal(f.presses(), 1);
  assert.deepEqual(result.selection, [['New session']]);
});
for (const options of [{ duplicate: true }, { enabled: false }, { unreadable: true }])
  test('AX helper refuses invalid control: ' + JSON.stringify(options), () => {
    const f = axFixture(options); assert.throws(() => f.invoke('click')); assert.equal(f.presses(), 0);
  });
