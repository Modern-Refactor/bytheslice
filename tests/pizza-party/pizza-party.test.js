// tests/pizza-party/pizza-party.test.js
// scripts/pizza-party.js: the ticket counts (7.2.0 sections and pre-7.2.0 tickets), the stand-in dispatch count, a recorded run and the comparison table, against a throwaway BTS_HOME.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'pizza-party.js');
const { ticketCount, ticketCounts, standInDispatches } = require(SCRIPT);

const LEGACY_TICKET = [
  '# Order: Sample',
  '',
  '## Answers',
  '',
  '- **Host:** none: localhost',
  '',
  '## Decisions made without you',
  '',
  '- menu · picked magic-link auth · single private user',
  '- pizzas · 3 pies · small brief',
  '',
  '## Deferred',
  '',
  '- 3.2 · photo estimates · no vision provider',
  '',
  '## Progress',
  '',
  '- shop · done · scaffolded',
].join('\n');

const TICKET = [
  '# Order: Sample',
  '',
  '## Answers',
  '',
  '- **Host:** none: localhost',
  '',
  '## Your call',
  '',
  '- create-menu · single user, no sharing · default: sharing off · to change: turn on SHARING in settings · brief says private · stand-in',
  '- cook-pizzas · CSV export cut from MVP · default: deferred to Pie 4 · to change: add it back with /special-order · keeps the MVP small · no stand-in: budget spent',
  '- sell-pie 3.2 · reminder emails off · default: console email only · to change: set EMAIL_PROVIDER · nothing reaches real people',
  '',
  '## Decided by the team',
  '',
  '- menu · picked magic-link auth · single private user',
  '- pizzas · 3 pies · small brief',
  '',
  '## Waiting on the stand-in',
  '',
  '',
  '## Deferred',
  '',
  '- 3.2 · photo estimates · no vision provider',
  '',
  '## Progress',
  '',
  '- shop · done · scaffolded',
  '- create-menu · stand-in 1 of 8 · 2 answered, 1 overridden, 0 deferred',
].join('\n');

test('the ticket counts list items under one section only', () => {
  assert.equal(ticketCount(TICKET, 'Your call'), 3);
  assert.equal(ticketCount(TICKET, 'Decided by the team'), 2);
  assert.equal(ticketCount(TICKET, 'Waiting on the stand-in'), 0);
  assert.equal(ticketCount(TICKET, 'Deferred'), 1);
  assert.equal(ticketCount(TICKET, 'Missing section'), 0);
  assert.deepEqual(ticketCounts(TICKET), { decisions: 5, yourCall: 3, teamDecisions: 2, waiting: 0, deferred: 1 });
});

test('a pre-7.2.0 ticket counts its old section as team decisions', () => {
  assert.equal(ticketCount(LEGACY_TICKET, 'Decisions made without you'), 2);
  assert.deepEqual(ticketCounts(LEGACY_TICKET), { decisions: 2, yourCall: 0, teamDecisions: 2, waiting: 0, deferred: 1 });
});

test('a heading matches whole: a name that starts another heading never counts it', () => {
  const text = [
    '## Waiting on the stand-in',
    '',
    '- create-menu-1 · create-menu · who may see shared lists? · provisional: owner only · blocking: no',
    '',
    '## Waiting on the stand-in later',
    '',
    '- x · y · z · provisional: a · blocking: no',
    '- x · y · z · provisional: b · blocking: no',
    '',
    '## Deferred items',
    '',
    '- not counted',
    '',
    '## Deferred  ',
    '',
    '- 2.1 · needs credentials · local substitute impossible',
    '',
    '## Your call (2)',
    '',
    '- not counted either',
  ].join('\r\n');
  assert.equal(ticketCount(text, 'Waiting on the stand-in'), 1);
  assert.equal(ticketCount(text, 'Deferred'), 1);
  assert.equal(ticketCount(text, 'Decided'), 0);
  assert.equal(ticketCount(text, 'Your call'), 0);
  // Regex characters in a heading are literal.
  assert.equal(ticketCount('## Your call (2)\n\n- one', 'Your call (2)'), 1);
  assert.equal(ticketCount('## Your callX\n\n- one', 'Your call.'), 0);
});

