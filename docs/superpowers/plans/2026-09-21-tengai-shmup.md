# 텐가이 횡스크롤 슈팅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 원작 텐가이(Psikyo, 1996)의 장르와 세계관을 재현한 단일 파일 횡스크롤 슈팅을 완성하고 S3 + CloudFront에 배포한다.

**Architecture:** `frontend/index.html` 하나에 HTML·CSS·JS 인라인. Task 1(완료, `07d4708`)이 만든 10개 블록 골격과 고정 타임스텝 누산기를 그대로 쓰고, 플랫포머용 상수/색을 슈팅용으로 교체한다. 레벨은 타일 맵 대신 **시간순 웨이브 테이블**로 기술한다. 배포는 CDK 비공개 S3 + CloudFront OAC.

**Tech Stack:** HTML5 Canvas 2D, vanilla ES2020 (외부 라이브러리 0개), AWS CDK v2 (`aws-cdk-lib` 2.270.0) + TypeScript, 검증용 playwright-core 1.63.0 (레포 외부)

**Spec:** `docs/superpowers/specs/2026-09-21-tengai-shmup-design.md`

**선행 계획:** `docs/superpowers/plans/2026-09-21-clawd-jump.md` 의 Task 1만 유효(완료). 그 계획의 Task 2~7은 장르 전환으로 폐기되었고 본 계획이 대체한다. 태스크 번호는 todo와 맞추기 위해 **2번부터** 시작한다.

## Global Constraints

- 논리 해상도 **640 × 360**. 게임 로직은 이 좌표계에서만 동작한다.
- 게임 파일은 **`frontend/index.html` 단 하나**. 외부 라이브러리·CDN·npm 패키지 **금지**.
- 스프라이트 셀 **3 px**. `image-rendering: pixelated`, `ctx.imageSmoothingEnabled = false`, 표시 배율은 **정수배만**.
- 고정 타임스텝 `STEP = 1/60`, 누산 상한 `MAX_FRAME = STEP * 5`. **Task 1의 루프를 수정하지 않는다.**
- 색은 `COLOR` / `PALETTE` 상수에서만 가져온다. 리터럴 색상값을 코드 중간에 쓰지 않는다.
- 조작: 화살표 8방향, `KeyZ`/`Space` FIRE(홀드=차지), `KeyX` 봄, `KeyR` 재시작.
- **단위 테스트를 작성하지 않는다.** jest 파일을 만들지 말고 기존 `test/clawd-jump.test.ts`도 건드리지 않는다. 검증은 `/tmp/cj/verify.js` 하니스로만 한다. 하니스는 레포 외부이며 **커밋하지 않는다**.
- **로컬 서버 포트는 8000이다.** 8080은 이 머신의 IDE 프로세스(PID 27549)가 상시 점유한다. 하니스는 이미 8000으로 설정되어 있다.
- 서버 정지는 **반드시** `pkill -f 'http[.]serve[r]'` (대괄호 트릭). `pkill -f "http.server"` 는 패턴이 자기 셸 명령줄에 매칭되어 셸을 죽인다(exit 144).
- 이 프로젝트는 Amazon Bedrock을 사용하지 않는다.
- 커밋 메시지 말미에 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## 환경 사실 (실측 완료, 재조사 불필요)

- Amazon Linux 2023 / **aarch64**. Google Chrome은 이 아키텍처에 없고 **chrome-devtools MCP와 playwright MCP는 둘 다 사용 불가**(둘 다 `/opt/google/chrome/chrome`을 요구). MCP 브라우저 도구를 시도하지 말 것.
- arm64 chromium: `~/.cache/ms-playwright/chromium_headless_shell-1243` (설치됨)
- playwright-core 1.63.0: `/tmp/pw/node_modules/playwright-core` (설치됨, 하니스가 이 절대경로로 require)
- chromium 런타임 공유 라이브러리: dnf로 설치 완료
- `chromium.launch({ args: ['--no-sandbox'] })` 필요 (하니스에 포함됨)
- CDK API 4개 실측 확인: `S3BucketOrigin.withOriginAccessControl`, `CacheControl.setPublic()`, `CacheControl.maxAge(Duration)`, `PriceClass.PRICE_CLASS_100`, `aws-cdk-lib/core` require 성공. tsconfig `strict: true`, ES2022, NodeNext.

### 서버 기동

```bash
mkdir -p /tmp/cj
cd /home/ec2-user/capstone/clawd-jump/frontend && nohup python3 -m http.server 8000 >/tmp/cj/server.log 2>&1 &
```

## 계획의 정밀도에 대한 고지

남은 시간 예산(약 1시간) 때문에 **Task 2는 완전한 코드**를 싣고, **Task 3·4는 정확한 명세 + 핵심 코드 조각**(데이터 테이블, 충돌 헬퍼, 피격 규칙, 상수)을 싣는다. 단순 반복 루프는 구현자가 채운다. 따라서 Task 3·4 구현자는 **mid-tier 이상 모델**이어야 한다. 상수·좌표·수치는 어느 태스크든 **본문에 적힌 값을 그대로** 쓴다.

---

## Task 2: 텐가이 상수/스프라이트, 플레이어 이동, 염주 발사, 패럴랙스 배경

**Files:**
- Modify: `frontend/index.html` (블록 1·3·5·6·8·9·10)
- Modify: `/tmp/cj/verify.js` (`scenarios.player` 추가)

**Interfaces:**
- Consumes: Task 1의 `W`, `H`, `STEP`, `MAX_FRAME`, `canvas`, `ctx`, `fitCanvas`, `clamp`, `scale`, `steps`, 루프
- Produces:
  - `PALETTE`(9색), `COLOR`(7색), 플레이어/무장/배경 상수
  - `SPRITES` + `function bake(rows): HTMLCanvasElement` + `SPR.{MONK,HAWK,ONI,KARAKURI}`
  - `const player`, `const pbullets/ebullets/enemies/items`, `const game`
  - `function resetGame(): void`, `function fireBeads(): void`, `function useBomb(): void` (Task 4용 빈 스텁)
  - `const keys`, `function firing(): boolean`
  - `function drawText(s,x,y,size?)`, `drawParallax()`, `drawPlayer()`, `drawHud()`
  - `window.__dbg()` 확장, `window.__tp(x,y)`

- [ ] **Step 1: 블록 1의 상수를 슈팅용으로 전면 교체**

