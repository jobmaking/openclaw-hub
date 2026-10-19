'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { snapshotScript, openScript, pendingItems, HubNotifications } = require('../notifications.cjs');

const item = (changes = {}) => ({ kind: 'question', id: 'q-1', agentId: 'bu', sessionKey: 'chat-a',
  agentName: 'Bu', summary: '¿Qué opción prefieres?', phase: 'pending', status: 'pending', ...changes });
const snapshot = (items = [item()], user = 'test-user') => ({ status: 'ready', user, items });
function fixture() {
  const shown = [], opened = [], states = [], failures = [];
  const center = new HubNotifications({ create: options => {
    const notification = new EventEmitter(); notification.options = options;
    notification.show = () => { shown.push(notification); notification.emit('show'); };
    notification.close = () => { notification.closed = true; notification.emit('close'); };
    return notification;
  }, open: request => opened.push(request), status: state => states.push(state), failed: () => failures.push(true) });
  return { center, shown, opened, states, failures };
}

test('pending questions and permissions notify once; resolution withdraws their native notice', () => {
  const { center, shown, opened } = fixture();
  const values = [item(), item({ kind: 'approval', id: 'a-1', summary: 'Acceso al equipo' })];
  center.sync(snapshot(values)); center.sync(snapshot(values));
  assert.equal(shown.length, 2);
  assert.match(shown[1].options.title, /pide permiso/);
  shown[0].emit('click'); assert.equal(opened.length, 1);
  assert.equal(opened[0].targets[0].sessionKey, 'chat-a');
  center.sync(snapshot([]));
  assert.ok(shown.every(notification => notification.closed));
  shown[1].emit('click'); assert.equal(opened.length, 1);
  center.sync(snapshot(values)); assert.equal(shown.length, 2, 'a replay is not a new request');
});

test('optional questions are scoped to the transcript and never notify answered, dismissed or obsolete cards', () => {
  const { center, shown } = fixture();
  const optional = item({ kind: 'async', id: 'item-1', sourceSessionId: 'transcript-1', answerable: true });
  center.sync(snapshot([optional, item({ id: 'answered', answered: true }), item({ id: 'dismissed', dismissed: true }),
    item({ id: 'obsolete', answerable: false }), item({ id: 'expired', expiresAtMs: Date.now() - 1 }),
    item({ id: 'resolved', phase: 'resolved' }), item({ id: 'allowed', status: 'allowed' })]));
  assert.equal(shown.length, 1);
  center.sync(snapshot([{ ...optional, sourceSessionId: 'transcript-2' }]));
  assert.equal(shown.length, 2, 'same item ID after reset belongs to a different transcript');
  assert.equal(pendingItems(snapshot([{ ...optional, sourceSessionId: null }])).size, 0);
});

test('reloads, offline snapshots and declined permissions cannot replay or activate stale notices', () => {
  const { center, shown, opened } = fixture();
  center.sync(snapshot());
  center.sync(null); shown[0].emit('click');
  assert.equal(opened.length, 0); assert.equal(center.status, 'connecting');
  center.sync({ status: 'disconnected', user: 'test-user', items: [] });
  center.sync(snapshot()); assert.equal(shown.length, 1);
  center.sync(snapshot([item({ id: 'new' })]), { enabled: false });
  assert.equal(center.status, 'disabled'); assert.equal(shown.length, 1);
  center.sync(snapshot([item({ id: 'new' })])); assert.equal(shown.length, 2);
  center.sync(snapshot([item({ id: 'new-2' })]), { supported: false });
  assert.equal(center.status, 'unsupported'); assert.equal(shown.length, 2);
});

test('account changes close notices and keep deduplication and click identities separate', () => {
  const { center, shown, opened } = fixture();
  center.sync(snapshot());
  center.sync({ status: 'signed-out' });
  shown[0].emit('click'); assert.equal(opened.length, 0); assert.equal(center.user, null);
  center.sync(snapshot([item()], 'other-user'));
  shown[0].emit('click'); assert.equal(opened.length, 0);
  shown[1].emit('click'); assert.equal(opened[0].user, 'other-user');
  center.sync(snapshot()); assert.equal(shown.length, 2);
});

test('notification content is bounded, plain text and cannot contain terminal controls or body markup', () => {
  const { center, shown } = fixture();
  center.sync(snapshot([item({ summary: '<a href="file:///private">Texto</a>\u0000\u202e' + 'x'.repeat(500), agentName: 'Bu\n\u202e' })]));
  assert.equal(shown.length, 1);
  assert.ok(!shown[0].options.body.includes('<a'));
  assert.ok(shown[0].options.body.startsWith('&lt;a'));
  assert.ok(!/[\x00\u202e\n]/.test(shown[0].options.title + shown[0].options.body));
  assert.ok(shown[0].options.body.length < 250);
  assert.equal(pendingItems(snapshot([item({ sessionKey: '../../' + '\u0000' })])).size, 0);
});

