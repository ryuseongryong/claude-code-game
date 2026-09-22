// 짭가이 검증 하니스 — 헤드리스 브라우저로 게임을 실제로 돌려 상태와 픽셀을 측정한다.
//
// 이 프로젝트는 단위 테스트를 두지 않는다(명시적 제약). 대신 이 하니스가 유일한
// 자동 검증 수단이며, 게임 코드의 window.__dbg() 등 훅은 이 파일을 위해 존재한다.
//
// 사용법:
//   cd frontend && python3 -m http.server 8000 &
//   npm i --no-save playwright-core && npx playwright install chromium
//   node tools/verify.js <시나리오이름>
//
// 환경변수:
//   CJ_URL  검사할 URL (기본 http://localhost:8000/index.html)
//           배포본 검증: CJ_URL=https://<dist>.cloudfront.net/index.html
//   CJ_PW   playwright-core 모듈 경로 (기본: 자동 탐색)

function resolvePlaywright() {
  const candidates = [
    process.env.CJ_PW,
    'playwright-core',
    'playwright',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* 다음 후보 */ }
  }
  throw new Error(
    'playwright-core를 찾을 수 없다. `npm i --no-save playwright-core` 후 ' +
    '`npx playwright install chromium` 을 실행하거나 CJ_PW로 경로를 지정하라.'
  );
}
const { chromium } = resolvePlaywright();

const URL = process.env.CJ_URL || 'http://localhost:8000/index.html';

// CRITICAL 1 수정: 이전에는 러너가 scenario()의 반환값을 전혀 들여다보지 않고
// console 에러 유무로만 exit 코드를 정했다 — 그래서 시나리오 14개 중 12개는
// 어떤 결과를 내도 실패할 수 없었다(사람이 JSON을 눈으로 봐야만 알았다). 이제
// 시나리오는 api.check(label, ok, detail)로 자신이 주장하는 기대값을 직접
// 단정하고, 러너는 checks 배열을 보고 실패가 있으면 exit 1로 끝낸다.
const checks = [];

// 시나리오: async (page, api) => 출력할 객체
const api = {
  // CRITICAL 1: 시나리오가 자신의 "기대 결과"를 실제로 단정하게 하는 훅.
  // ok가 falsy면 checks에 실패로 기록되고, 러너가 그것으로 exit 1을 낸다.
  check: (label, ok, detail) => {
    checks.push({ label, ok: !!ok, detail: detail === undefined ? null : detail });
    return !!ok;
  },
  dbg: (page) => page.evaluate(() => window.__dbg()),
  // 키를 ms 동안 누른 상태로 유지한다. 물리는 실시간으로 흐른다.
  hold: async (page, key, ms) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
  },
  tap: (page, key) => page.keyboard.press(key),
  wait: (page, ms) => page.waitForTimeout(ms),
  shot: (page, name) => page.screenshot({ path: `/tmp/cj/${name}.png` }),
  // 논리 캔버스 좌표 (lx, ly)의 픽셀 색을 "#rrggbb"로 읽는다
  pixel: (page, lx, ly) => page.evaluate(([x, y]) => {
    const c = document.getElementById('game');
    const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
    const h = (n) => n.toString(16).padStart(2, '0');
    return '#' + h(d[0]) + h(d[1]) + h(d[2]);
  }, [lx, ly]),
  // Fix round 1 (CJK 침묵 실패) — 사각 영역 안에서 hexColor와 일치하는 픽셀 수를 센다.
  // measureText는 글리프가 없어도 0이 아닌 폭을 돌려주므로 레이아웃만으로는
  // "글자가 실제로 그려졌는지"를 알 수 없다 — 잉크 픽셀을 직접 세야 한다.
  inkCount: (page, rx, ry, rw, rh, hexColor) => page.evaluate(([x, y, w, h, hex]) => {
    const c = document.getElementById('game');
    const d = c.getContext('2d').getImageData(x, y, w, h).data;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === r && d[i + 1] === g && d[i + 2] === b) n++;
    }
    return n;
  }, [rx, ry, rw, rh, hexColor]),
};