플랫포머 상수(`TILE`, `MOVE_SPEED`, `GRAVITY`, `JUMP_V`, `MAX_FALL`, `COYOTE_TIME`, `JUMP_BUFFER`)와 기존 `COLOR`를 **삭제**하고 아래로 교체한다. `W`, `H`, `CELL`, `STEP`, `MAX_FRAME`, `clamp` 는 유지한다.

```js
  const W = 640, H = 360, CELL = 3;
  const STEP = 1 / 60, MAX_FRAME = STEP * 5;

  // 플레이어
  const PW = 36, PH = 36;              // 스프라이트 크기 (MONK 12x12 x 3px)
  const PHIT = 8;                      // 히트박스 한 변 — 스프라이트 중앙의 8x8
  const PLAYER_SPEED = 150;
  const LIVES_START = 3, BOMBS_START = 2, POWER_MAX = 4;
  const INVULN_HIT = 1.5, INVULN_CONTACT = 0.8;

  // 무장
  const BEAD_W = 4, BEAD_SPEED = 420, FIRE_INTERVAL = 0.11;
  const CHARGE_FULL = 0.6;
  const PHOENIX_W = 24, PHOENIX_H = 12, PHOENIX_SPEED = 560, PHOENIX_DMG = 8;
  const EB_W = 5, EB_SPEED = 190;
  const BOMB_SWEEP = 0.5, BOMB_DMG = 30;

  // 배경
  const SCROLL_BASE = 40;

  const COLOR = {
    sky:     "#1A1917",
    far:     "#2A2724",
    wall:    "#3A3631",
    wallTop: "#544E46",
    ebullet: "#C4463A",
    hud:     "#E8E2D8",
    overlay: "rgba(20, 19, 15, 0.75)",
  };

  // 텐가이는 승병이고 승복은 사프란 주황색이다 — 기존 #D97757을 버리지 않고
  // 의미만 재해석했다.
  const PALETTE = {
    D: "#14130F",  // 외곽선
    S: "#E8C9A0",  // 피부
    R: "#D97757",  // 승복 (사프란)
    B: "#8C4A32",  // 승복 그림자
    G: "#E8C468",  // 금 — 염주 탄, 봉황, 아이템
    A: "#C4863A",  // 매 깃털
    P: "#7A4A8C",  // 요괴 살
    M: "#6B7280",  // 증기 금속
    C: "#6FA88A",  // 기계 눈
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
```

- [ ] **Step 2: 블록 3을 텐가이 스프라이트로 교체**

블록 제목 주석을 `// ===== 3. 스프라이트 =====` 로 바꾸고 아래를 넣는다. **네 배열 모두 행 길이와 팔레트 문자 유효성을 기계 검증한 것이다 — 한 글자도 바꾸지 말 것.**

```js
  const SPRITES = {
    MONK: [            // 12x12 → 36x36. 텐가이(승병), 오른쪽을 향해 난다
      "....DDD.....",
      "...DSSSD....",
      "...DSSSD....",
      "....DSD.....",
      "..DDRRRDD...",
      ".DRRRRRRRD..",
      "DRRRRRRRRRGG",
      ".DRRRRRRRD..",
      "..DRRRRRD...",
      "...DBBBD....",
      "....DBD.....",
      ".....D......",
    ],
    HAWK: [            // 7x5 → 21x15. 사역마 매
      ".D...D.",
      "DAADAAD",
      ".AAAAA.",
      "..AAA..",
      "...D...",
    ],
    ONI: [             // 8x8 → 24x24. 요괴
      "..DDDD..",
      ".DPPPPD.",
      "DPDPPDPD",
      "DPPPPPPD",
      "DPPDDPPD",
      ".DPPPPD.",
      "..D..D..",
      ".D....D.",
    ],
    KARAKURI: [        // 10x8 → 30x24. 증기 카라쿠리
      ".DDD..DDD.",
      "DMMMDDMMMD",
      "DMCMMMMCMD",
      "DMMMMMMMMD",
      ".DMMMMMMD.",
      "..DMMMMD..",
      "..D.DD.D..",
      ".D..DD..D.",
    ],
  };

  // 매 프레임 수백 번 fillRect 하는 대신 오프스크린 캔버스에 한 번만 굽는다.
  // 플랫포머와 달리 좌우 반전본은 굽지 않는다 — 횡스크롤 슈팅에서 모든
  // 스프라이트는 한 방향만 바라본다.
  function bake(rows) {
    const cols = rows[0].length;
    const off = document.createElement("canvas");
    off.width = cols * CELL;
    off.height = rows.length * CELL;
    const g = off.getContext("2d");
    g.imageSmoothingEnabled = false;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols; c++) {
        const color = PALETTE[rows[r][c]];
        if (!color) continue;                    // "." 는 투명
        g.fillStyle = color;
        g.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }
    return off;
  }

  const SPR = {};
  for (const k in SPRITES) SPR[k] = bake(SPRITES[k]);
```

- [ ] **Step 3: 블록 5를 슈팅 상태로 교체**

블록 제목은 `// ===== 5. 상태 =====` 유지. 내용을 아래로 교체한다. Task 3·4가 쓰는 배열/필드까지 **여기서 미리 다 선언**해 이후 태스크가 상태 모양을 흔들지 않게 한다.

```js
  const player = {
    x: 60, y: H / 2 - PH / 2,
    power: 1, lives: LIVES_START, bombs: BOMBS_START,
    invuln: 0,        // 남은 무적 시간(초)
    charge: 0,        // 누적 차지(초)
    fireCd: 0,        // 다음 발사까지 남은 시간(초)
  };

  const pbullets = [];   // {x, y, w, h, vx, dmg, pierce}
  const ebullets = [];   // {x, y, vx, vy}
  const enemies = [];    // {kind, x, y, w, h, hp, t, y0, fireCd, phase?}
  const items = [];      // {x, y}

  const game = {
    state: "PLAYING",
    score: 0,
    time: 0,           // 웨이브 시계(초)
    waveIdx: 0,        // 다음에 발동할 WAVES 인덱스
    pending: [],       // 순차 스폰 대기열 {type, y, left, gap, cd}
    bombFx: 0,         // 봄 연출 남은 시간(초)
    scroll: 0,         // 배경 스크롤 누적(px)
    boss: null,        // Task 4
    bossTimer: 0,      // Task 4
  };

  function resetGame() {
    game.state = "PLAYING";
    game.score = 0; game.time = 0; game.waveIdx = 0;
    game.pending.length = 0; game.bombFx = 0; game.scroll = 0;
    game.boss = null; game.bossTimer = 0;
    pbullets.length = 0; ebullets.length = 0; enemies.length = 0; items.length = 0;
    player.x = 60; player.y = H / 2 - PH / 2;
    player.power = 1; player.lives = LIVES_START; player.bombs = BOMBS_START;
    player.invuln = 0; player.charge = 0; player.fireCd = 0;
  }
  resetGame();

  // 히트박스 헬퍼. 플레이어는 스프라이트 중앙의 작은 정사각형만 판정한다.
  const playerHit = () => ({
    x: player.x + (PW - PHIT) / 2, y: player.y + (PH - PHIT) / 2, w: PHIT, h: PHIT,
  });
  const overlaps = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
```