test('a reconnect batch produces one summary, not a storm of historical banners', () => {
  const { center, shown, opened } = fixture();
  const values = Array.from({ length: 40 }, (_, index) => item({ id: 'q-' + index }));
  center.sync(snapshot(values)); center.sync(snapshot(values));
  assert.equal(shown.length, 1); assert.match(shown[0].options.body, /40 preguntas/);
  shown[0].emit('click'); assert.equal(opened[0].targets.length, 40);
  center.sync(snapshot([])); assert.equal(shown[0].closed, true);
});

test('native display failures are handled and ledger memory is bounded', () => {
  const { center, shown, failures } = fixture();
  center.sync(snapshot()); shown[0].emit('failed', {}, 'No notification daemon');
  assert.equal(center.status, 'error'); assert.equal(failures.length, 1);
  for (let account = 0; account < 6; account++) {
    for (let batch = 0; batch < 5; batch++) center.sync(snapshot(Array.from({ length: 300 }, (_, index) => item({ id: 'q-' + batch + '-' + index })), 'user-' + account));
  }
  assert.equal(center.ledgers.size, 4);
  assert.ok([...center.ledgers.values()].every(seen => seen.size <= 1000));
});

test('a failed native delivery is not marked read and can recover without a banner storm', () => {
  let time = 10000;
  const shown = [], failures = [];
  const center = new HubNotifications({ now: () => time, open() {}, failed: () => failures.push(true), create: () => {
    const notification = new EventEmitter();
    notification.close = () => notification.emit('close');
    notification.show = () => { shown.push(notification); if (shown.length === 1) notification.emit('failed'); else notification.emit('show'); };
    return notification;
  } });
  center.sync(snapshot()); assert.equal(center.status, 'error'); assert.equal(failures.length, 1);
  center.sync(snapshot()); assert.equal(center.status, 'error'); assert.equal(shown.length, 1);
  assert.equal(center.ledgers.get('test-user').size, 0);
  time += 5000; center.sync(snapshot());
  assert.equal(shown.length, 2); assert.equal(center.status, 'ready');
  center.sync(snapshot()); assert.equal(shown.length, 2);
});

test('snapshot reads the reconciled list even when minimized and excludes answers and drafts', () => {
  const request = { ...item(), questions: [{ question: 'Pregunta visible', answer: 'DO_NOT_COPY' }], answers: ['DO_NOT_COPY'] };
  const context = { state: { user: 'test-user', ws: { readyState: 1 }, agents: [], draft: 'DO_NOT_COPY', branding: {} },
    document: { hidden: true, getElementById: () => ({ classList: { contains: () => false } }) },
    questionAttentionItems: () => [request], openPendingQuestion() {} };
  const result = vm.runInNewContext(snapshotScript, context);
  assert.equal(result.status, 'ready'); assert.equal(result.items[0].summary, 'Pregunta visible');
  assert.ok(!JSON.stringify(result).includes('DO_NOT_COPY'));
  context.state.ws.readyState = 3; assert.equal(vm.runInNewContext(snapshotScript, context).status, 'disconnected');
  context.state.branding.capabilities = { push: false };
  assert.equal(vm.runInNewContext(snapshotScript, context).status, 'server-disabled');
  context.state.branding.capabilities.push = true; context.state.ws.readyState = 1;
  context.questionAttentionItems = () => Array.from({ length: 350 }, (_, index) => ({ ...request, id: 'q-' + index }));
  const bounded = vm.runInNewContext(snapshotScript, context);
  assert.equal(bounded.items.length, 300); assert.equal(bounded.items.at(-1).id, 'q-349');
});

test('notification click revalidates account and pending identity without answering or authorizing', async () => {
  const request = item(), opened = [];
  const context = { state: { user: 'test-user', ws: { readyState: 1 }, branding: {} },
    document: { getElementById: () => ({ classList: { contains: () => false } }) },
    questionAttentionItems: () => [request],
    openPendingQuestion: async value => { opened.push(value); context.state.agent = value.agentId; context.state.current = value.sessionKey; } };
  const click = { user: 'test-user', targets: [...pendingItems(snapshot()).values()] };
  assert.equal(await vm.runInNewContext(openScript(click), context), true); assert.equal(opened.length, 1);
  context.state.user = 'different-user';
  assert.equal(await vm.runInNewContext(openScript(click), context), false); assert.equal(opened.length, 1);
  context.state.user = 'test-user'; context.questionAttentionItems = () => [];
  assert.equal(await vm.runInNewContext(openScript(click), context), false); assert.equal(opened.length, 1);
});
