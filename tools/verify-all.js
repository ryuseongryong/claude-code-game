#!/usr/bin/env node
'use strict';

// 짭가이 검증 하니스 전체 실행 러너 — `npm test` 가 이 파일을 부른다.
//
// 왜 있는가: 하니스는 시나리오를 하나씩만 돌렸고(`node tools/verify.js <이름>`),
// 자동 게이트가 아무것도 이걸 호출하지 않았다. 그 사이 `npm test` 는 CDK 스캐폴드가
// 남긴 본문이 전부 주석인 테스트 하나로 "1 passed" 를 냈다 — 아무것도 단정하지
// 않으면서 초록불을 주는, 이 프로젝트가 이미 세 번 당한 결함이다.
//
// 설계 결정:
//  - **순차 실행.** 병렬로 브라우저를 여러 개 띄우면 CPU 경합으로 rAF 프레임이
//    떨어져 타이밍 단정(loop 의 stepsAdvanced 28~32 등)이 간헐 실패한다. 방금
//    flaky 게이트를 고친 프로젝트에서 병렬화로 flakiness 를 들여오면 자기모순이다.
//  - **시나리오 목록은 verify.js 에서 받아온다**(`--list`). 여기에 복제하면 새
//    시나리오가 전체 실행에서 조용히 빠진다.
//  - **단정 수는 집계한다.** 하드코딩한 개수는 문서의 "시나리오 14개" 처럼 낡는다.
//  - **종료 코드가 권위다.** 출력 JSON 파싱은 정보 제공용이며, 파싱이 실패해도
//    자식의 실패를 통과로 바꾸지 않는다.
//
// 환경변수:
//   CJ_URL      검사 대상 URL. 주면 서버를 건드리지 않는다(배포본 검증용).
//   CJ_PORT     로컬 정적 서버 포트 (기본 8000. 8080은 이 머신의 IDE가 상시 점유)
//   CJ_TIMEOUT  시나리오 1개 제한 시간 ms (기본 120000)
//   CJ_ONLY     쉼표로 구분한 시나리오 이름만 실행

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERIFY = path.join(__dirname, 'verify.js');
const PORT = Number(process.env.CJ_PORT || 8000);
// 서버를 127.0.0.1 에 바인드하므로 URL 도 127.0.0.1 이어야 한다 — `localhost` 는
// ::1 로 먼저 풀릴 수 있고 그러면 IPv4 에만 바인드한 서버가 응답하지 않는다.
const TARGET = process.env.CJ_URL || `http://127.0.0.1:${PORT}/index.html`;
const TIMEOUT = Number(process.env.CJ_TIMEOUT || 120000);

function probe(url, timeoutMs) {
  const lib = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve) => {
    const req = lib.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;   // 우리가 띄운 서버만 담는다 — 남의 서버는 죽이지 않는다

function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  try { s.kill('SIGTERM'); } catch (_) { /* 이미 죽었다 */ }
}

async function ensureServer() {
  if (process.env.CJ_URL) return 'CJ_URL 지정 — 서버를 건드리지 않는다';
  if (await probe(TARGET, 1500)) return '이미 떠 있는 서버를 재사용';

  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: path.join(ROOT, 'frontend'),
    stdio: 'ignore',
  });
  let spawnErr = null;
  server.on('error', (e) => { spawnErr = e; });

  for (let i = 0; i < 40; i++) {           // 최대 ~6초
    if (spawnErr) break;
    await sleep(150);
    if (await probe(TARGET, 1000)) return `정적 서버를 직접 띄웠다 (포트 ${PORT})`;
  }
  stopServer();
  throw new Error(
    `정적 서버를 띄우지 못했다 (${spawnErr ? spawnErr.message : '준비 시간 초과'}).\n` +
    `  수동으로: cd frontend && python3 -m http.server ${PORT} &\n` +
    `  또는 다른 대상 지정: CJ_URL=<url> npm test`
  );
}

// 브라우저를 한 번 띄워 보고 끝낸다. 모듈 누락과 chromium 바이너리 누락은 서로
// 다른 에러를 내는데, 프리플라이트 없이는 둘 중 무엇이든 시나리오마다 15번 같은
// 실패로 반복되어 원인이 묻힌다. 비용 ~1초.
async function preflightBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (_) {
    throw new Error(
      'playwright-core 를 찾을 수 없다. `npm install` 로 devDependencies 를 설치하라.\n' +
      '  (이전에는 `npm i --no-save playwright-core` 를 안내했으나, --no-save 는\n' +
      '   package.json 에 기록하지 않아 다음 npm install 이 조용히 prune 한다.)'
    );
  }
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
  } catch (e) {
    throw new Error(
      'chromium 을 기동할 수 없다 — 브라우저 바이너리가 없거나 버전이 맞지 않는다.\n' +
      '  설치: npx playwright install chromium\n' +
      `  원인: ${String(e.message).split('\n')[0]}`
    );
  }
  const v = browser.version();
  await browser.close();
  return v;
}