- [ ] **Step 4: 블록 6을 슈팅 입력으로 교체**

```js
  const keys = new Set();
  const HANDLED = new Set([
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "KeyZ", "Space", "KeyX", "KeyR",
  ]);

  addEventListener("keydown", (e) => {
    if (!HANDLED.has(e.code)) return;
    e.preventDefault();          // 화살표와 Space는 페이지를 스크롤시킨다
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === "KeyR") resetGame();
    if (e.code === "KeyX") useBomb();
  });

  addEventListener("keyup", (e) => {
    if (HANDLED.has(e.code)) keys.delete(e.code);
  });

  const firing = () => keys.has("KeyZ") || keys.has("Space");
```

- [ ] **Step 5: 블록 7·8을 슈팅 로직으로 교체**

블록 7의 제목을 `// ===== 7. 발사 =====` 로 바꾸고, 블록 8은 `// ===== 8. 스텝 =====` 로 둔다.

```js
  // ===== 7. 발사 =====

  function fireBeads() {
    const n = player.power;
    const bx = player.x + PW - 4;
    const by = player.y + PH / 2 - BEAD_W / 2;
    for (let i = 0; i < n; i++) {
      pbullets.push({
        x: bx, y: by + (i - (n - 1) / 2) * 9,
        w: BEAD_W, h: BEAD_W, vx: BEAD_SPEED, dmg: 1, pierce: false,
      });
    }
  }

  function useBomb() {
    // (Task 4)
  }

  // ===== 8. 스텝 =====

  function step(dt) {
    if (game.state !== "PLAYING") return;
    game.time += dt;
    game.scroll += SCROLL_BASE * dt;
    if (player.invuln > 0) player.invuln -= dt;

    // 8방향 이동, 관성 없음. 대각선을 정규화하지 않으면 비스듬히 가는 것이
    // sqrt(2)배(약 141%) 빨라져 "대각선이 최적"인 버그가 된다.
    const dx = (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
    const dy = (keys.has("ArrowDown") ? 1 : 0) - (keys.has("ArrowUp") ? 1 : 0);
    const len = Math.hypot(dx, dy) || 1;
    player.x = clamp(player.x + (dx / len) * PLAYER_SPEED * dt, 0, W - PW);
    player.y = clamp(player.y + (dy / len) * PLAYER_SPEED * dt, 0, H - PH);

    // 발사 + 차지. 홀드 중에도 염주는 정상 발사된다 — 홀드하면 발사가
    // 멈추는 구현은 조작감이 나쁘다.
    player.fireCd -= dt;
    if (firing()) {
      player.charge = Math.min(player.charge + dt, CHARGE_FULL);
      if (player.fireCd <= 0) { fireBeads(); player.fireCd = FIRE_INTERVAL; }
    } else {
      player.charge = 0;                 // Task 4가 만충 시 봉황 발사로 확장
    }

    for (let i = pbullets.length - 1; i >= 0; i--) {
      const b = pbullets[i];
      b.x += b.vx * dt;
      if (b.x > W) pbullets.splice(i, 1);
    }
  }
```

- [ ] **Step 6: 블록 9를 슈팅 렌더로 교체**

```js
  function render() {
    ctx.fillStyle = COLOR.sky;
    ctx.fillRect(0, 0, W, H);
    drawParallax();

    ctx.fillStyle = PALETTE.G;
    for (const b of pbullets) ctx.fillRect(Math.round(b.x), Math.round(b.y), b.w, b.h);

    drawPlayer();
    drawHud();
  }

  // 원작이 호평받은 요소. 층마다 다른 배율로 스크롤해 깊이를 만든다.
  // 각 층은 모듈러 오프셋으로 무한 반복하고, 좌표는 Math.round로 정수 스냅해
  // 서브픽셀 렌더로 픽셀아트가 흐려지는 것을 막는다.
  function drawParallax() {
    // 원경: 산 실루엣 (0.25x). 경로 채우기는 안티에일리어싱이 생기므로
    // 1px 바를 쌓아 삼각형을 만든다.
    ctx.fillStyle = COLOR.far;
    const fx = -((game.scroll * 0.25) % 160);
    for (let x = fx - 160; x < W; x += 160) {
      for (let k = 0; k < 60; k++) {
        const bw = Math.round((k / 60) * 120);
        ctx.fillRect(Math.round(x + 80 - bw / 2), 240 + k, bw, 1);
      }
    }

    // 중경: 성벽 몸체 + 기와 (0.6x)
    ctx.fillStyle = COLOR.wall;
    ctx.fillRect(0, 316, W, H - 316);
    const mx = -((game.scroll * 0.6) % 96);
    for (let x = mx - 96; x < W; x += 96) {
      ctx.fillStyle = COLOR.wall;
      ctx.fillRect(Math.round(x), 296, 64, 20);
      ctx.fillStyle = COLOR.wallTop;
      ctx.fillRect(Math.round(x), 296, 64, 2);
    }

    // 근경: 지면 상단 눈금 (1.0x)
    ctx.fillStyle = COLOR.wallTop;
    const nx = -(game.scroll % 32);
    for (let x = nx - 32; x < W; x += 32) ctx.fillRect(Math.round(x), 316, 16, 2);
  }

  function drawPlayer() {
    // 무적 중에는 점멸시켜 피격을 읽을 수 있게 한다
    if (player.invuln > 0 && Math.floor(player.invuln * 20) % 2 === 0) return;
    ctx.drawImage(SPR.MONK, Math.round(player.x), Math.round(player.y));
    // 사역마는 파워업으로 얻는다(원작 규칙). 파워 2 이상에서만 매가 따라온다.
    if (player.power >= 2) {
      ctx.drawImage(
        SPR.HAWK,
        Math.round(player.x - 22),
        Math.round(player.y + 4 + Math.sin(game.time * 4) * 6)
      );
    }
  }

  function drawText(s, x, y, size) {
    ctx.fillStyle = COLOR.hud;
    ctx.font = (size || 8) + "px monospace";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  }

  function drawHud() {
    drawText(`SCORE ${String(game.score).padStart(6, "0")}`, 6, 12);
    drawText(`LIFE ${player.lives}   BOMB ${player.bombs}   POWER ${player.power}`, 6, 24);
  }
```