const scenarios = {
  // Task 1
  loop: async (page) => {
    await page.evaluate(() => window.__pick(0));   // Task 2: 게임은 TITLE로 시작한다
    const a = await api.dbg(page);
    await api.wait(page, 500);
    const b = await api.dbg(page);
    await api.shot(page, 'loop');
    const stepsAdvanced = b.steps - a.steps;
    // 60Hz 고정 스텝으로 500ms는 30스텝이어야 한다. 브라우저 스케줄링 지터를
    // 감안해 28..32로 느슨하게 본다.
    api.check('loop.stepsAdvanced in 28..32', stepsAdvanced >= 28 && stepsAdvanced <= 32, stepsAdvanced);
    api.check('loop.scale === 2', b.scale === 2, b.scale);
    api.check('loop.w === 640', b.w === 640, b.w);
    api.check('loop.h === 360', b.h === 360, b.h);
    return { first: a, after500ms: b, stepsAdvanced };
  },

  // Task 1 — 탄 단계 상쇄가 tier대로 계산되는지
  cancel: async (page) => {
    await page.evaluate(() => window.__pick(0));   // Task 2: 게임은 TITLE로 시작한다
    await api.wait(page, 200);
    // 적탄만 남기고 내 탄을 통제하기 위해 전용 훅으로 탄을 직접 주입한다
    const beadVsNormal = await page.evaluate(() => window.__cancelProbe(1, 2));
    const beadVsBead   = await page.evaluate(() => window.__cancelProbe(1, 1));
    const phoenixVs2   = await page.evaluate(() => window.__cancelProbe(3, 2));
    await api.shot(page, 'cancel');
    // 세 티어 조합의 정확한 결과 — 최솟값 차감 규칙(cancelBullets)이 맞는지.
    api.check('cancel.beadVsNormal(1,2) pAlive===0', beadVsNormal.pAlive === 0, beadVsNormal);
    api.check('cancel.beadVsNormal(1,2) eTier===1', beadVsNormal.eTier === 1, beadVsNormal);
    api.check('cancel.beadVsBead(1,1) pAlive===0', beadVsBead.pAlive === 0, beadVsBead);
    api.check('cancel.beadVsBead(1,1) eAlive===0', beadVsBead.eAlive === 0, beadVsBead);
    api.check('cancel.phoenixVs2(3,2) pTier===1', phoenixVs2.pTier === 1, phoenixVs2);
    api.check('cancel.phoenixVs2(3,2) eAlive===0', phoenixVs2.eAlive === 0, phoenixVs2);
    return { beadVsNormal, beadVsBead, phoenixVs2 };
  },

  // Task 2 — 이동/클램프/대각선 정규화/발사/배경
  player: async (page) => {
    await page.evaluate(() => window.__pick(0));   // Task 2: 게임은 TITLE로 시작한다
    await api.wait(page, 200);
    const start = await api.dbg(page);

    // 우하단으로 충분히 길게 밀어 클램프 확인.
    // 산수 확인(CRITICAL 1 검증 중 발견): PLAYER_SPEED(150)를 대각선
    // 정규화하면 축당 106.07px/s이고, 2000ms 홀드로는 축당 212px만 간다.
    // 스폰 지점(x=60)에서 그대로 밀면 x~=272에 그쳐 604(W-PW)에 전혀 못
    // 미친다 — MINOR 7이 반대쪽(좌상단) 코너에서 잡은 것과 같은 결함이 이
    // 코너에도 있다("클램프 확인"이라는 이름이지만 실제로는 자유 이동만
    // 잰다). y는 스폰(162)에서 212px 가면 374로 324를 넘어 우연히 클램프에
    // 닿지만 x는 아니다. 같은 이유로 여기도 코너 가까이 __tp해 두 축 모두
    // 진짜로 클램프에 닿게 만든다 — MINOR 7이 좌상단에 적용한 것과 동일한
    // 처방이다.
    await page.evaluate(() => window.__tp(554, 274));
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowDown');
    await api.wait(page, 2000);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('ArrowDown');
    const clamped = await api.dbg(page);
    api.check('player.clamped px === 604 (W-PW)', clamped.px === 604, clamped.px);
    api.check('player.clamped py === 324 (H-PH)', clamped.py === 324, clamped.py);

    // 좌상단으로 클램프 (MINOR 7).
    // PLAYER_SPEED(150)를 대각선 정규화(106.07px/축/s)하면 2000ms 홀드로는
    // 212px만 간다. 위 우하단 클램프 지점(604,324)에서 그대로 왼쪽위로 밀면
    // x~=392, y~=112에서 멈춰 두 축 다 0에 못 닿는다(자유 이동을 재는 셈) —
    // 그래서 코너 가까이 __tp로 옮겨 두고 홀드해야 실제로 클램프(0,0)에
    // 닿는다. 이 시나리오 안의 다른 __tp 사용(위/아래)과 같은 패턴이다.
    await page.evaluate(() => window.__tp(50, 50));
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.down('ArrowUp');
    await api.wait(page, 2000);
    await page.keyboard.up('ArrowLeft');
    await page.keyboard.up('ArrowUp');
    const clampedTL = await api.dbg(page);
    api.check('player.clampedTL px === 0', clampedTL.px === 0, clampedTL.px);
    api.check('player.clampedTL py === 0', clampedTL.py === 0, clampedTL.py);

    // 대각선 정규화: 같은 시간 동안 순수 우향 이동과 대각 우하 이동의
    // x 증가량이 같아야 한다. 정규화가 없으면 대각선이 41% 더 간다.
    await page.evaluate(() => window.__tp(0, 100));
    await api.hold(page, 'ArrowRight', 500);
    const pureX = (await api.dbg(page)).px;
    await page.evaluate(() => window.__tp(0, 100));
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowDown');
    await api.wait(page, 500);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('ArrowDown');
    const diagX = (await api.dbg(page)).px;

    // 발사
    await api.hold(page, 'KeyZ', 400);
    const fired = await api.dbg(page);
    await api.shot(page, 'player');
    const diagRatio = +(diagX / pureX).toFixed(2);
    // Fix Round 2: 비율(diagRatio)에 좁은 밴드를 씌우면 __dbg의 px 정수 반올림이
    // 만드는 양자화(1/pureX 단위, 여기선 약 0.0133)가 비율에 그대로 실려 flaky해진다
    // (실측: 동일 코드 6회 중 1회, diagX=56/pureX=75=0.747로 0.68..0.73 밖). 노이즈가
    // 실제로 존재하는 차원(픽셀)에서 직접 단정한다: diagX는 이론상 pureX/sqrt(2)여야
    // 하고, 실측(동일 코드 6회) 편차는 최대 +3px(pureX 75~78, diagX 53~56)였다. 정규화가
    // 빠지면 diagX===pureX가 되어 편차가 약 +22px이므로, ±4px는 지터를 흡수하면서도
    // 버그와 5배 이상 떨어져 있어 여전히 확실히 잡는다.
    const theoDiagX = pureX / Math.SQRT2;
    api.check('player.diagX near pureX/sqrt2 (+-4px)',
      Math.abs(diagX - theoDiagX) <= 4,
      `diagX=${diagX} theo=${theoDiagX.toFixed(1)} pureX=${pureX}`);
    api.check('player.fired.pbullets > 0', fired.pbullets > 0, fired.pbullets);
    return { start, clamped, clampedTL, pureX, diagX, diagRatio, fired };
  },

  // Task 3 — 웨이브 스폰, 적 탄, 접촉=파워다운 / 피탄=사망 비대칭
  // Task 3 이후: buildStage(s)가 스테이지마다 패턴을 셔플해 뽑으므로 "1.0초에
  // oni x4"처럼 특정 타입/마리 수를 기대할 수 없다. enemies > 0으로 느슨하게 본다.
  combat: async (page) => {
    await page.evaluate(() => window.__pick(0));   // Task 2: 게임은 TITLE로 시작한다
    await api.wait(page, 200);
    const t0 = await api.dbg(page);

    // 첫 웨이브가 스폰되는지 (구체적 타입/마리 수는 스테이지마다 셔플되므로 보지 않는다)
    await api.wait(page, 2500);
    const wave1 = await api.dbg(page);
    const waveSpawned = wave1.enemies > 0;
    api.check('combat.waveSpawned (enemies>0)', waveSpawned, wave1.enemies);

    // 적 탄이 생성되는지
    await api.wait(page, 2000);
    const shooting = await api.dbg(page);
    await api.shot(page, 'combat');
    api.check('combat.shooting.ebullets > 0', shooting.ebullets > 0, shooting.ebullets);

    // 피탄 사망: 화면 중앙에 방치해 적 탄에 계속 노출시키고 라이프/파워가
    // 움직이는지 본다
    await page.evaluate(() => { window.__tp(320, 160); });
    await api.wait(page, 2500);
    const afterExposure = await api.dbg(page);
    // 비대칭 규칙의 핵심 절반: 적 탄에 노출되면 라이프가 줄어야 한다(본체
    // 접촉만으로는 파워만 깎이고 라이프는 불변인 나머지 절반은 bossContact가
    // 전담해 확인한다).
    api.check(
      'combat.afterExposure.lives < t0.lives (적탄 피격으로 라이프 감소)',
      afterExposure.lives < t0.lives,
      { before: t0.lives, after: afterExposure.lives }
    );

    return { t0, wave1, waveSpawned, shooting, afterExposure };
  },

  // 픽스 검증 1+3 — 보스 탄이 유한 좌표를 갖는가, 그리고 봄을 쓰지 않고도
  // 컬링되어 무한정 쌓이지 않는가 (index.html:408 CRITICAL 회귀 테스트).
  // 하니스가 이전에 놓친 함정: boss 시나리오는 ebullets=0을 봄을 쓴 뒤에만
  // 확인했다. 여기서는 봄을 쓰지 않는다.
  bossBulletsFinite: async (page) => {
    await page.evaluate(() => window.__pick(0));   // Task 2: 게임은 TITLE로 시작한다
    await api.wait(page, 200);
    // Task 3부터 보스는 스테이지 10/20/30에서만 나온다. __stage(30)은
    // enterStage를 통해 웨이브 없이(waves=[]) 보스만 즉시 소환하므로, 예전
    // __skipTo(30.9)가 만들던 "잔여 웨이브 폭주" 문제 자체가 없다. 그래도
    // 관찰 도중 GAMEOVER로 step()이 멈추는 것을 막기 위해 라이프는 넉넉히
    // 준다 — 이 테스트의 관심사는 라이프가 아니라 ebullets의 좌표/개수다.
    await page.evaluate(() => window.__stage(30));
    await page.evaluate(() => window.__setLives(999));
    await api.wait(page, 2500);           // 보스 등장 + 첫 몇 발 발사 시간
    const soon = await api.dbg(page);
    const soonEb = await page.evaluate(() => window.__eb());

    await api.wait(page, 10000);          // 잔여 웨이브 적이 화면 밖으로 빠질 시간
    const mid = await api.dbg(page);
    const midEb = await page.evaluate(() => window.__eb());

    await api.wait(page, 15000);          // 추가 관찰 — 탄이 계속 컬링되는지
    const late = await api.dbg(page);
    const lateEb = await page.evaluate(() => window.__eb());

    const allFinite = (arr) => arr.every((b) =>
      Number.isFinite(b.x) && Number.isFinite(b.y) &&
      Number.isFinite(b.vx) && Number.isFinite(b.vy));

    const soonR = { dbg: soon, ebCount: soonEb.length, allFinite: allFinite(soonEb), sample: soonEb.slice(0, 3) };
    const midR  = { dbg: mid,  ebCount: midEb.length,  allFinite: allFinite(midEb),  sample: midEb.slice(0, 3) };
    const lateR = { dbg: late, ebCount: lateEb.length, allFinite: allFinite(lateEb), sample: lateEb.slice(0, 3) };

    // v1 CRITICAL 회귀(b.h undefined -> NaN 좌표 -> 컬링 불가 -> 무한정 누적)를
    // 다시 잡는 단정. NaN이면 allFinite가 false가 되고, 컬링이 죽으면 ebCount가
    // 수천~수만으로 폭주한다(재현: soon 12 -> mid 9000 -> late 24000). 300은
    // 정상 범위(관찰상 수십 발)보다 훨씬 위이면서 그 폭주는 확실히 잡는 상한이다.
    for (const [label, r] of [['soon', soonR], ['mid', midR], ['late', lateR]]) {
      api.check(`bossBulletsFinite.${label}.allFinite`, r.allFinite, r.ebCount);
      api.check(`bossBulletsFinite.${label}.ebCount bounded (<300)`, r.ebCount < 300, r.ebCount);
    }

    return { soon: soonR, mid: midR, late: lateR };
  },

  // 픽스 검증 4 — 보스 본체 접촉이 파워를 깎고 무적을 세팅하는가 (라이프는
  // 불변이어야 함). __bossBox()로 보스를 추적하며 플레이어를 그 안에 계속
  // 겹쳐 둔다(보스 y가 사인 곡선으로 움직이므로 주기적으로 재정렬한다).
  bossContact: async (page) => {
    await page.evaluate(() => window.__pick(0));   // Task 2: 게임은 TITLE로 시작한다
    await api.wait(page, 200);
    // Task 3부터 보스는 스테이지 10/20/30에서만 나온다. __stage(30)은 웨이브
    // 없이 보스만 즉시 소환하므로 잔여 웨이브를 기다릴 필요가 없다.
    await page.evaluate(() => window.__stage(30));
    await page.evaluate(() => window.__setLives(999));
    await api.wait(page, 1500);            // 보스 등장 안정화
    await page.evaluate(() => window.__setLives(3));   // 라이프 불변을 보려면 기준선부터 3
    await page.evaluate(() => window.__setPower(3));
    const before = await api.dbg(page);

    const samples = [];
    for (let i = 0; i < 10; i++) {
      const placed = await page.evaluate(() => {
        // 접촉만 순수하게 보려면 보스 자신의 탄(텐마의 조준탄/나선탄)이 우연히
        // 명중해 라이프를 깎는 오염을 막아야 한다 — bossHudZOrder가 같은 이유로
        // 매 샘플 __clearEB()를 쓰는 것과 동일한 패턴이다.
        window.__clearEB();
        const box = window.__bossBox();
        if (!box) return null;
        window.__tp(box.x + box.w / 2 - 18, box.y + box.h / 2 - 18);
        return box;
      });
      await api.wait(page, 200);
      const snap = await api.dbg(page);
      samples.push({ box: placed, snap });
    }
    await api.shot(page, 'boss-contact');

    // CRITICAL 2 수정: 이전엔 __bossBox()가 null이면(보스가 안 뜬 경우) 조용히
    // __tp를 건너뛰고 그냥 통과했다 — bossHudZOrder:267과 같은 "대상 부재인데
    // 통과" 결함. 여기도 같은 가드를 건다.
    if (samples.some((s) => s.snap.bossName === null)) {
      throw new Error(`boss never spawned (bossName null) — samples: ${JSON.stringify(samples)}`);
    }

    const after = samples[samples.length - 1].snap;
    // 그리고 이 시나리오가 실제로 주장하는 것: 본체 접촉은 파워를 깎고
    // 라이프는 건드리지 않는다(비대칭 피격 규칙의 나머지 절반).
    api.check('bossContact.after.power < before.power', after.power < before.power,
      { before: before.power, after: after.power });
    api.check('bossContact.after.lives === before.lives', after.lives === before.lives,
      { before: before.lives, after: after.lives });

    return { before, samples, after };
  },

  // 픽스 검증 5 — 보스 HP 바가 플레이어 스프라이트 위에 그려지는가(z-순서).
  //
  // Ruling 3 재수정: 이전 버전은 __skipTo(30.9)를 썼는데, Task 3부터 보스는
  // 스테이지 10/20/30에서만 spawnBoss()로 소환된다 — __skipTo는 game.time만
  // 돌릴 뿐 스테이지를 바꾸지 않으므로 보스가 전혀 등장하지 않았다. 그런데도
  // 픽셀 단정은 값이 뭐든 형식만 맞으면 통과해 exit 0을 냈다(거짓 통과). 대상이
  // 등장하지 않아 통과하는 시나리오는 실패하는 시나리오보다 나쁘다 — 실패는
  // 보이지만 거짓 통과는 보이지 않는다. 게다가 Task 4가 barY를 30->44로
  // 내렸으므로 y30..36 가정 자체도 낡았다.
  //
  // 수정: __stage(30)으로 실제 보스 스테이지에 진입하고, 새 barY(44..50)와
  // 겹치도록 플레이어를 놓는다. 플레이어(MONK, 36x36, CELL=3)의 로브(R) 칸은
  // player.x=100, player.y=27일 때 x=125(col8)에서 row5(y42, 바 바깥)와
  // row6(y46, 바 안쪽) 양쪽 모두 로브색이다 — 그래서 바 안쪽에서 로브색이
  // 아니라 바 색이 보이면 진짜로 바가 플레이어 위에 그려졌다고 말할 수 있다
  // (바깥이 원래부터 투명했던 자리라 "덮인 적이 없다"는 반례를 배제한다).
  // 마지막으로 __dbg().bossName이 null이 아님을 시나리오 안에서 직접
  // 단정해, 대상이 없는데 통과하는 재발을 막는다.
  bossHudZOrder: async (page) => {
    await page.evaluate(() => window.__pick(0));   // Task 2: 게임은 TITLE로 시작한다
    await api.wait(page, 200);
    await page.evaluate(() => window.__stage(30));
    await page.evaluate(() => window.__setLives(999));
    await api.wait(page, 300);             // spawnBoss는 동기 호출이지만 렌더 안정화 여유
    await page.evaluate(() => window.__tp(100, 27)); // 로브 칸이 HP 바(y44..50)와 겹치도록

    const samples = [];
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.__clearEB());  // 텐마 탄이 우연히 같은 칸을 지나는 오염 방지
      await api.wait(page, 100);
      const barPixel = await api.pixel(page, 125, 46);   // 로브 칸 & HP 바 안(row6)
      const bodyPixel = await api.pixel(page, 125, 42);   // 같은 칸, 바 바깥(row5, 로브색 기대)
      const dbg = await api.dbg(page);
      samples.push({ barPixel, bodyPixel, bossName: dbg.bossName, bossHp: dbg.bossHp, invuln: dbg.invuln });
    }
    await api.shot(page, 'boss-hud-zorder');

    if (samples.some((s) => s.bossName === null)) {
      throw new Error(`boss never spawned (bossName null) — samples: ${JSON.stringify(samples)}`);
    }

    const barPixelAlwaysHud = samples.every((s) => s.barPixel === '#6fa88a' || s.barPixel === '#3a3631');
    const bodyPixelEverShowsPlayer = samples.some((s) => s.bodyPixel === '#d97757');
    // 두 불리언이 z-순서 주장을 함께 뒷받침해야 한다: 바 칸은 항상 HUD 색이고
    // (바가 위에 그려짐), 같은 칸이 바 바깥(row5)에서는 실제로 로브색을 보여야
    // (그 칸이 원래부터 비어있던 자리가 아니라는 대조군) 한다.
    api.check('bossHudZOrder.barPixelAlwaysHud', barPixelAlwaysHud, samples.map((s) => s.barPixel));
    api.check('bossHudZOrder.bodyPixelEverShowsPlayer', bodyPixelEverShowsPlayer, samples.map((s) => s.bodyPixel));

    return { samples, barPixelAlwaysHud, bodyPixelEverShowsPlayer };
  },

  // Task 2 — 캐릭터 3명이 각각 다른 탄을 내는지
  chars: async (page) => {
    const title = await api.dbg(page);
    await api.shot(page, 'title');
    // Fix round 1 — CJK 침묵 실패 회귀 방지: 스크린샷 육안 확인 대신 잉크
    // 픽셀을 직접 센다. HUD색(#E8E2D8) 픽셀이 각 텍스트 줄 영역에 실제로
    // 있어야 "글자가 그려졌다"고 말할 수 있다(measureText만으론 알 수 없다).
    const ink = {
      title:   await api.inkCount(page, 0, 40, 640, 40, '#e8e2d8'),   // "JJAPGAI"
      names:   await api.inkCount(page, 0, 195, 640, 20, '#e8e2d8'),  // TENGAI/KOYORI/HAGANE
      control: await api.inkCount(page, 0, 275, 640, 20, '#e8e2d8'),  // "< > SELECT    Z START"
    };
    const out = {};
    for (const i of [0, 1, 2]) {
      await page.evaluate((n) => { window.__pick(n); }, i);
      await page.evaluate(() => { window.__clearP(); });
      await api.hold(page, 'KeyZ', 300);
      await api.wait(page, 40);
      out[i] = await page.evaluate(() => {
        const b = window.__pb();
        return {
          count: b.length,
          tiers: [...new Set(b.map((x) => x.tier))].sort(),
          dmgs: [...new Set(b.map((x) => x.dmg))].sort(),
          anyVy: b.some((x) => Math.abs(x.vy || 0) > 1),
        };
      });
    }
    // CJK 침묵 실패 회귀 방지: 잉크가 실제로 찍혔는지(글자가 그려졌는지).
    api.check('chars.ink.title > 0', ink.title > 0, ink.title);
    api.check('chars.ink.names > 0', ink.names > 0, ink.names);
    api.check('chars.ink.control > 0', ink.control > 0, ink.control);

    // 캐릭터별 무장 특성 — tier/dmg/anyVy는 각 캐릭터의 무장 구현(440-505행)이
    // 실제로 다른지를 증명한다.
    api.check('chars[0](TENGAI).count > 0', out[0].count > 0, out[0].count);
    api.check('chars[0](TENGAI).tiers === [1]', JSON.stringify(out[0].tiers) === '[1]', out[0].tiers);
    api.check('chars[0](TENGAI).dmgs === [1]', JSON.stringify(out[0].dmgs) === '[1]', out[0].dmgs);
    api.check('chars[0](TENGAI).anyVy === false (직선 염주)', out[0].anyVy === false, out[0].anyVy);

    api.check('chars[1](KOYORI).count > 0', out[1].count > 0, out[1].count);
    api.check('chars[1](KOYORI).tiers === [1]', JSON.stringify(out[1].tiers) === '[1]', out[1].tiers);
    api.check('chars[1](KOYORI).anyVy === true (3방향 확산)', out[1].anyVy === true, out[1].anyVy);

    api.check('chars[2](HAGANE).count > 0', out[2].count > 0, out[2].count);
    api.check('chars[2](HAGANE).tiers === [2]', JSON.stringify(out[2].tiers) === '[2]', out[2].tiers);
    api.check('chars[2](HAGANE).dmgs === [2] (SPEAR_DMG+power-1)', JSON.stringify(out[2].dmgs) === '[2]', out[2].dmgs);
    api.check('chars[2](HAGANE).anyVy === false (직선 창)', out[2].anyVy === false, out[2].anyVy);

    return { title, ink, out };
  },

  // Task 3 — 스테이지 구성, 난이도 배율, 막 전환
  stages: async (page) => {
    await page.evaluate(() => window.__pick(0));
    const s1 = await api.dbg(page);
    // 같은 스테이지를 두 번 만들면 패턴 순서가 달라야 한다(셔플)
    const shuffleCheck = await page.evaluate(() => {
      const a = window.__stageWaves(5), b = window.__stageWaves(5);
      return { a, b, differs: JSON.stringify(a) !== JSON.stringify(b) };
    });
    const scaling = await page.evaluate(() => window.__scaling([1, 10, 20, 29]));
    await page.evaluate(() => window.__stage(11));
    await api.wait(page, 100);
    const act2 = await api.dbg(page);
    await api.shot(page, 'stage-act2');
    await page.evaluate(() => window.__stage(21));
    await api.wait(page, 100);
    const act3 = await api.dbg(page);
    await api.shot(page, 'stage-act3');

    api.check('stages.shuffleCheck.differs === true', shuffleCheck.differs === true, shuffleCheck);
    const scAt = (s) => scaling.find((x) => x.s === s);
    const sc1 = scAt(1), sc29 = scAt(29);
    // hpMul(s)=1+(s-1)*.08, fireMul(s)=1/(1+(s-1)*.03), spdMul(s)=1+(s-1)*.02.
    // s=1에서는 전부 배율 1(스케일링 없음). s=29: hp=1+28*.08=3.24,
    // fire=1/1.84=0.54, spd=1+28*.02=1.56.
    api.check('stages.scaling s=1 (no scaling)', sc1.hp === 1 && sc1.fire === 1 && sc1.spd === 1, sc1);
    api.check('stages.scaling s=29 hp===3.24', sc29.hp === 3.24, sc29.hp);
    api.check('stages.scaling s=29 fire===0.54', sc29.fire === 0.54, sc29.fire);
    api.check('stages.scaling s=29 spd===1.56', sc29.spd === 1.56, sc29.spd);
    api.check('stages.act2.act === 2 (stage 11)', act2.act === 2, act2.act);
    api.check('stages.act3.act === 3 (stage 21)', act3.act === 3, act3.act);

    return { s1, shuffleCheck, scaling, act2, act3 };
  },

  // Task 4 — 보스 3종이 각각 다른 패턴을 내는지 + 셋 다 치명적인지
  bosses3: async (page) => {
    const out = {};
    for (const s of [10, 20, 30]) {
      await page.evaluate(() => window.__pick(0));
      await page.evaluate((n) => window.__stage(n), s);
      await api.wait(page, 2500);                     // 등장 + 첫 공격
      const d = await api.dbg(page);
      const eb = await page.evaluate(() => window.__eb());
      const angles = eb.map((b) => Math.round(Math.atan2(b.vy, b.vx) * 100) / 100);
      out[s] = {
        name: d.bossName, hp: d.bossHp, phase: d.bossPhase, timer: d.bossTimer,
        beam: d.beam, ebullets: eb.length,
        distinctAngles: new Set(angles).size,
        allFinite: eb.every((b) => [b.x, b.y, b.vx, b.vy].every(Number.isFinite)),
      };
      await api.shot(page, `boss-${s}`);
    }
    for (const s of [10, 20, 30]) {
      api.check(`bosses3[${s}].name !== null (스폰됨)`, out[s].name !== null, out[s].name);
      api.check(`bosses3[${s}].allFinite (탄 좌표 유한)`, out[s].allFinite, out[s]);
    }
    // timeLimit: 10/20은 0(제한 없음), 30(텐마)만 45초 — spawnBoss가
    // game.bossTimer = def.timeLimit로 세팅하고 stepBoss가 매 프레임 깎는다.
    api.check('bosses3[10].timer === 0', out[10].timer === 0, out[10].timer);
    api.check('bosses3[20].timer === 0', out[20].timer === 0, out[20].timer);
    api.check('bosses3[30].timer in 40..45 (45초 제한, 2.5s 경과)', out[30].timer > 40 && out[30].timer <= 45, out[30].timer);
    return out;
  },

  // Task 4 — 세 보스 모두 "가만히 서 있으면 죽는가". v1에서 보스 탄이 전부
  // NaN이라 45초를 버텨도 안 죽었던 회귀를 보스 3종에 각각 적용한다.
  bosses3Lethal: async (page) => {
    const out = {};
    for (const s of [10, 20, 30]) {
      await page.evaluate(() => window.__pick(0));
      await page.evaluate((n) => window.__stage(n), s);
      await page.evaluate(() => { window.__setLives(3); window.__tp(320, 160); });
      // 발사하지 않는다 — 상쇄로 적탄이 지워지면 회귀 테스트가 무력화된다
      // 30회(21s): 오니가시라의 원형확산(비조준)은 고정 좌표(320,160)와 정확히
      // 정렬되는 데 실측 ~17.7s가 걸린다(3회 재현 모두 결정론적으로 동일 스텝에
      // 명중) — 조준탄(대불/텐마, ~3.5s)보다 훨씬 느리므로 원래의 20회(14s)는
      // 부족했다. 여유를 두고 30회로 늘렸다.
      for (let i = 0; i < 30; i++) {
        await page.evaluate(() => window.__tp(320, 160));
        await api.wait(page, 700);
        const d = await api.dbg(page);
        if (d.lives < 3 || d.state !== "PLAYING") { out[s] = d; break; }
      }
      if (!out[s]) out[s] = await api.dbg(page);
    }
    for (const s of [10, 20, 30]) {
      api.check(`bosses3Lethal[${s}] lives<3 or state!==PLAYING (가만히 있으면 죽는다)`,
        out[s].lives < 3 || out[s].state !== 'PLAYING', out[s]);
    }
    return out;
  },

  // Task 4 — 레이저 예고 구간에는 판정이 없고 빔 구간에만 있는지.
  // 예고 없는 전화면 즉사는 회피 불가능하므로 이 비대칭이 곧 공정성이다.
  laser: async (page) => {
    await page.evaluate(() => window.__pick(0));
    await page.evaluate(() => window.__stage(20));
    await api.wait(page, 2000);                       // 등장 완료
    const samples = [];
    // 빔 y에 플레이어를 붙여 두고 warn/fire 구간별 lives 변화를 관측한다.
    // 매 샘플 라이프뿐 아니라 무적 시간도 0으로 되돌린다 — 그러지 않으면 한 번
    // 맞은 뒤 INVULN_HIT(2.0초) 동안 실제 fire 구간에 있어도 맞지 않아
    // fireDamaged가 거짓으로 0이 된다(최초 실행에서 재현됨). 적탄도 매 샘플
    // 지운다 — 대불의 독립적인 양팔 교차탄이 우연히 명중하면 레이저와 무관하게
    // lives가 줄어 warn 구간이 거짓으로 오염된다(ebullets 개수가 줄며 lives도
    // 줄어드는 표본으로 실측 확인됨). 또한 샘플 시작과 끝의 beam phase가
    // 다르면(30ms 대기 도중 warn→fire 전환이 겹친 경우) 라벨이 모호하므로 버린다.
    for (let i = 0; i < 120; i++) {
      const s = await page.evaluate(() => {
        const d = window.__dbg();
        const ys = window.__beamYs();
        if (ys.length) window.__tp(320, ys[0] - 18);  // 히트박스 중심을 빔에 맞춘다
        window.__setLives(3);                          // 매 샘플 리셋해 구간을 분리
        window.__setInvuln(0);
        window.__clearEB();
        return { beam: d.beam, lives: d.lives };
      });
      await api.wait(page, 30);
      const after = await api.dbg(page);
      if (s.beam && after.beam === s.beam) samples.push({ phase: s.beam, livesAfter: after.lives });
    }
    const warn = samples.filter((x) => x.phase === "warn");
    const fire = samples.filter((x) => x.phase === "fire");
    const warnDamaged = warn.filter((x) => x.livesAfter < 3).length;
    const fireDamaged = fire.filter((x) => x.livesAfter < 3).length;
    // 표본이 0개면 warnDamaged===0 같은 단정이 공허하게 통과한다 — 그 자체가
    // 이 웨이브가 잡으려는 vacuous-assertion 패턴이므로 표본 수부터 단정한다.
    api.check('laser.warnSamples > 0', warn.length > 0, warn.length);
    api.check('laser.fireSamples > 0', fire.length > 0, fire.length);
    // 공정성의 핵심: 예고 구간에서는 절대 안 맞고, 빔 구간에서는 반드시 맞는다.
    api.check('laser.warnDamaged === 0 (예고 구간 무판정)', warnDamaged === 0, warnDamaged);
    api.check('laser.fireDamaged > 0 (빔 구간 판정 있음)', fireDamaged > 0, fireDamaged);
    return {
      warnSamples: warn.length,
      warnDamaged,
      fireSamples: fire.length,
      fireDamaged,
    };
  },

  // Task 5 — 체크포인트 저장·복원과 localStorage 차단 폴백
  checkpoint: async (page) => {
    const fresh = await page.evaluate(() => window.__progress());

    // 스테이지 10 보스를 즉사시켜 2막 해금
    await page.evaluate(() => window.__pick(0));
    await page.evaluate(() => window.__stage(10));
    await api.wait(page, 200);
    await page.evaluate(() => window.__killBoss());
    await api.wait(page, 200);
    const afterAct1 = await page.evaluate(() => window.__progress());

    // 새로고침 후에도 유지되는가
    await page.reload({ waitUntil: 'load' });
    await api.wait(page, 300);
    const afterReload = await page.evaluate(() => window.__progress());
    const titleDbg = await api.dbg(page);
    await api.shot(page, 'title-unlocked');

    api.check('checkpoint.fresh.unlocked === 1 (초기 상태)', fresh.unlocked === 1, fresh.unlocked);
    api.check('checkpoint.afterAct1.unlocked === 2 (10 격파로 2막 해금)', afterAct1.unlocked === 2, afterAct1.unlocked);
    api.check('checkpoint.afterReload.unlocked === 2 (새로고침에도 유지)', afterReload.unlocked === 2, afterReload.unlocked);
    api.check('checkpoint.titleDbg.state === TITLE', titleDbg.state === 'TITLE', titleDbg.state);

    return { fresh, afterAct1, afterReload, titleDbg };
  },

  // Task 5 — localStorage를 차단한 컨텍스트에서도 게임이 정상 동작하는가
  noStorage: async (page) => {
    // reload 전에 주입해야 페이지 스크립트보다 먼저 실행된다
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() { throw new Error('blocked'); },
      });
    });
    await page.reload({ waitUntil: 'load' });
    await api.wait(page, 300);
    const dbg = await api.dbg(page);
    await page.evaluate(() => window.__pick(0));
    await api.wait(page, 500);
    const playing = await api.dbg(page);
    // localStorage가 getter에서 던지는 상황에서도 게임이 정상 부팅되고
    // (resetGame -> TITLE) 정상 진행되어야(__pick 이후 PLAYING) 한다 —
    // 저장 실패가 플레이를 막으면 안 된다는 게 이 시나리오의 존재 이유다.
    api.check('noStorage.dbg.state === TITLE (차단돼도 부팅)', dbg.state === 'TITLE', dbg.state);
    api.check('noStorage.playing.state === PLAYING (차단돼도 진행)', playing.state === 'PLAYING', playing.state);
    return { dbg, playing };
  },

  // Fix Round 1 — memoryAct가 읽기 경로에서 단조성을 잃는 회귀를 잡는다.
  // 결함(수정 전): loadProgress()가 디스크 값이 유효하면 memoryAct와 비교 없이
  // 그대로 반환했다. "저장 성공 → 저장 실패(디스크가 낡음) → resetGame()"의
  // 순서를 밟으면, 세션 내에서 이미 3막까지 해금됐는데도 resetGame()이 낡은
  // 디스크 값(2)을 그대로 읽어와 3막 해금이 사라진다 — 이 기능이 "저장이 안
  // 돼도 게임은 정상 진행해야 한다"를 위해 존재하는데, 정확히 그 상황(저장
  // 실패)에서 무력화되는 아이러니. KeyR(죽을 때마다 누르는 경로)로 재현된다.
  //
  // 참고: __progress().stored는 loadProgress()를 그대로 호출한다. 수정 후
  // loadProgress()는 "디스크를 memoryAct에 흡수시키고 memoryAct를 반환"하므로,
  // saveProgress(3)이 disk 쓰기 실패와 무관하게 memoryAct를 먼저 3으로 올려
  // 두면 그 즉시 stored도 3으로 보인다(더 이상 "디스크 원본 값"이 아니라
  // "세션 내 단조 진실원"이다 — 그게 이 수정의 목적이다). 그래서 disk에 실제
  // 무엇이 적혀 있는지는 localStorage.getItem을 직접 읽어(diskRaw) 별도로
  // 확인한다 — 그래야 "쓰기가 진짜로 실패했다"와 "그런데도 다운그레이드가
  // 안 된다"를 동시에 증명할 수 있다.
  checkpointMonotonic: async (page) => {
    await page.evaluate(() => window.__pick(0));
    await page.evaluate(() => window.__stage(10));
    await api.wait(page, 200);
    await page.evaluate(() => window.__killBoss());   // 저장 성공 → disk={"act":2}
    await api.wait(page, 200);
    const afterAct1 = await page.evaluate(() => window.__progress());
    const diskAfterAct1 = await page.evaluate(() => localStorage.getItem('jjapgai.progress'));

    // setItem만 막는다(getItem은 살려 둔다). localStorage 인스턴스의 own
    // 프로퍼티로 덮어써서 Storage.prototype을 건드리지 않으므로
    // sessionStorage(공통 초기화의 클리어-플래그가 쓴다)는 영향받지 않는다.
    // 현재 세션에 즉시 적용되므로 리로드가 필요 없다(addInitScript는 다음
    // 내비게이션에야 적용되므로 이 시나리오처럼 리로드 없이 중간에 막으려면
    // 직접 패치해야 한다).
    await page.evaluate(() => {
      localStorage.setItem = () => { throw new Error('blocked'); };
    });

    await page.evaluate(() => window.__stage(20));
    await api.wait(page, 200);
    await page.evaluate(() => window.__killBoss());   // 저장 실패 → disk는 2에 멈춤, memoryAct는 3
    await api.wait(page, 200);
    const afterAct2 = await page.evaluate(() => window.__progress());
    const diskAfterAct2 = await page.evaluate(() => localStorage.getItem('jjapgai.progress'));

    await page.keyboard.press('KeyR');                // resetGame() — 죽을 때마다 밟는 경로
    await api.wait(page, 100);
    const afterReset = await api.dbg(page);

    // 핵심 회귀 단정: resetGame() 이후 unlocked가 격파 직후보다 떨어지면
    // (디스크가 낡아 다운그레이드) 즉시 실패시킨다. 수정 전에는 여기서
    // afterReset.unlocked === 2 (afterAct2.unlocked === 3에서 다운그레이드).
    if (afterReset.unlocked < afterAct2.unlocked) {
      throw new Error(
        `checkpoint downgraded on resetGame(): unlocked ${afterAct2.unlocked} -> ${afterReset.unlocked} ` +
        `(disk stuck at ${diskAfterAct2})`
      );
    }

    api.check('checkpointMonotonic.afterAct1.unlocked === 2', afterAct1.unlocked === 2, afterAct1.unlocked);
    api.check('checkpointMonotonic.afterAct2.unlocked === 3 (저장 실패에도 세션 내 해금)', afterAct2.unlocked === 3, afterAct2.unlocked);
    // 디스크 쓰기가 실제로 막혔다는 증거: setItem이 던지게 만든 뒤이므로
    // 디스크 원본은 2막 저장 시점(act:2) 그대로 멈춰 있어야 한다.
    api.check('checkpointMonotonic.diskAfterAct2 === diskAfterAct1 (쓰기 실패로 디스크 정지)',
      diskAfterAct2 === diskAfterAct1, { diskAfterAct1, diskAfterAct2 });

    return { afterAct1, diskAfterAct1, afterAct2, diskAfterAct2, afterReset };
  },
};

