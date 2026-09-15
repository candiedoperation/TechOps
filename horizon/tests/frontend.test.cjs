const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
const shell = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}
function context() {
  return vm.createContext({ state: { recruitingOverview: { run: { run_id: 'r1' } } },
    selectedRecruitingLogin: 'alice', recruitingDetailRequest: 0, render() {},
    document: { getElementById() { return null; } }, showToast() {}, encodeURIComponent });
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; }
test('late candidate response cannot replace the selected candidate', async () => {
  const ctx = context(), alice = deferred(), bob = deferred();
  ctx.requestJson = path => path.includes('/alice?') ? alice.promise : bob.promise;
  vm.runInContext(functionSource('loadRecruitingDetail'), ctx);
  const first = ctx.loadRecruitingDetail('alice');
  ctx.selectedRecruitingLogin = 'bob';
  const second = ctx.loadRecruitingDetail('bob');
  bob.resolve({candidate: {member_login: 'bob', run_id: 'r1'}}); await second;
  alice.resolve({candidate: {member_login: 'alice', run_id: 'r1'}}); await first;
  assert.equal(ctx.state.recruitingDetail.member_login, 'bob');
});
test('response from the previous run is discarded', async () => {
  const ctx = context(), response = deferred(); ctx.requestJson = () => response.promise;
  vm.runInContext(functionSource('loadRecruitingDetail'), ctx);
  const pending = ctx.loadRecruitingDetail('alice');
  ctx.state.recruitingOverview.run.run_id = 'r2';
  response.resolve({candidate: {member_login: 'alice', run_id: 'r1'}}); await pending;
  assert.equal(ctx.state.recruitingDetail, null);
});
test('saving a review fails closed on a mismatched selection or run', async () => {
  const ctx = context(); let requests = 0; ctx.requestJson = () => { requests++; };
  vm.runInContext(functionSource('saveRecruitingReview'), ctx);
  ctx.state.recruitingDetail = {member_login: 'bob', run_id: 'r1'};
  await ctx.saveRecruitingReview();
  ctx.state.recruitingDetail = {member_login: 'alice', run_id: 'old'};
  await ctx.saveRecruitingReview();
  assert.equal(requests, 0);
});
test('Profiles is not exposed as a main navigation or route', () => {
  assert.doesNotMatch(shell, /data-view="profiles"/);
  assert.doesNotMatch(source, /profiles:\s*'Profiles'/);
  assert.doesNotMatch(source, /segments\[0\] === 'profiles'/);
});

test('Recruiting tab is labeled Members', () => {
  const recruitingNav = shell.match(/<button class="nav-item" data-view="recruiting">[\s\S]*?<\/button>/)?.[0];
  assert.ok(recruitingNav, 'Recruiting navigation button should exist');
  assert.match(recruitingNav, /<span>Members<\/span>/);
  assert.doesNotMatch(recruitingNav, /<span>Recruiting<\/span>/);
});