- [ ] **Step 7: 블록 10의 `__dbg` 교체 + `__tp` 추가**

```js
  window.__dbg = () => ({
    steps, w: W, h: H, scale,
    state: game.state, score: game.score,
    time: Math.round(game.time * 100) / 100,
    px: Math.round(player.x), py: Math.round(player.y),
    power: player.power, lives: player.lives, bombs: player.bombs,
    charge: Math.round(player.charge * 100) / 100,
    invuln: Math.round(player.invuln * 100) / 100,
    pbullets: pbullets.length, ebullets: ebullets.length,
    enemies: enemies.length, items: items.length,
    waveIdx: game.waveIdx,
  });

  // 검증 하니스 전용
  window.__tp = (x, y) => { player.x = x; player.y = y; };
```

- [ ] **Step 8: 제목 변경**

`<title>` 을 `TENGAI — 戦国` 으로 바꾼다.

- [ ] **Step 9: 하니스에 `player` 시나리오 추가**

`/tmp/cj/verify.js` 의 `scenarios` 객체에 추가한다. 기존 `loop` 시나리오는 지우지 말 것.

```js
  // Task 2 — 이동/클램프/대각선 정규화/발사/배경
  player: async (page) => {
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
```

- [ ] **Step 10: 검증 실행**

```bash
mkdir -p /tmp/cj
cd /home/ec2-user/capstone/clawd-jump/frontend && nohup python3 -m http.server 8000 >/tmp/cj/server.log 2>&1 &
sleep 2
node /tmp/cj/verify.js player
```

기대 결과:
- `consoleErrors`: `[]`
- `result.start`: `state: "PLAYING"`, `px: 60`, `py: 162` (`360/2 − 18`), `lives: 3`, `bombs: 2`, `power: 1`, `score: 0`
- `result.clamped`: `px: **604**` (`W − PW = 640 − 36`), `py: **324**` (`H − PH = 360 − 36`)
- `result.clampedTL`: `px: **0**`, `py: **0**`
- `result.diagRatio`: **0.95 ~ 1.05**. 약 **1.41** 이 나오면 대각선 정규화가 빠진 것이다
- `result.fired.pbullets`: **0보다 크다** (400ms / 0.11s ≈ 3발 발사, 일부는 이미 화면 밖)

- [ ] **Step 11: 스크린샷 확인**

`/tmp/cj/player.png` 를 Read 툴로 읽는다. 기대: 어두운 하늘(`#1A1917`), 화면 아래쪽에 **산 실루엣**(`#2A2724`)과 그 앞의 **성벽 + 기와 블록**(`#3A3631`, 상단 2px `#544E46`), 하단 지면 띠. 그 위에 주황색 승복의 **텐가이 스프라이트**(36×36, 머리·어깨·앞으로 뻗은 팔 끝에 금색 염주)와 오른쪽으로 날아가는 **금색 염주 탄** 몇 발. 좌상단에 `SCORE 000000` / `LIFE 3 BOMB 2 POWER 1`.

- [ ] **Step 12: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 텐가이 스프라이트, 8방향 이동, 염주 발사, 패럴랙스 배경

장르를 플랫포머에서 횡스크롤 슈팅으로 전환한다. Task 1의 캔버스 셸과
고정 타임스텝 누산기는 그대로 재사용하고 상수와 팔레트만 교체했다.

주인공은 텐가이(승병)다. 승복이 사프란 주황색이므로 기존 #D97757을
버리지 않고 의미만 재해석했다.

플레이어 히트박스는 스프라이트 36x36의 중앙 8x8이다. 플랫포머에서는
보이는 것과 부딪히는 것이 일치해야 예측 가능했지만, 슈팅은 탄막 사이를
통과하는 것이 본질이므로 히트박스가 작아야 한다. 장르가 바뀌면 히트박스
철학도 반대로 뒤집힌다.

8방향 이동은 대각선을 정규화한다. 축별로 speed*dt를 더하면 대각선이
sqrt(2)배 빨라져 "비스듬히 가는 것이 최적"인 버그가 된다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 적 웨이브, 적 탄, 피격 규칙, 파워업, 라이프

**Files:**
- Modify: `frontend/index.html` (블록 5·8·9·10)
- Modify: `/tmp/cj/verify.js` (`scenarios.combat` 추가)

**Interfaces:**
- Consumes: Task 2의 `enemies`, `ebullets`, `items`, `pbullets`, `player`, `game`, `playerHit()`, `overlaps()`, `SPR`, `PALETTE`, `COLOR`, `EB_W`, `EB_SPEED`, `INVULN_HIT`, `INVULN_CONTACT`, `POWER_MAX`
- Produces:
  - `const WAVES`, `const ENEMY_DEF`
  - `function spawn(type, y): void`, `function stepWaves(dt): void`
  - `function stepEnemies(dt): void`, `function stepEbullets(dt): void`, `function stepItems(dt): void`
  - `function hitPlayer(): void`, `function contactPlayer(): void`
  - `function drawEnemies(): void`, `function drawEbullets(): void`, `function drawItems(): void`
  - `window.__skipTo(sec): void`

- [ ] **Step 1: 블록 5 아래에 적 정의와 웨이브 테이블 추가**

수치를 그대로 쓴다.

