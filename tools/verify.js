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
    '/tmp/pw/node_modules/playwright-core',
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

// 시나리오: async (page, api) => 출력할 객체
const api = {
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
    return { first: a, after500ms: b, stepsAdvanced: b.steps - a.steps };
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
    return { beadVsNormal, beadVsBead, phoenixVs2 };
  },

  // Task 2 — 이동/클램프/대각선 정규화/발사/배경
  player: async (page) => {
    await page.evaluate(() => window.__pick(0));   // Task 2: 게임은 TITLE로 시작한다
    await api.wait(page, 200);
    const start = await api.dbg(page);

    // 우하단으로 충분히 길게 밀어 클램프 확인
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowDown');
    await api.wait(page, 2000);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('ArrowDown');
    const clamped = await api.dbg(page);

    // 좌상단으로 클램프
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.down('ArrowUp');
    await api.wait(page, 2000);
    await page.keyboard.up('ArrowLeft');
    await page.keyboard.up('ArrowUp');
    const clampedTL = await api.dbg(page);

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
    return { start, clamped, clampedTL, pureX, diagX, diagRatio: +(diagX / pureX).toFixed(2), fired };
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

    // 적 탄이 생성되는지
    await api.wait(page, 2000);
    const shooting = await api.dbg(page);
    await api.shot(page, 'combat');

    // 피탄 사망: 화면 중앙에 방치해 적 탄에 계속 노출시키고 라이프/파워가
    // 움직이는지 본다
    await page.evaluate(() => { window.__tp(320, 160); });
    await api.wait(page, 2500);
    const afterExposure = await api.dbg(page);

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

    return {
      soon: { dbg: soon, ebCount: soonEb.length, allFinite: allFinite(soonEb), sample: soonEb.slice(0, 3) },
      mid: { dbg: mid, ebCount: midEb.length, allFinite: allFinite(midEb), sample: midEb.slice(0, 3) },
      late: { dbg: late, ebCount: lateEb.length, allFinite: allFinite(lateEb), sample: lateEb.slice(0, 3) },
    };
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

    return { before, samples, after: samples[samples.length - 1].snap };
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

    return {
      samples,
      barPixelAlwaysHud: samples.every((s) => s.barPixel === '#6fa88a' || s.barPixel === '#3a3631'),
      bodyPixelEverShowsPlayer: samples.some((s) => s.bodyPixel === '#d97757'),
    };
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
    return {
      warnSamples: warn.length,
      warnDamaged: warn.filter((x) => x.livesAfter < 3).length,
      fireSamples: fire.length,
      fireDamaged: fire.filter((x) => x.livesAfter < 3).length,
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
    return { dbg, playing };
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
  console.log(JSON.stringify({ scenario: name, consoleErrors: errors, result }, null, 2));
  if (errors.length) process.exit(1);
})().catch((e) => { console.error('HARNESS FAIL:', e.message); process.exit(1); });