test('stand-in dispatches count from the kitchen log and the ledger rollups, the larger of the two', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-app-'));
  assert.equal(standInDispatches(app), 0);
  const kitchen = path.join(app, '.claude', '.bytheslice-state', 'kitchen');
  fs.mkdirSync(kitchen, { recursive: true });
  const start = (t, agent, aid) => JSON.stringify({ t, ev: 'SubagentStart', sid: 's1', agent, aid });
  fs.writeFileSync(path.join(kitchen, 'activity.1.jsonl'), `${start(1, 'bytheslice:stand-in-operator', 'a1')}\n`);
  fs.writeFileSync(
    path.join(kitchen, 'activity.jsonl'),
    [
      start(2, 'bytheslice:stand-in-operator', 'a2'),
      start(2, 'bytheslice:stand-in-operator', 'a2'),
      start(3, 'stand-in-operator', 'a3'),
      JSON.stringify({ t: 4, ev: 'SubagentStop', sid: 's1', agent: 'bytheslice:stand-in-operator', aid: 'a3' }),
      start(5, 'bytheslice:implementer', 'a4'),
      '{"torn',
    ].join('\n'),
  );
  assert.equal(standInDispatches(app), 3);
  const ledgerDir = path.join(app, '.bytheslice');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const rollup = (t, slice, count) =>
    JSON.stringify({ v: 1, t, sid: 's1', ev: 'slice.rollup', slice, data: { agents: { 'stand-in-operator': { count, tok: 0, ms: 0 } }, fixLoops: 0, tokens: 0, ms: 0 } });
  // 2.1 rolled up twice (its newest says 3), 2.2 once: 5 in all, above the log's 3.
  fs.writeFileSync(path.join(ledgerDir, 'ledger.jsonl'), [rollup(10, '2.1', 1), rollup(11, '2.1', 3), rollup(12, '2.2', 2)].join('\n'));
  assert.equal(standInDispatches(app), 5);
});

test('a recorded run lands in the run log and the table compares runs of one brief', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-party-'));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-app-'));
  fs.mkdirSync(path.join(app, 'docs', 'pizza-party'), { recursive: true });
  fs.writeFileSync(path.join(app, 'docs', 'pizza-party', 'order.md'), TICKET);
  const kitchen = path.join(app, '.claude', '.bytheslice-state', 'kitchen');
  fs.mkdirSync(kitchen, { recursive: true });
  fs.writeFileSync(path.join(kitchen, 'activity.jsonl'), `${JSON.stringify({ t: 1, ev: 'SubagentStart', sid: 's1', agent: 'bytheslice:stand-in-operator', aid: 'a1' })}\n`);
  const env = { ...process.env, BTS_HOME: home };
  const run = extra =>
    execFileSync(process.execPath, [SCRIPT, 'record', app, '--brief', 'sample-app', '--model', 'claude-sonnet-5-5', ...extra], { env, encoding: 'utf8' });
  const first = JSON.parse(run(['--outcome', 'shipped', '--url', 'http://localhost:3000', '--url-kind', 'localhost', '--acceptance', '9/10']));
  assert.equal(first.outcome, 'shipped');
  assert.equal(first.v, 1);
  assert.equal(first.decisions, 5);
  assert.equal(first.yourCall, 3);
  assert.equal(first.teamDecisions, 2);
  assert.equal(first.waiting, 0);
  assert.equal(first.deferred, 1);
  assert.equal(first.standInDispatches, 1);
  assert.equal(first.urlKind, 'localhost');
  run(['--outcome', 'nonsense']);
  const lines = fs.readFileSync(path.join(home, 'pizza-party', 'runs.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).outcome, 'partial');
  const table = execFileSync(process.execPath, [SCRIPT, 'runs', '--brief', 'sample-app'], { env, encoding: 'utf8' });
  assert.match(table, /\| Date \| Brief \|/);
  assert.match(table, /\| Decisions \| Your call \| Deferred \|/);
  assert.match(table, /\| 5 \| 3 \| 1 \|/);
  assert.equal(table.trim().split('\n').length, 4);
  assert.match(table, /http:\/\/localhost:3000/);
  const none = execFileSync(process.execPath, [SCRIPT, 'runs', '--brief', 'other'], { env, encoding: 'utf8' });
  assert.match(none, /No pizza-party runs recorded for other/);
});

test('preflight names providers alphabetically and never prefers one', () => {
  const { PROVIDERS } = require(SCRIPT);
  for (const list of Object.values(PROVIDERS)) {
    const names = list.map(p => p.name);
    assert.deepEqual(names, [...names].sort());
  }
});