```js
  const ENEMY_DEF = {
    oni:      { spr: "ONI",      w: 24, h: 24, hp: 3, vx: -90, amp: 28, fire: 1.4, score: 100 },
    karakuri: { spr: "KARAKURI", w: 30, h: 24, hp: 8, vx: -60, amp: 0,  fire: 1.8, score: 300 },
  };

  // 타일 맵이 하던 "데이터로 기술된 레벨" 역할을 이 표가 대신한다.
  // t = 웨이브 발동 시각(초), n = 마리 수, gap = 마리 사이 간격(초)
  const WAVES = [
    { t: 1.0,  type: "oni",      y: 100, n: 4, gap: 0.45 },
    { t: 4.0,  type: "oni",      y: 220, n: 4, gap: 0.45 },
    { t: 7.5,  type: "karakuri", y: 160, n: 2, gap: 1.2  },
    { t: 12.0, type: "oni",      y: 60,  n: 5, gap: 0.35 },
    { t: 12.5, type: "oni",      y: 260, n: 5, gap: 0.35 },
    { t: 18.0, type: "karakuri", y: 110, n: 2, gap: 1.0  },
    { t: 18.5, type: "karakuri", y: 240, n: 2, gap: 1.0  },
    { t: 25.0, type: "oni",      y: 180, n: 8, gap: 0.3  },
    { t: 31.0, type: "boss",     y: 140, n: 1, gap: 0    },
  ];
```

- [ ] **Step 2: 스폰과 웨이브 진행**

- `spawn(type, y)`: `type === "boss"` 면 `game.boss` 를 세우는 대신 **Task 4가 채울 자리**이므로 이 태스크에서는 `if (type === "boss") return;` 로 두고 주석 `// (Task 4)` 를 남긴다. 그 외에는 `ENEMY_DEF[type]` 로 `enemies.push({ kind: type, x: W, y, y0: y, w, h, hp, t: 0, fireCd: d.fire })`.
- `stepWaves(dt)`: `game.time` 이 `WAVES[game.waveIdx].t` 를 넘으면 그 웨이브를 `game.pending` 에 `{type, y, left: n, gap, cd: 0}` 로 넣고 `game.waveIdx++`. 그다음 `game.pending` 각 항목의 `cd -= dt`, `cd <= 0` 이면 `spawn` 하고 `left--`, `cd = gap`, `left === 0` 이면 큐에서 제거.

  > 한 프레임에 여러 웨이브가 동시에 발동할 수 있으므로 `while` 로 소비한다. 12.0과 12.5처럼 가까운 두 웨이브가 동시에 진행되는 것은 **의도된 동시 상하 공격**이다.

- [ ] **Step 3: 적 이동과 발사**

`stepEnemies(dt)`: 각 적에 대해 `e.t += dt`; `e.x += d.vx * dt`; `amp > 0` 이면 `e.y = e.y0 + Math.sin(e.t * 2.4) * d.amp`; `e.fireCd -= dt`, `<= 0` 이고 `e.x < W` 이면 발사 후 `e.fireCd = d.fire`.

- `oni`: 발사 시점의 플레이어 히트박스 중심을 향한 **조준탄 1발**
- `karakuri`: 조준 방향을 중심으로 **±0.25 rad 3방향 확산**

조준탄 생성은 공통 헬퍼로 둔다:

```js
  function fireAimed(ex, ey, spread) {
    const p = playerHit();
    const base = Math.atan2(p.y + p.h / 2 - ey, p.x + p.w / 2 - ex);
    for (const off of spread) {
      const a = base + off;
      ebullets.push({
        x: ex, y: ey,
        vx: Math.cos(a) * EB_SPEED,
        vy: Math.sin(a) * EB_SPEED,
      });
    }
  }
```

`oni` 는 `fireAimed(e.x, e.y + e.h / 2, [0])`, `karakuri` 는 `[-0.25, 0, 0.25]`.

`e.x + e.w < 0` 이면 배열에서 제거(점수 없음).

- [ ] **Step 4: 충돌과 피격 규칙 — 원작의 비대칭을 정확히 구현**

```
플레이어 탄 × 적      → 적 hp -= b.dmg. pierce 가 아니면 탄 제거.
                        hp <= 0 → 적 제거, game.score += d.score,
                        karakuri 면 25% 확률로 items.push({x, y})

적 본체 × 플레이어    → invuln <= 0 일 때만: player.power = Math.max(1, power - 1),
  (contactPlayer)       player.invuln = INVULN_CONTACT. 죽지 않는다.

적 탄 × 플레이어      → invuln <= 0 일 때만: player.lives -= 1,
  (hitPlayer)           플레이어를 좌측 중앙(x=60, y=H/2-PH/2)으로 되돌리고
                        player.invuln = INVULN_HIT, 해당 탄 제거.
                        lives <= 0 → game.state = "GAMEOVER"

아이템 × 플레이어     → player.power = Math.min(POWER_MAX, power + 1), 아이템 제거
```

확률에 `Math.random()` 을 쓴다. 결정론이 필요한 검증은 개수 대신 상태 변화로 확인한다.

> **이 비대칭이 원작 텐가이의 특징이다.** 몸통 접촉은 파워 레벨 1 하락(기절)일 뿐이고 죽음은 적 탄에서만 온다. 접촉을 즉사로 만들면 원작이 아니다.

플레이어 판정에는 **반드시 `playerHit()`** 를 쓴다(스프라이트 박스 `PW×PH` 가 아니다). 적 판정은 적의 전체 박스를 쓴다.

- [ ] **Step 5: 적 탄과 아이템 진행**

`stepEbullets(dt)`: `x += vx*dt; y += vy*dt`; 화면 밖(여유 16px)이면 제거.
`stepItems(dt)`: `x -= 50 * dt`; `x + 12 < 0` 이면 제거. 아이템 박스는 12×12.

- [ ] **Step 6: `step(dt)` 에 배선**

Task 2의 `step` 안에서 플레이어 탄 이동 **뒤**에 순서대로 호출한다:
`stepWaves(dt)` → `stepEnemies(dt)` → `stepEbullets(dt)` → `stepItems(dt)` → 충돌 판정.

- [ ] **Step 7: 렌더 추가**

`render()` 에서 `drawParallax()` 뒤, `drawPlayer()` 앞에 `drawItems()` → `drawEnemies()` → 플레이어 탄 → `drawEbullets()` 순으로 그린다. 적 탄을 마지막에 그려 탄막이 적에 가려지지 않게 한다.

- 적: `ctx.drawImage(SPR[d.spr], Math.round(e.x), Math.round(e.y))`
- 적 탄: `COLOR.ebullet` 로 `EB_W × EB_W` 사각형
- 아이템: `PALETTE.G` 로 12×12 사각형 + 중앙에 `PALETTE.D` 4×4 (파워업 표식)