function runScenario(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [VERIFY, name], {
      cwd: ROOT,
      env: { ...process.env, CJ_URL: TARGET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // 멈춘 브라우저 하나가 npm test 를 영원히 붙잡으면 게이트는 결국 꺼진다.
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT);
    child.on('error', (e) => { err += `spawn 실패: ${e.message}\n`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let total = null, failedLabels = [];
      try {
        const j = JSON.parse(out);
        if (Array.isArray(j.checks)) {
          total = j.checks.length;
          failedLabels = j.checks.filter((c) => !c.ok).map((c) => c.label);
        }
      } catch (_) { /* 정보 제공용일 뿐 — 판정은 아래 code 로 한다 */ }
      resolve({
        name,
        ok: !timedOut && code === 0,
        timedOut,
        code,
        total,
        failedLabels,
        out,
        err,
        ms: Date.now() - t0,
      });
    });
  });
}

(async () => {
  const listed = spawnSync(process.execPath, [VERIFY, '--list'], { cwd: ROOT, encoding: 'utf8' });
  if (listed.status !== 0) {
    console.error('시나리오 목록을 가져오지 못했다:');
    console.error((listed.stderr || '').trim() || `exit ${listed.status}`);
    process.exit(2);
  }
  let names = (listed.stdout || '').trim().split('\n').map((s) => s.trim()).filter(Boolean);
  if (process.env.CJ_ONLY) {
    const want = new Set(process.env.CJ_ONLY.split(',').map((s) => s.trim()).filter(Boolean));
    const unknown = [...want].filter((w) => !names.includes(w));
    if (unknown.length) {
      console.error(`CJ_ONLY 에 없는 시나리오: ${unknown.join(', ')}`);
      process.exit(2);
    }
    names = names.filter((n) => want.has(n));
  }
  // 0개를 돌리고 성공으로 끝나는 것은 우리가 지금 고치는 바로 그 결함이다.
  if (!names.length) {
    console.error('실행할 시나리오가 0개다 — 통과로 처리하지 않는다.');
    process.exit(2);
  }

  let note, browserVersion;
  try {
    browserVersion = await preflightBrowser();
    note = await ensureServer();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  console.log(`짭가이 검증 — 시나리오 ${names.length}개`);
  console.log(`  대상: ${TARGET}  (${note})`);
  console.log(`  chromium ${browserVersion}`);
  console.log('');

  const results = [];
  const t0 = Date.now();
  try {
    for (const name of names) {
      const r = await runScenario(name);
      results.push(r);
      const tag = r.ok ? 'PASS' : 'FAIL';
      const counts = r.total === null ? '' : ` 단정 ${r.total - r.failedLabels.length}/${r.total}`;
      const why = r.timedOut ? ' (제한 시간 초과)' : '';
      console.log(`  ${tag}  ${name.padEnd(22)} ${(r.ms / 1000).toFixed(1)}s${counts}${why}`);
    }
  } finally {
    stopServer();
  }

  const failed = results.filter((r) => !r.ok);
  const asserts = results.reduce((n, r) => n + (r.total || 0), 0);

  if (failed.length) {
    console.log('');
    console.log('='.repeat(64));
    for (const r of failed) {
      console.log(`FAIL ${r.name} (exit ${r.code}${r.timedOut ? ', 제한 시간 초과' : ''})`);
      if (r.failedLabels.length) console.log(`  실패한 단정: ${r.failedLabels.join(', ')}`);
      const detail = (r.err || '').trim() || (r.out || '').trim();
      if (detail) console.log(detail.split('\n').map((l) => '  ' + l).join('\n'));
      console.log('');
    }
  }

  console.log('');
  console.log(
    `${failed.length ? 'FAIL' : 'PASS'}  시나리오 ${results.length - failed.length}/${results.length}` +
    `, 단정 ${asserts}개, ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  process.exit(failed.length ? 1 : 0);
})();

process.on('SIGINT', () => { stopServer(); process.exit(130); });
process.on('SIGTERM', () => { stopServer(); process.exit(143); });
process.on('uncaughtException', (e) => {
  stopServer();
  console.error('러너 실패:', e.message);
  process.exit(2);
});