(async () => {
  const name = process.argv[2];
  const scenario = scenarios[name];
  if (!scenario) {
    console.error(`unknown scenario "${name}". available: ${Object.keys(scenarios).join(', ')}`);
    process.exit(2);
  }
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // Task 5 (Step 11) — 시나리오 독립성: checkpoint가 저장한 'jjapgai.progress'가
  // 다른 시나리오의 unlocked 기대를 흔들 수 있으므로 시나리오 시작 시 지운다.
  // page.addInitScript는 이 page의 모든 이후 내비게이션(예: checkpoint/noStorage
  // 자신의 page.reload())에도 다시 실행되므로, sessionStorage 플래그로 "최초
  // 로드 1회만" 지우게 한다 — 그러지 않으면 checkpoint가 스스로 저장한 값을
  // 자신의 reload 지속성 검증 직전에 지워버려 Step 10의 핵심 단정
  // (afterReload.unlocked === 2)이 거짓으로 실패한다.
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__verifyClearedProgressOnce')) {
        localStorage.removeItem('jjapgai.progress');
      }
      sessionStorage.setItem('__verifyClearedProgressOnce', '1');
    } catch (_) { /* 프라이빗 모드 등 — 게임과 동일하게 조용히 넘어간다 */ }
  });
  await page.goto(URL, { waitUntil: 'load' });
  const result = await scenario(page, api);
  await browser.close();
  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ scenario: name, consoleErrors: errors, checks, result }, null, 2));
  // CRITICAL 1 수정: 이전엔 errors.length만 봤다 — 시나리오가 무엇을 반환하든
  // (모든 값이 실패를 의미해도) exit 0이었다. 이제 checks에 기록된 단정 중
  // 하나라도 실패하면 exit 1이고, 어떤 라벨이 실패했는지 이름으로 찍는다.
  if (failed.length) {
    console.error(`FAILED CHECKS (${failed.length}/${checks.length}): ${failed.map((c) => c.label).join(', ')}`);
  }
  if (errors.length || failed.length) process.exit(1);
})().catch((e) => { console.error('HARNESS FAIL:', e.message); process.exit(1); });