- [ ] **Step 8: `__dbg` 확장과 `__skipTo` 추가**

`__dbg` 에 `waveIdx`, `enemies`, `ebullets`, `items` 는 이미 있다. 추가로 `pending: game.pending.length` 를 넣는다.

```js
  // 검증 하니스 전용: 웨이브 시계를 앞으로 돌린다.
  // 보스 구간(31초)을 헤드리스로 검증하려면 실시간 대기가 불가능하다.
  window.__skipTo = (sec) => { game.time = sec; };
```

- [ ] **Step 9: 하니스에 `combat` 시나리오 추가**

```js
  // Task 3 — 웨이브 스폰, 적 탄, 접촉=파워다운 / 피탄=사망 비대칭
  combat: async (page) => {
    await api.wait(page, 200);
    const t0 = await api.dbg(page);

    // 첫 웨이브(1.0초, oni x4)가 스폰되는지
    await api.wait(page, 2500);
    const wave1 = await api.dbg(page);

    // 적 탄이 생성되는지 (oni는 1.4초 간격 발사)
    await api.wait(page, 2000);
    const shooting = await api.dbg(page);
    await api.shot(page, 'combat');

    // 접촉 피격: 파워를 올려 두고 적 몸통에 갖다 댄다 → 파워만 내려가고 살아야 한다
    const contact = await page.evaluate(() => {
      window.__dbgSetPower && window.__dbgSetPower(3);
      return null;
    });

    // 피탄 사망: 적 탄 한가운데로 이동시켜 라이프가 줄어드는지 본다
    await page.evaluate(() => {
      const d = window.__dbg();
      window.__tp(320, 160);
    });
    await api.wait(page, 2500);
    const afterExposure = await api.dbg(page);

    return { t0, wave1, shooting, contact, afterExposure };
  },
```

> 이 시나리오는 `__dbgSetPower` 를 참조하지만 그런 훅은 **만들지 않는다**. 위 코드의 해당 두 줄(`const contact = ...` 블록)은 **삭제하고** `contact` 를 반환값에서 빼라. 접촉 판정은 아래 기대 결과대로 `afterExposure` 하나로 확인한다. (계획 작성 중 남은 흔적이며, 훅을 늘리지 않는 편이 낫다.)

- [ ] **Step 10: 검증 실행**

```bash
node /tmp/cj/verify.js combat
```

기대 결과:
- `consoleErrors`: `[]`
- `result.t0`: `waveIdx: 0`, `enemies: 0`
- `result.wave1`: `waveIdx: **1 이상**`, `enemies: **1 이상**` (1.0초 웨이브 oni×4가 0.45초 간격으로 들어온다)
- `result.shooting`: `ebullets: **1 이상**`
- `result.afterExposure`: 플레이어를 화면 중앙에 방치했으므로 **`lives < 3`** 이거나 **`power` 가 1로 내려가 있거나**, 둘 중 하나 이상이 성립해야 한다. 셋 다 초기값이면 충돌 판정이 전혀 동작하지 않는 것이다
- `result.afterExposure.state`: `"PLAYING"` 또는 `"GAMEOVER"`

- [ ] **Step 11: 스크린샷 확인**

`/tmp/cj/combat.png`: 보라색 요괴(`#7A4A8C`)와/또는 회색 증기 로봇(`#6B7280`, 청록 눈)이 오른쪽에서 진입해 있고, 붉은 적 탄(`#C4463A`)과 금색 염주 탄이 함께 보인다.

- [ ] **Step 12: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 적 웨이브, 적 탄, 피격 규칙, 파워업

타일 맵이 하던 "데이터로 기술된 레벨" 역할을 시간순 웨이브 테이블이
대신한다.

피격 규칙은 원작 텐가이의 비대칭을 그대로 구현했다. 적 본체와 접촉하면
파워 레벨이 1 내려가고 잠시 무적이 될 뿐 죽지 않으며, 죽음은 적 탄에서만
온다. 접촉을 즉사로 만들면 원작이 아니다.

플레이어 충돌은 스프라이트 박스가 아니라 중앙 8x8 히트박스로만 판정한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 차지 봉황, 봄, 보스, CLEAR/BADEND

**Files:**
- Modify: `frontend/index.html` (블록 7·8·9·10)
- Modify: `/tmp/cj/verify.js` (`scenarios.boss` 추가)

**Interfaces:**
- Consumes: Task 2·3의 전부
- Produces:
  - `function firePhoenix(): void`, `useBomb()` 본문
  - `const BOSS`, `function spawnBoss(): void`, `function stepBoss(dt): void`, `function drawBoss(): void`
  - `function drawOverlay(): void`

- [ ] **Step 1: 차지 → 봉황**

Task 2의 `step` 에서 `firing()` 이 거짓인 분기를 바꾼다.

```js
    } else {
      if (player.charge >= CHARGE_FULL) firePhoenix();
      player.charge = 0;
    }
```

`firePhoenix()`: `pbullets.push({ x: player.x + PW, y: player.y + PH / 2 - PHOENIX_H / 2, w: PHOENIX_W, h: PHOENIX_H, vx: PHOENIX_SPEED, dmg: PHOENIX_DMG, pierce: true })`.

봉황 렌더는 일반 염주와 구분해야 한다. 탄 렌더 루프에서 `b.pierce` 면 `PALETTE.G` 몸체 + 뒤쪽에 `PALETTE.R` 꼬리 8×4 를 덧그린다.

> 원작에서 텐가이의 사역마는 매이고 **차지하면 봉황이 되어 돌진**한다. `pierce: true` 가 그 관통 돌진을 표현한다.

- [ ] **Step 2: 봄 (卍)**

```js
  function useBomb() {
    if (game.state !== "PLAYING" || player.bombs <= 0 || game.bombFx > 0) return;
    player.bombs -= 1;
    game.bombFx = BOMB_SWEEP;
    ebullets.length = 0;                       // 화면의 적 탄 전부 제거
    for (const e of enemies) e.hp -= BOMB_DMG;
    if (game.boss) game.boss.hp -= BOMB_DMG;
  }
```

`step` 에서 `game.bombFx > 0` 이면 `-= dt`. 봄으로 hp가 0 이하가 된 적은 다음 충돌 판정 단계에서 처리되도록, **적 제거/점수 처리를 hp 검사 한 곳으로 모은다**(탄 충돌 루프와 봄이 같은 경로를 쓰게 할 것).

렌더: `game.bombFx > 0` 이면 진행도 `1 - bombFx / BOMB_SWEEP` 에 비례한 x 위치에 `PALETTE.G` 로 큰 만자(卍)를 `fillRect` 조합으로 그린다 — 가로 막대 2개 + 세로 막대 2개 + 끝단 4개, 전체 약 48×48.

- [ ] **Step 3: 보스**

```js
  const BOSS = {
    w: 72, h: 96, hpMax: 120,
    timeLimit: 45,
    p1Fire: 1.2, p2Fire: 0.8,
    xHome: W - 110,
  };
```

- `spawnBoss()`: `game.boss = { x: W + 20, y: H / 2 - BOSS.h / 2, hp: BOSS.hpMax, t: 0, fireCd: 1.0, phase: 1, dash: 0 }`, `game.bossTimer = BOSS.timeLimit`. Task 3의 `spawn()` 에 있던 `if (type === "boss") return;` 를 `spawnBoss()` 호출로 교체한다.
- `stepBoss(dt)`:
  - `t += dt`; 등장 연출로 `x` 를 `BOSS.xHome` 까지 `70 px/s` 로 접근
  - `y = H/2 - BOSS.h/2 + Math.sin(t * 0.8) * 70` (상하 왕복)
  - `phase = hp > BOSS.hpMax / 2 ? 1 : 2`
  - `fireCd -= dt`, `<= 0` 이면 phase 1은 `fireAimed(x, y + h/2, [-0.25, 0, 0.25])` / phase 2는 `[-0.5, -0.25, 0, 0.25, 0.5]` 후 `fireCd = phase === 1 ? BOSS.p1Fire : BOSS.p2Fire`
  - phase 2에서 `dash` 타이머로 3초마다 좌향 돌진(`x -= 180*dt` 1초) 후 복귀
  - `game.bossTimer -= dt`; `<= 0` → `game.state = "BADEND"`
  - `hp <= 0` → `game.state = "CLEAR"`, `game.score += 5000 + player.bombs * 1000`, `game.boss = null`
- 보스 히트박스는 전체 박스. 플레이어 탄 충돌 루프에 보스를 포함시킨다.
- `drawBoss()`: 절차적. `COLOR.wall` 몸통 72×96, `PALETTE.M` 장갑판 3개, `PALETTE.C` 눈 2개, `PALETTE.D` 외곽. 상단에 HP 바(폭 `W-120`, 높이 6, `PALETTE.C` 채움)와 `TIME ${ceil(bossTimer)}` 표시.

> 제한 시간과 배드 엔딩은 원작 최종보스의 특징이다. 시간 내 격파하지 못하면 `CLEAR` 가 아니라 `BADEND` 가 된다.

- [ ] **Step 4: 상태 오버레이**

`render()` 끝에서 `game.state !== "PLAYING"` 이면 `COLOR.overlay` 전체 채움 후:

| 상태 | 문구 |
|---|---|
| `CLEAR` | `CLEAR!` (20px), `SCORE ...`, `PRESS R TO RESTART` |
| `BADEND` | `BAD END` (20px), `보스를 시간 내에 쓰러뜨리지 못했다`, `PRESS R TO RESTART` |
| `GAMEOVER` | `GAME OVER` (20px), `SCORE ...`, `PRESS R TO RESTART` |

문자열 폭은 `ctx.measureText(s).width` 로 재서 가운데 정렬한다.

- [ ] **Step 5: `__dbg` 확장**

`bossHp: game.boss ? game.boss.hp : null`, `bossPhase: game.boss ? game.boss.phase : null`, `bossTimer: Math.round(game.bossTimer * 10) / 10`, `bombFx: Math.round(game.bombFx * 100) / 100` 추가.

- [ ] **Step 6: 하니스에 `boss` 시나리오 추가**

```js
  // Task 4 — 차지 봉황, 봄, 보스, CLEAR/BADEND
  boss: async (page) => {
    await api.wait(page, 200);

    // 차지: 700ms 홀드 후 release → 관통 봉황이 나가야 한다
    await api.hold(page, 'KeyZ', 700);
    await api.wait(page, 60);
    const afterCharge = await api.dbg(page);

    // 봄
    const beforeBomb = await api.dbg(page);
    await api.tap(page, 'x');
    await api.wait(page, 100);
    const afterBomb = await api.dbg(page);

    // 보스: 웨이브 시계를 31초로 돌려 즉시 소환
    await page.evaluate(() => window.__skipTo(30.9));
    await api.wait(page, 1500);
    const bossUp = await api.dbg(page);
    await api.shot(page, 'boss');

    // 배드 엔딩: 제한 시간을 거의 0으로 만들어 BADEND 전이를 확인
    await page.evaluate(() => { window.__dbg(); });
    return { afterCharge, beforeBomb, afterBomb, bossUp };
  },
```

- [ ] **Step 7: 검증 실행**

```bash
node /tmp/cj/verify.js boss
```

기대 결과:
- `consoleErrors`: `[]`
- `result.afterCharge.pbullets`: **0보다 크다**. 700ms > `CHARGE_FULL` 0.6s 이므로 release 시 봉황이 나간다
- `result.afterBomb.bombs`: `beforeBomb.bombs - 1` (**2 → 1**)
- `result.afterBomb.ebullets`: **0** (봄이 화면의 적 탄을 전부 제거)
- `result.afterBomb.bombFx`: **0보다 크다**
- `result.bossUp.bossHp`: **120 근처** (플레이어 탄에 조금 맞았을 수 있다), `bossPhase: 1`, `bossTimer`: **45 미만이며 40 이상**

- [ ] **Step 8: 스크린샷 확인**

`/tmp/cj/boss.png`: 화면 오른쪽에 72×96 증기 카라쿠리 대형기, 상단에 HP 바와 `TIME` 표시. 붉은 적 탄이 부채꼴로 날아온다.

- [ ] **Step 9: 사용자 수동 플레이 (전체 게이트)**

```
ssh -L 8000:localhost:8000 <이 EC2>
# http://localhost:8000/index.html
```

확인 항목: 이동이 즉각적인가 / 탄막을 피할 수 있는가(히트박스가 너무 크지 않은가) / 적과 부딪혀도 죽지 않고 파워만 내려가는가 / 차지 봉황이 시원한가 / 봄이 탄을 지우는가 / 보스를 45초 안에 쓰러뜨릴 수 있는가(난이도) / 패럴랙스가 깊이 있게 보이는가.

- [ ] **Step 10: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 차지 봉황, 만자 봄, 2페이즈 보스, CLEAR/BADEND

원작에서 텐가이의 사역마는 매이고 차지하면 봉황이 되어 돌진한다.
pierce 플래그가 그 관통 돌진을 표현한다.

보스에는 45초 제한 시간이 있고 초과하면 CLEAR 대신 BADEND가 된다.
원작 최종보스의 특징을 그대로 가져왔다.

봄은 화면의 적 탄을 전부 지우고 모든 적에게 고정 데미지를 준다.
원작대로 희귀하며(시작 2개) 남긴 개수만큼 클리어 보너스를 준다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: CDK로 S3 + CloudFront 배포

**Files:**
- Modify: `lib/clawd-jump-stack.ts`
- Modify: `bin/clawd-jump.ts`

**Interfaces:**
- Consumes: `frontend/index.html` (BucketDeployment asset)
- Produces: `ClawdJumpStack` — `SiteUrl` CfnOutput

> 스택·레포 이름은 `clawd-jump` 를 유지한다. 인프라 리소스 이름 변경은 스택 교체를 유발하고 남은 예산에 맞지 않는다.

- [ ] **Step 1: AWS 자격증명 확인**

```bash
aws sts get-caller-identity
aws configure get region || echo $AWS_REGION
```

실패하면 배포를 진행하지 않고 보고한다.

- [ ] **Step 2: `lib/clawd-jump-stack.ts` 전체 교체**

```ts
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export class ClawdJumpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 버킷은 완전 비공개로 둔다. S3 정적 웹사이트 호스팅 엔드포인트는 HTTP만
    // 지원하고 버킷 공개를 요구하므로 쓰지 않는다.
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 실습 프로젝트의 정리 편의를 위한 설정이다. 프로덕션에서는 쓰지 않는다.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // OAC는 CloudFront만 버킷을 읽을 수 있는 서명된 요청을 쓴다. 버킷을
    // 비공개로 유지하면서 HTTPS, HTTP/2, 엣지 캐싱을 얻는다. 구식 OAI보다
    // 권장되는 방식이고, 이 헬퍼가 OAC 리소스와 버킷 정책을 자동 생성한다.
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'Tengai shmup static site',
    });

    // 소스가 평범한 디렉터리 asset이므로 로컬에서 zip되며 Docker가 필요없다.
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'frontend'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(cdk.Duration.minutes(5)),
      ],
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Tengai shmup URL',
    });
  }
}
```

- [ ] **Step 3: `bin/clawd-jump.ts` 의 env 활성화**

주석 블록을 지우고 아래로 교체한다.

```ts
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ClawdJumpStack } from '../lib/clawd-jump-stack';

const app = new cdk.App();
new ClawdJumpStack(app, 'ClawdJumpStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

- [ ] **Step 4: 타입 체크와 synth**

```bash
cd /home/ec2-user/capstone/clawd-jump
npm run build
npx cdk synth 2>&1 | tail -40
```

기대: `npm run build` 무출력 성공. 템플릿에 `AWS::S3::Bucket`, `AWS::CloudFront::Distribution`, `AWS::CloudFront::OriginAccessControl`, `Custom::CDKBucketDeployment` 포함.

- [ ] **Step 5: 부트스트랩 (필요시) 과 배포**

```bash
npx cdk bootstrap 2>&1 | tail -10
npx cdk deploy --require-approval never 2>&1 | tail -30
```

CloudFront 배포 생성에 **5~10분** 걸린다. 출력 끝의 `SiteUrl` 을 기록한다.

- [ ] **Step 6: 배포된 사이트 검증**

```bash
SITE=$(aws cloudformation describe-stacks --stack-name ClawdJumpStack \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)
echo "$SITE"
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$SITE"
curl -s "$SITE" | head -3
```

기대: `HTTP 200`, `<!DOCTYPE html>` 로 시작.

이어서 하니스를 배포 URL로 돌린다.

```bash
node -e "
const fs=require('fs');
const s=fs.readFileSync('/tmp/cj/verify.js','utf8');
fs.writeFileSync('/tmp/cj/verify-prod.js', s.replace(
  \"const URL = 'http://localhost:8000/index.html';\",
  'const URL = process.env.CJ_URL;'));
"
CJ_URL="$SITE" node /tmp/cj/verify-prod.js player
```

기대: 로컬과 동일 (`consoleErrors: []`, `clamped.px: 604`, `diagRatio ≈ 1.0`).

- [ ] **Step 7: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add lib/clawd-jump-stack.ts bin/clawd-jump.ts
git commit -m "$(cat <<'EOF'
feat: S3 비공개 버킷 + CloudFront OAC 배포 스택

S3 정적 웹사이트 호스팅 엔드포인트는 HTTP만 지원하고 버킷 공개를
요구하므로 쓰지 않는다. OAC는 CloudFront만 버킷을 읽는 서명된 요청을
사용해 버킷을 완전 비공개로 유지하면서 HTTPS, HTTP/2, 엣지 캐싱을
제공한다.

BucketDeployment의 소스는 평범한 디렉터리 asset이라 로컬에서 zip되며
Docker가 필요없다. 배포마다 /* 무효화를 걸어 갱신이 수초 내 반영된다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 정리

```bash
pkill -f 'http[.]serve[r]'     # 대괄호 트릭 — 일반 패턴은 자기 셸을 죽인다
```

레포에 남는 것: `frontend/index.html`, `lib/clawd-jump-stack.ts`, `bin/clawd-jump.ts`, spec 2개(구/신), 계획 2개(구/신).
레포에 남지 않는 것: `/tmp/cj/*`, `/tmp/pw/*` (전부 레포 외부).

배포 리소스 삭제는 `npx cdk destroy` (`autoDeleteObjects: true` 라 버킷 내용까지 정리).

## 우선순위 (시간 부족 시)

Task 2·3만 끝나도 **플레이 가능한 슈팅**이 된다. Task 4가 게임을 완성하고 Task 5가 배포한다. 예산이 모자라면 이 순서로 자르고, 무엇을 남겼는지 명시적으로 보고한다.
