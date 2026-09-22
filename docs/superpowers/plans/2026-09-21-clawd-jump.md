# Clawd Jump Implementation Plan

> **Task 1만 유효 (완료, 07d4708).** Task 2~7은 장르 전환으로 폐기되었다.
> 유효 계획: `2026-09-21-tengai-shmup.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 순수 HTML5 Canvas + vanilla JS 단일 파일 픽셀아트 플랫포머를 만들고 S3 + CloudFront에 배포한다.

**Architecture:** `frontend/index.html` 하나에 HTML·CSS·JS를 인라인으로 담는다. 게임은 단일 IIFE 안에서 상수 → 스프라이트 → 레벨 → 입력 → 물리 → 충돌 → 카메라 → 엔티티 → 렌더 → 루프 순서의 블록으로 구성되며, 블록 간 통신은 `level`(불변) / `player` / `game`(가변) 상태 객체로만 한다. 물리는 고정 타임스텝(1/60초) 누산기로 돌려 프레임 레이트와 무관하게 결정론적으로 만들고, 충돌은 축 분리 AABB(X 먼저, Y 나중)로 해석한다. 배포는 CDK(TypeScript)로 비공개 S3 버킷 + CloudFront OAC를 구성한다.

**Tech Stack:** HTML5 Canvas 2D, vanilla ES2020 JS (외부 라이브러리 0개), AWS CDK v2 (`aws-cdk-lib` 2.270.0) + TypeScript, 검증용 playwright-core 1.63.0 (레포 외부)

**Spec:** `docs/superpowers/specs/2026-09-21-clawd-jump-design.md`

## Global Constraints

- 논리 해상도 **640 × 360**. 게임 로직은 이 좌표계에서만 동작한다.
- 게임 파일은 **`frontend/index.html` 단 하나**. 외부 라이브러리·CDN·npm 패키지 **금지**.
- 타일 **16 px**, 스프라이트 셀 **3 px**, 플레이어 히트박스 **36 × 24 px**.
- `image-rendering: pixelated`, `ctx.imageSmoothingEnabled = false`, 캔버스 표시 배율은 **정수배만**.
- 물리 상수: `MOVE_SPEED = 130`, `GRAVITY = 1300`, `JUMP_V = 380`, `MAX_FALL = 560` (px, 초)
- `COYOTE_TIME = 0.1`, `JUMP_BUFFER = 0.1` (초)
- 고정 타임스텝 `STEP = 1/60`, 프레임당 누산 상한 `MAX_FRAME = STEP * 5`
- 조작: `ArrowLeft` / `ArrowRight` 이동, `Space` 점프, `R` 재시작
- 색상은 아래 `COLOR` / `PALETTE` 상수에서만 가져온다. 리터럴 색상값을 코드 중간에 쓰지 않는다.
- **단위 테스트를 작성하지 않는다.** 각 태스크는 브라우저 검증으로 갈음한다 (하니스는 레포 외부 `/tmp/cj/`에 두고 커밋하지 않는다).
- 이 프로젝트는 **Amazon Bedrock을 사용하지 않는다.**
- 커밋 메시지 말미에 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` 를 넣는다.

## 환경 사실 (측정 완료, 재조사 불필요)

- 플랫폼: **Amazon Linux 2023 / aarch64**. `sudo`는 패스워드 없이 사용 가능.
- **Google Chrome은 이 아키텍처에 존재하지 않는다** (arm64 RPM 미배포). AL2023 레포에 `chromium` 패키지도 없다.
- chromium 런타임 공유 라이브러리는 **이미 dnf로 설치 완료**했다.
- arm64 chromium은 **이미 다운로드 완료**: `~/.cache/ms-playwright/chromium_headless_shell-1243`
- playwright-core 1.63.0 이 **이미 설치 완료**: `/tmp/pw/node_modules/playwright-core` (레포 외부)
- **chrome-devtools MCP와 playwright MCP는 둘 다 사용 불가** — 두 서버 모두 `/opt/google/chrome/chrome`(브랜드 Chrome)을 요구한다. 검증은 아래 `/tmp/cj/verify.js` 하니스로 한다.
- 검증 하니스는 실측 확인됨: 캔버스 렌더 / `getImageData`로 정확한 픽셀 색 판독 / 키 홀드(`keyboard.down` + 대기 + `up`) / 콘솔 에러 수집 / 스크린샷 저장 모두 동작.

### 로컬 서버 기동/정지 (모든 태스크 공통)

```bash
# 기동 (포트 8080)
cd /home/ec2-user/capstone/clawd-jump/frontend && nohup python3 -m http.server 8080 >/tmp/cj/server.log 2>&1 &

# 정지 — 대괄호 트릭 필수
pkill -f 'http[.]serve[r]'
```

> **함정:** `pkill -f "http.server"`는 **자기 자신의 셸을 죽인다** (셸의 명령줄에 그 문자열이 그대로 들어 있어 `-f` 패턴에 매칭됨, exit 144). `http[.]serve[r]` 형태로 써야 정규식은 `http.server`에 매칭되지만 셸 자신의 명령줄 리터럴에는 매칭되지 않는다.

---

## 스펙 정정 사항 (구현 시 스펙보다 우선)

구현 계획을 세우며 스펙의 두 곳에 정정이 필요함을 확인했다.

### 정정 1: 타일 범위 계산은 `w - 1`이 아니라 반열림 구간

스펙 §8은 타일 조회 범위를 `floor(x/16)` ~ `floor((x + w - 1)/16)`로 적었다. 이는 **정수 좌표에서만** 맞고, 물리가 부동소수점 좌표를 쓰는 이 구현에서는 **접지 판정을 영구히 실패시킨다.**

지면 위에 쉬는 플레이어를 보자. `y = 264`, `PH = 24`, 지면은 행 18 (`y = 288`).
- `floor((264 + 24 - 1) / 16) = floor(287/16) = 17` → 행 18이 범위 밖.
- 한 스텝 중력 적용 후 `y = 264.361`. `floor((264.361 + 23)/16) = floor(287.36/16) = 17` → **여전히 행 18이 범위 밖.**
- `-1`이 1픽셀을 깎는데 한 스텝의 침하량은 0.361픽셀뿐이라, 플레이어는 지면을 절대 감지하지 못하고 `onGround`가 영구히 `false`가 된다. 점프가 아예 불가능해진다.

올바른 형태는 AABB를 반열림 구간 `[v, v + size)`로 보는 것이다:

```js
function tileRange(v, size) {
  return [Math.floor(v / TILE), Math.ceil((v + size) / TILE) - 1];
}
```

- `y = 264` → `ceil(288/16) - 1 = 17` → 행 18 제외 ✓ (닿아 있는 것은 겹친 것이 아니다)
- `y = 264.361` → `ceil(288.361/16) - 1 = 18` → 행 18 포함 ✓ → 밀어내고 `onGround = true`
- 수평도 동일하게 올바르다: `x = 844, w = 36` → 우측 변 880 → `ceil(880/16) - 1 = 54` → 열 55 제외 ✓ (벽에 정확히 밀착 가능)

### 정정 2: 위험 구덩이는 최소 **4타일** 폭이어야 한다

스펙 §7은 최대 수평 간격 4타일(상한)만 정의했다. **하한도 필요하다.**

지지 판정은 "바닥 변의 일부라도 solid 타일 위에 있으면 지지됨"이다. 플레이어 폭이 36 px = 2.25타일이므로:

- **3타일(48 px) 구덩이**: 플레이어가 빠질 수 있는 x 범위가 `48 - 36 = 12 px`뿐. 대부분의 경우 양쪽 가장자리에 **다리처럼 걸쳐져** 빠지지 않는다 → 위험 요소로 기능하지 못하는 장식이 된다.
- **4타일(64 px) 구덩이**: 빠질 수 있는 범위 28 px. 걸어 들어가면 확실히 떨어진다.

⇒ 본 계획의 레벨 맵은 **모든 구덩이·간격을 4타일로** 만들었다. 이 값은 상한(넘으면 못 건넘)과 하한(작으면 안 빠짐)을 동시에 만족하는 유일한 값이다.

부수 효과로 **넓은 몸이 간격 건너기에는 유리**하다. 최소 걸침 기준 필요 이동량은 `16G - 34` px이므로 4타일 간격은 30 px 이동이면 되고(체공 중 수평 도달 76 px), 넉넉히 착지하려 해도 64 px면 된다.

### 정정 3: Phase 1 임시 지면은 y = 288 (스펙의 344 대신)

스펙 §16은 임시 지면을 `y = 344`로 적었다. 실제 레벨의 지면 상단은 행 18 = **`y = 288`** 이므로, 임시 지면도 288로 두면 Phase 2에서 실제 타일로 교체할 때 플레이어 위치가 튀지 않는다.

---

## 파일 구조

| 파일 | 책임 | 태스크 |
|---|---|---|
| `frontend/index.html` | 게임 전체 (HTML·CSS·JS 인라인) | 1–6 |
| `lib/clawd-jump-stack.ts` | S3 비공개 버킷 + CloudFront OAC + BucketDeployment | 7 |
| `bin/clawd-jump.ts` | 스택 env를 `CDK_DEFAULT_*`로 활성화 | 7 |
| `/tmp/cj/verify.js` | 검증 하니스 (**레포 외부, 커밋하지 않음**) | 1–6 |

`frontend/index.html`의 JS는 아래 블록 주석 순서를 **끝까지 유지한다**. 각 태스크는 자기 블록에만 코드를 추가한다.

```
// ===== 1. 상수 =====
// ===== 2. 캔버스 =====
// ===== 3. Clawd 스프라이트 =====
// ===== 4. 레벨 =====
// ===== 5. 상태 =====
// ===== 6. 입력 =====
// ===== 7. 충돌 =====
// ===== 8. 물리 스텝 =====
// ===== 9. 렌더 =====
// ===== 10. 루프 + 디버그 훅 =====
```

---

## Task 1: HTML 셸, 캔버스 정수 배율, 고정 타임스텝 루프, 검증 하니스

**Files:**
- Create: `frontend/index.html`
- Create: `/tmp/cj/verify.js` (레포 외부, 커밋 안 함)

**Interfaces:**
- Consumes: 없음
- Produces:
  - 상수 `W=640, H=360, TILE=16, CELL=3, PW=36, PH=24, MOVE_SPEED, GRAVITY, JUMP_V, MAX_FALL, COYOTE_TIME, JUMP_BUFFER, STEP, MAX_FRAME`
  - `COLOR` 객체 (키: `bg, terrain, terrainTop, coin, spike, flagPole, flagCloth, hud, overlay`)
  - `const clamp = (v, lo, hi) => number`
  - `canvas`, `ctx`, `function fitCanvas(): void`
  - `function step(dt: number): void` (이 태스크에서는 빈 함수)
  - `function render(): void`
  - `window.__dbg(): object` — 헤드리스 검증용 상태 훅. 이 태스크에서는 `{ steps, w, h, scale }`

- [ ] **Step 1: 검증 하니스 디렉터리와 스크립트 생성**

```bash
mkdir -p /tmp/cj
```

`/tmp/cj/verify.js` 를 생성한다. 이후 모든 태스크가 이 파일을 재사용한다.

```js
// Clawd Jump 검증 하니스 (레포 외부, 커밋하지 않음)
// 사용법: node /tmp/cj/verify.js <시나리오이름>
const { chromium } = require('/tmp/pw/node_modules/playwright-core');

const URL = 'http://localhost:8080/index.html';

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
};

const scenarios = {
  // Task 1
  loop: async (page) => {
    const a = await api.dbg(page);
    await api.wait(page, 500);
    const b = await api.dbg(page);
    await api.shot(page, 'loop');
    return { first: a, after500ms: b, stepsAdvanced: b.steps - a.steps };
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
  await page.goto(URL, { waitUntil: 'load' });
  const result = await scenario(page, api);
  await browser.close();
  console.log(JSON.stringify({ scenario: name, consoleErrors: errors, result }, null, 2));
  if (errors.length) process.exit(1);
})().catch((e) => { console.error('HARNESS FAIL:', e.message); process.exit(1); });
```

- [ ] **Step 2: `frontend/index.html` 생성**

```html
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clawd Jump</title>
<style>
  html, body {
    margin: 0;
    height: 100%;
    background: #0B0A09;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }
</style>
</head>
<body>
<canvas id="game" width="640" height="360"></canvas>
<script>
(() => {
  "use strict";

  // ===== 1. 상수 =====
  const W = 640, H = 360, TILE = 16, CELL = 3;
  const PW = 36, PH = 24;                 // 플레이어 히트박스 = 스프라이트 박스
  const MOVE_SPEED = 130, GRAVITY = 1300, JUMP_V = 380, MAX_FALL = 560;
  const COYOTE_TIME = 0.1, JUMP_BUFFER = 0.1;
  const STEP = 1 / 60, MAX_FRAME = STEP * 5;

  const COLOR = {
    bg:         "#1A1917",
    terrain:    "#3A3631",
    terrainTop: "#544E46",
    coin:       "#E8C468",
    spike:      "#C4463A",
    flagPole:   "#544E46",
    flagCloth:  "#6FA88A",
    hud:        "#E8E2D8",
    overlay:    "rgba(20, 19, 15, 0.75)",
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ===== 2. 캔버스 =====
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  let scale = 1;
  function fitCanvas() {
    // 정수 배율만 사용한다. 소수 배율은 pixelated 필터에서도 일부 논리 픽셀을
    // 2px, 일부를 3px로 찍어 스프라이트 두께를 불규칙하게 만든다.
    scale = Math.max(1, Math.floor(Math.min(innerWidth / W, innerHeight / H)));
    canvas.style.width = W * scale + "px";
    canvas.style.height = H * scale + "px";
  }
  addEventListener("resize", fitCanvas);
  fitCanvas();

  // ===== 3. Clawd 스프라이트 =====
  // (Task 2)

  // ===== 4. 레벨 =====
  // (Task 4)

  // ===== 5. 상태 =====
  // (Task 3)

  // ===== 6. 입력 =====
  // (Task 3)

  // ===== 7. 충돌 =====
  // (Task 3, Task 4)

  // ===== 8. 물리 스텝 =====
  function step(dt) {
    // (Task 3)
  }

  // ===== 9. 렌더 =====
  function render() {
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, W, H);
  }

  // ===== 10. 루프 + 디버그 훅 =====
  let acc = 0, steps = 0, last = performance.now();

  function frame(now) {
    // 가변 dt를 고정 스텝으로 쪼갠다. MAX_FRAME 상한은 탭 전환 후 복귀 시
    // 수백 스텝을 따라잡으려다 더 느려지는 "죽음의 나선"을 막는다.
    acc += Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    while (acc >= STEP) {
      step(STEP);
      acc -= STEP;
      steps++;
    }
    render();
    requestAnimationFrame(frame);
  }

  window.__dbg = () => ({ steps, w: W, h: H, scale });

  requestAnimationFrame(frame);
})();
</script>
</body>
</html>
```

- [ ] **Step 3: 서버 기동 후 루프 검증**

```bash
mkdir -p /tmp/cj
cd /home/ec2-user/capstone/clawd-jump/frontend && nohup python3 -m http.server 8080 >/tmp/cj/server.log 2>&1 &
sleep 2
node /tmp/cj/verify.js loop
```

기대 결과:
- `consoleErrors`: `[]`
- `result.stepsAdvanced`: **28 ~ 32** (500 ms ÷ (1/60초) = 30 스텝. 이 범위를 벗어나면 누산기 로직이 틀렸다)
- `result.first.scale`: `2` (뷰포트 1280×720 ÷ 640×360 = 정확히 2배)
- `result.first.w` / `.h`: `640` / `360`

- [ ] **Step 4: 스크린샷 확인**

`/tmp/cj/loop.png` 를 Read 툴로 읽는다. 기대: 1280×720 창 중앙에 **1280×720 전체를 채운** `#1A1917` 캔버스 (배율 2 → 정확히 창을 채움). 캔버스 밖 여백이 있다면 `#0B0A09`.

- [ ] **Step 5: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 캔버스 셸과 고정 타임스텝 게임 루프

640x360 논리 버퍼를 정수 배율로만 확대해 픽셀 왜곡을 막고, 물리를
1/60초 고정 스텝 누산기로 돌려 프레임 레이트와 무관하게 결정론적으로
만든다. 누산 상한 5스텝은 탭 복귀 시 죽음의 나선을 방지한다.

window.__dbg()는 브라우저 없이는 확인할 수 없는 상태를 헤드리스
검증 하니스에 노출하는 창구다. 단위 테스트를 두지 않는 대신 각
Phase를 이 훅으로 검증한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Clawd 스프라이트 프리렌더

**Files:**
- Modify: `frontend/index.html` (블록 3, 블록 9, 블록 10)
- Modify: `/tmp/cj/verify.js` (`scenarios.sprite` 추가)

**Interfaces:**
- Consumes: `CELL`, `ctx`, `COLOR`, `render()`, `window.__dbg()`
- Produces:
  - `const CLAWD: string[]` (12×8), `const PALETTE: {A: string, B: string}`
  - `function bakeClawd(flip: boolean): HTMLCanvasElement` — 36×24 오프스크린 캔버스
  - `const SPR: { right: HTMLCanvasElement, left: HTMLCanvasElement }`

- [ ] **Step 1: 블록 3에 스프라이트 데이터와 프리렌더 추가**

`// ===== 3. Clawd 스프라이트 =====` 아래의 `// (Task 2)` 를 다음으로 교체한다.

```js
  const CLAWD = [
    ".AAAAAAAAAA.",
    ".AAAAAAAAAA.",
    ".AABAAAABAA.",
    "AAAAAAAAAAAA",
    "AAAAAAAAAAAA",
    ".AAAAAAAAAA.",
    "..A.A..A.A..",
    "..A.A..A.A..",
  ];
  const PALETTE = { A: "#D97757", B: "#14130F" };

  // 매 프레임 96개의 fillRect를 호출하는 대신 36x24 오프스크린 캔버스에
  // 한 번만 구워 drawImage 한 번으로 그린다. 좌우 반전도 ctx.scale(-1,1)로
  // 매 프레임 처리하지 않고 반전본을 따로 구워 변환 행렬 비용과 반올림
  // 오차를 없앤다.
  function bakeClawd(flip) {
    const cols = CLAWD[0].length, rows = CLAWD.length;
    const off = document.createElement("canvas");
    off.width = cols * CELL;
    off.height = rows * CELL;
    const g = off.getContext("2d");
    g.imageSmoothingEnabled = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const color = PALETTE[CLAWD[r][c]];
        if (!color) continue;                      // "." 는 투명
        const x = flip ? cols - 1 - c : c;
        g.fillStyle = color;
        g.fillRect(x * CELL, r * CELL, CELL, CELL);
      }
    }
    return off;
  }
  const SPR = { right: bakeClawd(false), left: bakeClawd(true) };
```

- [ ] **Step 2: 블록 9에서 스프라이트를 그린다 (검증용 고정 위치)**

`render()` 를 다음으로 교체한다. 플레이어 상태는 Task 3에서 들어오므로 여기서는 고정 좌표에 양쪽 방향을 모두 그려 두 캔버스를 한 번에 검증한다.

```js
  function render() {
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, W, H);
    // Task 3에서 플레이어 좌표로 대체된다. 지금은 두 방향을 나란히 그려
    // 프리렌더 결과를 눈과 픽셀 판독 양쪽으로 확인한다.
    ctx.drawImage(SPR.right, 100, 100);
    ctx.drawImage(SPR.left, 200, 100);
  }
```

- [ ] **Step 3: 블록 10의 `__dbg`에 스프라이트 크기 노출**

```js
  window.__dbg = () => ({
    steps, w: W, h: H, scale,
    sprite: { w: SPR.right.width, h: SPR.right.height },
  });
```

- [ ] **Step 4: 하니스에 `sprite` 시나리오 추가**

`/tmp/cj/verify.js` 의 `scenarios` 객체에 추가한다.

```js
  // Task 2 — 12x8 배열이 셀 3px로 정확히 렌더되는지 픽셀 단위로 판독
  sprite: async (page) => {
    const dbg = await api.dbg(page);
    // 정방향 스프라이트 좌상단 = (100, 100). 각 셀의 중앙 근처를 샘플링한다.
    const px = async (cx, cy) => api.pixel(page, 100 + cx * 3 + 1, 100 + cy * 3 + 1);
    const checks = {
      r0c0_transparent: await px(0, 0),   // 행0 열0 = "." → 배경색
      r0c1_A: await px(1, 0),             // 행0 열1 = "A"
      r2c3_B: await px(3, 2),             // 행2 열3 = "B" (눈)
      r2c8_B: await px(8, 2),             // 행2 열8 = "B" (눈)
      r3c0_A: await px(0, 3),             // 행3 열0 = "A" (몸통이 가장자리까지)
      r6c2_A: await px(2, 6),             // 행6 열2 = "A" (다리)
      r6c3_transparent: await px(3, 6),   // 행6 열3 = "." (다리 사이)
    };
    // CLAWD의 8개 행은 전부 좌우 대칭(회문)이라 반전본은 원본과 픽셀이
    // 동일해야 한다. 두 영역을 바이트 단위로 비교해 반전 베이크가 데이터를
    // 망가뜨리지 않았음을 확인한다.
    const flippedIdentical = await page.evaluate(() => {
      const g = document.getElementById('game').getContext('2d');
      const a = g.getImageData(100, 100, 36, 24).data;
      const b = g.getImageData(200, 100, 36, 24).data;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    });
    await api.shot(page, 'sprite');
    return { dbg, checks, flippedIdentical };
  },
```

- [ ] **Step 5: 검증 실행**

```bash
node /tmp/cj/verify.js sprite
```

기대 결과:
- `consoleErrors`: `[]`
- `result.dbg.sprite`: `{ w: 36, h: 24 }` — 12×3 = 36, 8×3 = 24
- `result.checks.r0c0_transparent`: `#1a1917` (배경색 = `.` 는 투명)
- `result.checks.r0c1_A`, `r3c0_A`, `r6c2_A`: `#d97757`
- `result.checks.r2c3_B`, `r2c8_B`: `#14130f`
- `result.checks.r6c3_transparent`: `#1a1917`
- `result.flippedIdentical`: **`true`**

> **`CLAWD`는 8개 행 전부가 좌우 대칭(회문)이다.** `".AAAAAAAAAA."`, `".AABAAAABAA."`(눈이 열 3·8), `"..A.A..A.A.."`(다리가 열 2·4·7·9) 모두 뒤집어도 같다. 따라서 `SPR.left`는 `SPR.right`와 **픽셀이 완전히 동일한 것이 정상**이다. 이것은 버그가 아니다 — 나중에 이 "중복"을 제거하려 들지 말 것. 요구사항이 좌우 반전 지원이므로 메커니즘(`x = flip ? cols-1-c : c`)은 유지하고, 스프라이트를 비대칭으로 수정하면 즉시 동작한다. 방향 전환 자체는 Task 3의 `facing` 검증으로 확인한다.

- [ ] **Step 6: 스크린샷 확인**

`/tmp/cj/sprite.png` 를 Read 툴로 읽는다. 기대: **동일하게 보이는** 두 마리의 주황색 Clawd가 나란히 (위 대칭성 때문). 12×8 격자에서 상단 모서리 2개가 깎인 몸통, 3행에 어두운 눈 2개, 하단에 4개의 다리.

- [ ] **Step 7: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: Clawd 스프라이트 오프스크린 프리렌더

12x8 문자 배열을 셀 3px로 36x24 오프스크린 캔버스에 한 번만 굽고
이후 drawImage로 그린다. 프레임당 fillRect 96회를 상수 시간 호출
하나로 줄인다.

좌우 반전을 ctx.scale(-1,1)로 매 프레임 처리하는 대신 반전본을 따로
구웠다. 변환 행렬 저장/복원 비용과 반올림 오차가 사라진다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 입력, 물리, 코요테 타임, 점프 버퍼 — **Phase 1 완료 게이트**

**Files:**
- Modify: `frontend/index.html` (블록 5·6·7·8·9·10)
- Modify: `/tmp/cj/verify.js` (`scenarios.physics`, `scenarios.coyote` 추가)

**Interfaces:**
- Consumes: `PW`, `PH`, `MOVE_SPEED`, `GRAVITY`, `JUMP_V`, `MAX_FALL`, `COYOTE_TIME`, `JUMP_BUFFER`, `TILE`, `SPR`, `clamp`
- Produces:
  - `const player = { x, y, vx, vy, onGround, coyote, buffer, facing }`
  - `function respawn(): void`
  - `const keys: Set<string>`
  - `function tileRange(v: number, size: number): [number, number]`
  - `function solidAt(c: number, r: number): boolean` — Task 4에서 실제 레벨 조회로 교체됨
  - `function moveX(dt: number): void`, `function moveY(dt: number): void`
  - `step(dt)` 구현

- [ ] **Step 1: 블록 5에 플레이어 상태와 리스폰**

`// ===== 5. 상태 =====` 아래 `// (Task 3)` 를 교체한다.

```js
  const SPAWN = { x: 2 * TILE, y: 18 * TILE - PH };   // Task 4에서 레벨의 S로 교체

  const player = {
    x: 0, y: 0, vx: 0, vy: 0,
    onGround: false,
    coyote: 0,      // 지면을 떠난 뒤 남은 점프 허용 시간(초)
    buffer: 0,      // 착지 전에 미리 누른 점프 입력의 잔여 유효 시간(초)
    facing: 1,      // 1 = 오른쪽, -1 = 왼쪽
  };

  function respawn() {
    player.x = SPAWN.x;
    player.y = SPAWN.y;
    player.vx = 0;
    player.vy = 0;
    player.onGround = false;
    player.coyote = 0;
    player.buffer = 0;
  }
  respawn();
```

- [ ] **Step 2: 블록 6에 입력 처리**

`// ===== 6. 입력 =====` 아래 `// (Task 3)` 를 교체한다.

```js
  const keys = new Set();
  const HANDLED = new Set(["ArrowLeft", "ArrowRight", "Space", "KeyR"]);

  addEventListener("keydown", (e) => {
    if (!HANDLED.has(e.code)) return;
    e.preventDefault();          // Space와 화살표는 페이지를 스크롤시킨다
    if (e.repeat) return;        // 꾹 누르고 있을 때의 자동 반복은 무시
    keys.add(e.code);
    if (e.code === "Space") player.buffer = JUMP_BUFFER;
  });

  addEventListener("keyup", (e) => {
    if (HANDLED.has(e.code)) keys.delete(e.code);
  });
```

- [ ] **Step 3: 블록 7에 타일 범위와 축 분리 충돌**

`// ===== 7. 충돌 =====` 아래 `// (Task 3, Task 4)` 를 교체한다.

```js
  // AABB를 반열림 구간 [v, v+size) 로 보고 겹치는 타일 인덱스 범위를 낸다.
  // floor((v+size-1)/TILE) 형태는 정수 좌표에서만 맞고, 부동소수점 좌표에서는
  // 한 스텝의 침하량(0.36px)이 -1px에 먹혀 접지 판정이 영구히 실패한다.
  function tileRange(v, size) {
    return [Math.floor(v / TILE), Math.ceil((v + size) / TILE) - 1];
  }

  // Task 4에서 레벨 그리드 조회로 교체된다.
  // 임시 지면: 행 18 이상을 solid로 본다 (실제 레벨의 지면 상단 y=288과 동일).
  function solidAt(c, r) {
    if (r < 0) return false;          // 천장 없음
    return r >= 18;
  }

  // X를 먼저, Y를 나중에 처리한다. 순서를 뒤집으면 벽에 붙어 낙하할 때
  // 벽에 걸려 멈추는 아티팩트가 생긴다. 두 축을 동시에 풀면 "어느 축으로
  // 밀어낼지" 모호해지는데, 축 분리는 그 모호성 자체를 없앤다.
  function moveX(dt) {
    if (player.vx === 0) return;
    player.x += player.vx * dt;
    const [r0, r1] = tileRange(player.y, PH);
    const [c0, c1] = tileRange(player.x, PW);
    if (player.vx > 0) {
      for (let c = c0; c <= c1; c++)                    // 가장 왼쪽 벽이 먼저 막는다
        for (let r = r0; r <= r1; r++)
          if (solidAt(c, r)) { player.x = c * TILE - PW; player.vx = 0; return; }
    } else {
      for (let c = c1; c >= c0; c--)                    // 가장 오른쪽 벽이 먼저 막는다
        for (let r = r0; r <= r1; r++)
          if (solidAt(c, r)) { player.x = (c + 1) * TILE; player.vx = 0; return; }
    }
  }

  function moveY(dt) {
    player.y += player.vy * dt;
    player.onGround = false;
    const [c0, c1] = tileRange(player.x, PW);
    const [r0, r1] = tileRange(player.y, PH);
    if (player.vy > 0) {
      for (let r = r0; r <= r1; r++)                    // 가장 위 바닥이 먼저 받친다
        for (let c = c0; c <= c1; c++)
          if (solidAt(c, r)) {
            player.y = r * TILE - PH;
            player.vy = 0;
            player.onGround = true;
            return;
          }
    } else if (player.vy < 0) {
      for (let r = r1; r >= r0; r--)                    // 가장 아래 천장이 먼저 막는다
        for (let c = c0; c <= c1; c++)
          if (solidAt(c, r)) { player.y = (r + 1) * TILE; player.vy = 0; return; }
    }
  }
```

- [ ] **Step 4: 블록 8에 물리 스텝**

`step(dt)` 함수 본문을 교체한다.

```js
  function step(dt) {
    // 수평 입력 → 속도 (관성 없음)
    const left = keys.has("ArrowLeft") ? 1 : 0;
    const right = keys.has("ArrowRight") ? 1 : 0;
    player.vx = (right - left) * MOVE_SPEED;
    if (player.vx > 0) player.facing = 1;
    else if (player.vx < 0) player.facing = -1;         // vx === 0 이면 방향 유지

    // 중력 (종단 속도 상한이 터널링을 막는다: 560/60 = 9.3px < 16px 타일)
    player.vy = Math.min(player.vy + GRAVITY * dt, MAX_FALL);

    // 코요테 타임: 지면을 떠난 직후 늦게 누른 입력을 구제
    if (player.onGround) player.coyote = COYOTE_TIME;
    else player.coyote -= dt;
    // 점프 버퍼: 착지 직전에 미리 누른 입력을 구제
    player.buffer -= dt;

    if (player.buffer > 0 && player.coyote > 0) {
      player.vy = -JUMP_V;
      // 둘 다 0으로 리셋하는 것이 필수다. 누락하면 한 번의 입력으로
      // 공중에서 두 번 점프된다.
      player.buffer = 0;
      player.coyote = 0;
      player.onGround = false;
    }

    moveX(dt);
    moveY(dt);
  }
```

- [ ] **Step 5: 블록 9의 렌더를 플레이어 좌표로**

```js
  function render() {
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, W, H);

    // 임시 지면 (Task 4에서 타일 렌더로 교체)
    ctx.fillStyle = COLOR.terrain;
    ctx.fillRect(0, 18 * TILE, W, H - 18 * TILE);
    ctx.fillStyle = COLOR.terrainTop;
    ctx.fillRect(0, 18 * TILE, W, 1);

    // 정수 스냅. 소수 좌표로 그리면 서브픽셀 위치에 찍혀 픽셀아트가 흐려진다.
    ctx.drawImage(
      player.facing >= 0 ? SPR.right : SPR.left,
      Math.round(player.x),
      Math.round(player.y)
    );
  }
```

- [ ] **Step 6: 블록 10의 `__dbg` 확장**

```js
  window.__dbg = () => ({
    steps, w: W, h: H, scale,
    sprite: { w: SPR.right.width, h: SPR.right.height },
    x: Math.round(player.x * 100) / 100,
    y: Math.round(player.y * 100) / 100,
    vx: Math.round(player.vx),
    vy: Math.round(player.vy),
    onGround: player.onGround,
    facing: player.facing,
    coyote: Math.round(player.coyote * 1000) / 1000,
  });
```

- [ ] **Step 7: 하니스에 물리 시나리오 2개 추가**

```js
  // Task 3 — 접지, 좌우 이동, 점프 높이, 방향 반전
  physics: async (page) => {
    await api.wait(page, 300);
    const rest = await api.dbg(page);              // 낙하 후 지면에 쉬는 상태

    await api.hold(page, 'ArrowRight', 500);
    await api.wait(page, 100);
    const moved = await api.dbg(page);

    await api.hold(page, 'ArrowLeft', 200);
    const facingLeft = await api.dbg(page);

    // 점프 최고점 측정: Space를 탭하고 물리를 흐르게 하며 최소 y를 추적
    await page.keyboard.press('Space');
    let minY = Infinity;
    for (let i = 0; i < 40; i++) {
      const d = await api.dbg(page);
      minY = Math.min(minY, d.y);
      await api.wait(page, 15);
    }
    await api.wait(page, 400);
    const landed = await api.dbg(page);
    await api.shot(page, 'physics');
    return { rest, moved, facingLeft, apexY: minY, jumpHeight: Math.round(rest.y - minY), landed };
  },

  // Task 3 — 이중 점프 방지 (코요테 타임 자체는 발판 끝이 필요해 Task 6에서)
  jump: async (page) => {
    await api.wait(page, 300);
    const rest = await api.dbg(page);
    await page.keyboard.press('Space');
    await api.wait(page, 500);                     // 점프 후 착지까지 대기
    const afterFirst = await api.dbg(page);
    // 공중에서 Space를 추가로 눌러도 다시 점프되지 않아야 한다
    await page.keyboard.press('Space');
    await api.wait(page, 80);
    const midAir = await api.dbg(page);
    await page.keyboard.press('Space');            // 공중에서 추가 입력
    await api.wait(page, 80);
    const afterSecondPress = await api.dbg(page);
    return { rest, afterFirst, midAir, afterSecondPress };
  },
```

> 이 시나리오는 **코요테 타임을 검증하지 않는다.** 코요테 타임은 "발판을 떠난 직후"를 요구하는데 Phase 1의 임시 지면은 끝이 없는 평지라 떠날 수가 없다. 코요테 타임 자동 검증은 발판이 생기는 Task 6에서 붙이고, 그 전까지는 Step 10의 사용자 수동 플레이가 유일한 확인 수단이다.

- [ ] **Step 8: 검증 실행**

```bash
node /tmp/cj/verify.js physics
node /tmp/cj/verify.js jump
```

`physics` 기대 결과:
- `consoleErrors`: `[]`
- `result.rest.y`: **264** (임시 지면 상단 288 − PH 24). `onGround: true`, `vy: 0`
- `result.rest.x`: **32** (SPAWN)
- `result.moved.x`: 약 **97** (32 + 130 px/s × 0.5 s = 97). 오차 ±8 허용. `facing: 1`
- `result.facingLeft.facing`: **-1**
- `result.jumpHeight`: **52 ~ 56** (이론값 380² / (2×1300) = 55.5). 이 범위를 벗어나면 중력·점프 속도 또는 누산기가 틀렸다
- `result.landed.onGround`: `true`, `y`: **264**

`jump` 기대 결과:
- `result.afterFirst.onGround`: `true`, `y`: **264** (점프 후 정상 착지)
- `result.midAir.onGround`: `false`, `vy`: **음수** (상승 중, 약 -250 ~ -300)
- `result.afterSecondPress.vy`: **`midAir.vy`보다 커야 한다** (중력이 누적되어 덜 음수가 됨). `midAir.vy` 이하이거나 `-380` 근처라면 **이중 점프 버그** — `step()`에서 점프 후 `buffer`/`coyote` 리셋을 누락한 것이다

- [ ] **Step 9: 스크린샷 확인**

`/tmp/cj/physics.png` 를 Read 툴로 읽는다. 기대: 하단 `#3A3631` 지면(상단 1px `#544E46` 하이라이트) 위에 Clawd가 서 있다.

- [ ] **Step 10: 사용자 수동 플레이 (Phase 1 게이트)**

사용자에게 접속 방법을 안내하고 직접 플레이 피드백을 받는다.

```
ssh -L 8080:localhost:8080 <이 EC2>
# 그 다음 로컬 브라우저에서 http://localhost:8080/index.html
```

확인 항목: 좌우 이동이 즉각적인가 / 점프가 3타일 남짓 올라가는가 / 낙하가 너무 느리거나 빠르지 않은가 / 발판을 떠난 직후 점프가 관용적으로 먹히는가.

- [ ] **Step 11: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 입력, 물리, 축 분리 충돌, 코요테 타임과 점프 버퍼

Phase 1 완료. 축 분리 AABB로 X를 먼저 Y를 나중에 해석해 밀어낼 축의
모호성을 제거한다. 순서를 뒤집으면 벽에 붙어 낙하할 때 걸려 멈춘다.

타일 범위는 반열림 구간 [v, v+size)로 계산한다. floor((v+size-1)/TILE)
형태는 정수 좌표 전용이며, 한 스텝의 침하량 0.36px이 -1px에 먹혀
접지 판정이 영구히 실패한다.

코요테와 버퍼 타이머는 점프 실행 시 둘 다 0으로 리셋한다. 누락하면
한 번의 입력으로 공중에서 두 번 점프된다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 레벨 맵, 파서, 실제 충돌 그리드

**Files:**
- Modify: `frontend/index.html` (블록 4, 블록 5, 블록 7)
- Modify: `/tmp/cj/verify.js` (`scenarios.level` 추가)

**Interfaces:**
- Consumes: `TILE`, `PW`, `PH`, `player`, `respawn()`, `tileRange()`
- Produces:
  - `const MAP: string[]` (22행 × 100열)
  - `function parseLevel(map: string[]): Level`
    `Level = { rows, cols, solid: Uint8Array, coins: Box[], spikes: Spike[], flag: Box|null, spawn: {x,y}, w, h, coinTotal }`
    `Box = { x, y, w, h }`, `Spike = { x, y, w, h, tx, ty }` (`tx/ty` = 렌더용 타일 좌상단)
  - `const level: Level`
  - `solidAt(c, r)` — 레벨 그리드 조회 구현으로 교체
  - `SPAWN` 제거, `respawn()`이 `level.spawn` 사용

- [ ] **Step 1: 블록 4에 맵과 파서 추가**

`// ===== 4. 레벨 =====` 아래 `// (Task 4)` 를 교체한다. 이 맵은 제약 검증기를 통과한 것이다 — 행 0~4 비움, 모든 서기 가능 발판 ≥3타일, 모든 구덩이 4타일, 가시는 바닥 위에 4타일 폭, 코인 12개 전부 도달 가능.

```js
  // 100열 x 22행. X=지형, C=코인, ^=가시, F=깃발, S=시작점, .=빈칸
  const MAP = [
    "....................................................................................................",
    "....................................................................................................",
    "....................................................................................................",
    "....................................................................................................",
    "....................................................................................................",
    "....................................................................................................",
    "....................................................................................................",
    "....................................................................................................",
    "....................................................................................................",
    "....................................................................................................",
    "..................................................................XXXXXX............................",
    "...............................................................C..XXXXXX............................",
    "..............................................................XXXXXXXXXX.....C......................",
    "..................C..........C.............................C..XXXXXXXXXX....XXXX....................",
    "...........................................CC.............XXXXXXXXXXXXXX............................",
    ".......................................................C..XXXXXXXXXXXXXX.............C..............",
    "......C..C..C.........................................XXXXXXXXXXXXXXXXXX............XXXX............",
    "..S...................................................XXXXXXXXXXXXXXXXXX.........................F..",
    "XXXXXXXXXXXXXXXX....XXXXXXX....XXXXXXXXXXX^^^^XXXXXXXXXXXXXXXXXXXXXXXXXX................XXXX^^^^XXXX",
    "XXXXXXXXXXXXXXXX....XXXXXXX....XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX................XXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXX....XXXXXXX....XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX................XXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXX....XXXXXXX....XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX................XXXXXXXXXXXX",
  ];

  // 로드 시 1회만 파싱한다. X만 solid 그리드로 넣고 나머지는 엔티티 배열로
  // 빼내, 렌더 루프에서 문자 비교를 하지 않고 코인 획득이 맵 문자열을
  // 변형하는 부작용도 없게 한다.
  function parseLevel(map) {
    const rows = map.length, cols = map[0].length;
    const solid = new Uint8Array(rows * cols);
    const coins = [], spikes = [];
    let flag = null;
    let spawn = { x: TILE, y: 0 };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ch = map[r][c];
        const x = c * TILE, y = r * TILE;
        if (ch === "X") solid[r * cols + c] = 1;
        // 보상은 히트박스를 시각보다 크게, 위험은 시각과 같게 잡는다.
        else if (ch === "C") coins.push({ x: x + 3, y: y + 3, w: 10, h: 10 });
        else if (ch === "^") spikes.push({ x: x + 2, y: y + 8, w: 12, h: 8, tx: x, ty: y });
        else if (ch === "F") flag = { x, y, w: TILE, h: TILE };
        else if (ch === "S") spawn = { x, y: y + TILE - PH };
      }
    }
    return {
      rows, cols, solid, coins, spikes, flag, spawn,
      w: cols * TILE, h: rows * TILE, coinTotal: coins.length,
    };
  }
  const level = parseLevel(MAP);
```

- [ ] **Step 2: 블록 5에서 `SPAWN`을 `level.spawn`으로 교체**

`const SPAWN = { x: 2 * TILE, y: 18 * TILE - PH };` 줄을 **삭제**하고, `respawn()` 안의 두 줄을 바꾼다.

```js
  function respawn() {
    player.x = level.spawn.x;
    player.y = level.spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.onGround = false;
    player.coyote = 0;
    player.buffer = 0;
  }
  respawn();
```

- [ ] **Step 3: 블록 7의 `solidAt` 임시 구현을 실제 그리드 조회로 교체**

```js
  function solidAt(c, r) {
    if (r < 0) return false;                     // 천장 없음 (§상단 여백 규칙으로 제약)
    if (r >= level.rows) return false;           // 아래 바깥 = 낙사 영역
    if (c < 0 || c >= level.cols) return true;   // 좌우 바깥 = 벽
    return level.solid[r * level.cols + c] === 1;
  }
```

- [ ] **Step 4: 블록 9의 임시 지면 렌더를 제거**

`render()` 에서 임시 지면을 그리는 두 쌍의 `fillStyle`/`fillRect` (`18 * TILE` 을 쓰는 4줄)를 **삭제한다**. 타일 렌더는 Task 5에서 들어온다. 이 태스크의 검증은 화면이 아니라 `__dbg` 상태로 한다.

- [ ] **Step 5: 블록 10의 `__dbg`에 레벨 정보 추가**

```js
  window.__dbg = () => ({
    steps, w: W, h: H, scale,
    sprite: { w: SPR.right.width, h: SPR.right.height },
    x: Math.round(player.x * 100) / 100,
    y: Math.round(player.y * 100) / 100,
    vx: Math.round(player.vx),
    vy: Math.round(player.vy),
    onGround: player.onGround,
    facing: player.facing,
    coyote: Math.round(player.coyote * 1000) / 1000,
    level: {
      rows: level.rows, cols: level.cols, w: level.w, h: level.h,
      coinTotal: level.coinTotal,
      spikes: level.spikes.length,
      hasFlag: level.flag !== null,
      spawn: level.spawn,
    },
  });
```

- [ ] **Step 6: 하니스에 `level` 시나리오 추가**

```js
  // Task 4 — 파싱 결과와 실제 그리드 충돌
  level: async (page) => {
    await api.wait(page, 300);
    const rest = await api.dbg(page);

    // 왼쪽 벽: 좌측 경계 밖은 solid이므로 x는 0 미만으로 못 간다
    await api.hold(page, 'ArrowLeft', 600);
    const atLeftWall = await api.dbg(page);

    // 오른쪽으로 달려 첫 구덩이(열 16-19)에 빠지면 낙사 영역으로 내려간다
    await api.hold(page, 'ArrowRight', 2600);
    const fell = await api.dbg(page);
    return { rest, atLeftWall, fell };
  },
```

- [ ] **Step 7: 검증 실행**

```bash
node /tmp/cj/verify.js level
```

기대 결과:
- `consoleErrors`: `[]`
- `result.rest.level`: `{ rows: 22, cols: 100, w: 1600, h: 352, coinTotal: 12, spikes: 8, hasFlag: true, spawn: { x: 32, y: 264 } }`
- `result.rest.y`: **264**, `onGround`: `true` (실제 행 18 지형 위에 착지)
- `result.rest.x`: **32**
- `result.atLeftWall.x`: **0** (좌측 경계 벽에 막힘. 음수면 경계 처리가 틀렸다)
- `result.fell.y`: **264보다 훨씬 크다** (구덩이 열 16-19로 낙하). 리스폰은 Task 6에서 붙으므로 이 태스크에서는 계속 떨어지는 것이 정상이다. `y > 400` 이면 통과

- [ ] **Step 8: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 레벨 타일 맵과 파서, 실제 충돌 그리드

100x22 문자열 맵을 1회 파싱해 X는 solid 그리드로, C/^/F/S는 엔티티
배열로 분리한다. 렌더 루프에서 문자 비교를 없애고 코인 획득이 맵을
변형하는 부작용도 제거한다.

맵은 제약 검증을 통과했다: 행 0-4 비움(점프 최고점 55px에 화면 이탈
방지), 서기 가능 발판 전부 3타일 이상(플레이어 폭 36px), 구덩이 전부
4타일. 3타일 구덩이는 플레이어가 양쪽에 걸쳐져 빠지지 않아 위험
요소로 기능하지 못한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 타일 렌더, 카메라, 열 컬링 — **Phase 2 완료 게이트**

**Files:**
- Modify: `frontend/index.html` (블록 9, 블록 10)
- Modify: `/tmp/cj/verify.js` (`scenarios.camera` 추가)

**Interfaces:**
- Consumes: `level`, `solidAt()`, `player`, `SPR`, `COLOR`, `clamp`, `W`, `H`, `TILE`, `PW`
- Produces:
  - `function camX(): number` — 정수로 스냅된 카메라 X
  - `render()` 에 타일 렌더 + 컬링
  - `window.__tp(x, y): void` — 검증 하니스 전용 텔레포트 훅 (Task 6도 사용)

- [ ] **Step 1: 블록 9에 카메라와 타일 렌더**

`render()` 전체를 교체한다.

```js
  // 레벨 높이 352px이 캔버스 360px과 거의 같아 수직 스크롤이 불필요하다.
  // Math.round는 필수 — 카메라가 소수 좌표를 가지면 모든 타일이 서브픽셀에
  // 찍혀 픽셀아트가 흐려지고 스크롤 중 떨림이 보인다.
  function camX() {
    return Math.round(clamp(player.x + PW / 2 - W / 2, 0, Math.max(0, level.w - W)));
  }

  function render() {
    const cx = camX();

    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, W, H);

    // 보이는 열만 그린다
    const c0 = Math.max(0, Math.floor(cx / TILE));
    const c1 = Math.min(level.cols - 1, Math.ceil((cx + W) / TILE));
    for (let r = 0; r < level.rows; r++) {
      for (let c = c0; c <= c1; c++) {
        if (level.solid[r * level.cols + c] !== 1) continue;
        const x = c * TILE - cx, y = r * TILE;
        ctx.fillStyle = COLOR.terrain;
        ctx.fillRect(x, y, TILE, TILE);
        if (!solidAt(c, r - 1)) {           // 밟을 수 있는 면만 하이라이트
          ctx.fillStyle = COLOR.terrainTop;
          ctx.fillRect(x, y, TILE, 1);
        }
      }
    }

    // 레벨(352px)과 캔버스(360px) 차이 8px을 지형색으로 채워 지면이
    // 이어져 보이게 한다
    ctx.fillStyle = COLOR.terrain;
    ctx.fillRect(0, level.h, W, H - level.h);

    ctx.drawImage(
      player.facing >= 0 ? SPR.right : SPR.left,
      Math.round(player.x - cx),
      Math.round(player.y)
    );
  }
```

- [ ] **Step 2: 블록 10에 `camX` 노출과 텔레포트 훅 추가**

`__dbg` 반환 객체에 한 줄 추가한다.

```js
    camX: camX(),
```

그리고 `window.__dbg` 정의 **아래**에 검증 전용 훅을 넣는다.

```js
  // 검증 하니스 전용: 플레이어를 특정 좌표에 놓는다.
  // 레벨 중반·후반은 4타일 구덩이를 점프로 건너야 도달하므로, 키 홀드만으로
  // 카메라 추적과 우측 경계 clamp를 검증할 수 없다.
  window.__tp = (x, y) => {
    player.x = x; player.y = y; player.vx = 0; player.vy = 0;
  };
```

- [ ] **Step 3: 하니스에 `camera` 시나리오 추가**

```js
  // Task 5 — 카메라 추적, 좌우 경계 clamp
  camera: async (page) => {
    await api.wait(page, 300);
    const atLeftEdge = await api.dbg(page);     // 스폰 x=32 → camX가 0에 clamp
    await api.shot(page, 'cam-start');

    // 평지(열 46-49, 가시 구덩이 바로 오른쪽)로 옮겨 실제 추적을 확인한다.
    // 키 홀드만으로는 x=302를 넘길 수 없다 — 열 16-19의 4타일 구덩이를
    // 점프로 건너야 하므로 텔레포트가 필요하다.
    await page.evaluate(() => { window.__tp(47 * 16, 18 * 16 - 24); });
    await api.wait(page, 200);
    const midLevel = await api.dbg(page);
    await api.shot(page, 'cam-mid');

    // 최종 지면(열 97) → camX 상한 clamp
    await page.evaluate(() => { window.__tp(97 * 16, 18 * 16 - 24); });
    await api.wait(page, 200);
    const atRightEdge = await api.dbg(page);
    await api.shot(page, 'cam-right');
    return { atLeftEdge, midLevel, atRightEdge, camXUpperBound: 1600 - 640 };
  },
```

- [ ] **Step 4: 검증 실행**

```bash
node /tmp/cj/verify.js camera
```

기대 결과 (`camX = round(clamp(x + 18 − 320, 0, 960))`):
- `consoleErrors`: `[]`
- `result.atLeftEdge`: `x: 32`, `camX: 0` (`32 + 18 − 320 = −270` → 0으로 clamp)
- `result.midLevel`: `x: 752`, `camX: **450**` (`752 + 18 − 320`), `onGround: true` (열 46-49는 행 18이 지형)
- `result.atRightEdge`: `x: 1552`, `camX: **960**` (`1552 + 18 − 320 = 1250` → 960으로 clamp = `camXUpperBound`)

> `atRightEdge`의 `onGround`도 `true`여야 한다 (열 96-99가 행 18 지형). `false`면 텔레포트 좌표나 맵이 어긋난 것이다. 이 위치는 깃발 타일(열 97 행 17) 위지만 Task 5에는 아직 깃발 판정이 없으므로 아무 일도 일어나지 않는다.

- [ ] **Step 5: 스크린샷 확인**

`/tmp/cj/cam-start.png`, `/tmp/cj/cam-mid.png`, `/tmp/cj/cam-right.png` 를 Read 툴로 읽는다.

기대:
- `cam-start.png`: 화면 하단에 `#3A3631` 지형(상단 1px `#544E46` 하이라이트), 왼쪽에 Clawd. 오른쪽에 첫 구덩이(열 16-19)의 어두운 틈이 보인다.
- `cam-mid.png`: `camX = 450` → 열 28~68이 보인다. 가시 구덩이의 **한 타일 깊이 홈**(열 42-45, 아직 가시는 안 그려짐)과 오른쪽의 **계단식 지형**(열 50부터 올라감)이 보여야 한다.
- `cam-right.png`: `camX = 960` → 열 60~100. 계단 상단부, 1타일 두께의 공중 발판 2개(열 76-79 행 13, 열 84-87 행 16), 최종 지면의 홈(열 92-95)이 보인다. 레벨 오른쪽 끝이므로 화면 우측에 빈 공간이 없어야 한다.
- 세 스크린샷 모두: 타일 경계가 **선명한 직선**이어야 한다. 흐릿하면 `Math.round` 누락이다.

- [ ] **Step 6: 사용자 수동 플레이 (Phase 2 게이트)**

```
ssh -L 8080:localhost:8080 <이 EC2>
# http://localhost:8080/index.html
```

확인 항목: 지형을 관통하지 않는가 / 벽에 밀착되는가 / 구덩이에 빠지는가 / 계단을 오를 수 있는가 / 카메라가 부드럽게 따라오고 레벨 양 끝에서 멈추는가 / 스크롤 중 타일이 떨리거나 흐려지지 않는가.

> 가시·코인·깃발은 아직 안 보인다 (Task 6). 구덩이에 빠지면 리스폰 없이 계속 떨어진다 — 정상이다. `R`도 아직 동작하지 않는다. 다시 시작하려면 브라우저를 새로고침한다.

- [ ] **Step 7: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 타일 렌더, 카메라 추적, 열 컬링

Phase 2 완료. 레벨 높이 352px가 캔버스 360px과 거의 같아 수직 스크롤을
생략하고 카메라는 X축만 추적한다. 차이 8px은 지형색으로 채워 지면이
이어져 보이게 한다.

검증용 __tp 훅도 함께 넣는다. 레벨 중반/후반은 4타일 구덩이를 점프로
건너야 도달하므로, 키 홀드만으로는 카메라 추적과 우측 경계 clamp를
검증할 방법이 없다.

카메라 좌표는 Math.round로 정수 스냅한다. 소수 좌표면 모든 타일이
서브픽셀에 찍혀 픽셀아트가 흐려지고 스크롤 중 떨림이 보인다.

상단 하이라이트는 위쪽이 비어 있는 타일에만 그려 밟을 수 있는 면을
시각적으로 명시한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 코인, 가시, 깃발, HUD, 게임 상태 — **Phase 3 완료 게이트**

**Files:**
- Modify: `frontend/index.html` (블록 5·6·8·9·10)
- Modify: `/tmp/cj/verify.js` (`scenarios.gameplay`, `scenarios.coyote` 추가)

**Interfaces:**
- Consumes: `level`, `player`, `respawn()`, `camX()`, `COLOR`, `W`, `H`, `TILE`, `PW`, `PH`, `window.__tp` (Task 5에서 추가됨)
- Produces:
  - `const game = { state: "PLAYING" | "CLEAR", coins: Coin[], collected: number }`
    `Coin = { x, y, w, h, taken: boolean }`
  - `function resetGame(): void`
  - `function overlaps(a: Box, b: Box): boolean`
  - `function drawText(s: string, x: number, y: number, size?: number): void`

- [ ] **Step 1: 블록 5에 게임 상태와 리셋 추가**

`respawn()` 정의 **뒤**, `respawn();` 호출 줄을 **삭제**하고 다음을 넣는다.

```js
  const game = { state: "PLAYING", coins: [], collected: 0 };

  // level.coins는 불변 원본이다. 매 리셋마다 taken 플래그를 붙인 사본을
  // 새로 만들면 맵 파싱을 다시 하지 않고도 완전 초기화가 된다.
  function resetGame() {
    game.state = "PLAYING";
    game.coins = level.coins.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, taken: false }));
    game.collected = 0;
    respawn();
  }
  resetGame();

  const overlaps = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
```

- [ ] **Step 2: 블록 6의 입력에 `R` 처리 추가**

`keydown` 리스너의 `if (e.code === "Space") ...` 줄 **아래**에 추가한다.

```js
    if (e.code === "KeyR") resetGame();
```

- [ ] **Step 3: 블록 8의 `step`에 엔티티 판정 추가**

`step(dt)` 함수 **전체**를 아래로 교체한다 (앞에 상태 가드, `moveY` 뒤에 엔티티 판정이 추가된 최종 형태).

```js
  function step(dt) {
    if (game.state !== "PLAYING") return;     // CLEAR 화면에서는 물리 정지

    // 수평 입력 → 속도 (관성 없음)
    const left = keys.has("ArrowLeft") ? 1 : 0;
    const right = keys.has("ArrowRight") ? 1 : 0;
    player.vx = (right - left) * MOVE_SPEED;
    if (player.vx > 0) player.facing = 1;
    else if (player.vx < 0) player.facing = -1;         // vx === 0 이면 방향 유지

    // 중력 (종단 속도 상한이 터널링을 막는다: 560/60 = 9.3px < 16px 타일)
    player.vy = Math.min(player.vy + GRAVITY * dt, MAX_FALL);

    // 코요테 타임: 지면을 떠난 직후 늦게 누른 입력을 구제
    if (player.onGround) player.coyote = COYOTE_TIME;
    else player.coyote -= dt;
    // 점프 버퍼: 착지 직전에 미리 누른 입력을 구제
    player.buffer -= dt;

    if (player.buffer > 0 && player.coyote > 0) {
      player.vy = -JUMP_V;
      // 둘 다 0으로 리셋하는 것이 필수다. 누락하면 한 번의 입력으로
      // 공중에서 두 번 점프된다.
      player.buffer = 0;
      player.coyote = 0;
      player.onGround = false;
    }

    moveX(dt);
    moveY(dt);

    // 엔티티 판정
    const pb = { x: player.x, y: player.y, w: PW, h: PH };

    for (const c of game.coins) {
      if (c.taken) continue;
      if (overlaps(pb, c)) { c.taken = true; game.collected++; }
    }

    for (const s of level.spikes) {
      if (overlaps(pb, s)) { respawn(); return; }
    }

    // 레벨 바닥 아래로 낙하 (구덩이). 리스폰 시 코인 획득은 유지한다.
    if (player.y > level.h + 64) { respawn(); return; }

    if (level.flag && overlaps(pb, level.flag)) game.state = "CLEAR";
  }
```

- [ ] **Step 4: 블록 9에 코인·가시·깃발·HUD 렌더 추가**

`render()` 의 타일/여백 렌더 **뒤**, `drawImage(...)` **앞**에 엔티티를 넣고, 함수 끝에 HUD를 넣는다.

```js
    // 코인: 히트박스 10x10 안에 8x8 시각 — 보상은 보이는 것보다 넉넉히 먹힌다
    ctx.fillStyle = COLOR.coin;
    for (const c of game.coins) {
      if (c.taken) continue;
      const x = c.x - cx;
      if (x < -TILE || x > W) continue;
      ctx.fillRect(x + 1, c.y + 1, 8, 8);
    }

    // 가시: 히트박스(12x8)와 정확히 같은 크기의 삼각형 하나를 1px 바로
    // 쌓아 그린다. beginPath/fill은 안티에일리어싱이 생겨 픽셀아트가 깨진다.
    // 작은 삼각형 여러 개로 그리면 삼각형 사이 빈 공간도 히트박스에 포함돼
    // "분명히 위에 있었는데 죽었다"가 된다.
    ctx.fillStyle = COLOR.spike;
    for (const s of level.spikes) {
      const x = s.tx - cx;
      if (x < -TILE || x > W) continue;
      for (let k = 0; k < 8; k++) {
        const bw = 2 + Math.floor((k * 10) / 7);          // 위 2px → 아래 12px
        ctx.fillRect(x + 2 + Math.floor((12 - bw) / 2), s.ty + 8 + k, bw, 1);
      }
    }

    // 깃발: 2px 깃대 + 오른쪽으로 좁아지는 천
    if (level.flag) {
      const x = level.flag.x - cx, y = level.flag.y;
      if (x > -TILE && x < W) {
        ctx.fillStyle = COLOR.flagPole;
        ctx.fillRect(x + 3, y, 2, TILE);
        ctx.fillStyle = COLOR.flagCloth;
        for (let k = 0; k < 6; k++) ctx.fillRect(x + 5, y + 2 + k, 8 - k, 1);
      }
    }
```

`drawImage(...)` **뒤**에 HUD를 넣는다.

```js
    drawText(`COINS ${game.collected}/${level.coinTotal}`, 6, 13);

    if (game.state === "CLEAR") {
      ctx.fillStyle = COLOR.overlay;
      ctx.fillRect(0, 0, W, H);
      drawText("CLEAR!", W / 2 - 29, H / 2 - 14, 20);
      drawText(`COINS ${game.collected}/${level.coinTotal}`, W / 2 - 34, H / 2 + 6);
      drawText("PRESS R TO RESTART", W / 2 - 58, H / 2 + 26);
    }
  }

  // 호출부를 한 곳으로 모아 둔다. 시간이 남으면 이 함수만 3x5 비트맵 폰트로
  // 바꿔 완전한 픽셀 퍼펙트를 만들 수 있다.
  function drawText(s, x, y, size) {
    ctx.fillStyle = COLOR.hud;
    ctx.font = (size || 8) + "px monospace";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  }
```

- [ ] **Step 5: 블록 10의 `__dbg`에 게임 상태 추가**

`__dbg` 반환 객체에 추가한다.

```js
    state: game.state,
    collected: game.collected,
    coinsLeft: game.coins.filter((c) => !c.taken).length,
```

- [ ] **Step 6: `__tp` 훅이 이미 있는지 확인 (새로 만들지 말 것)**

`window.__tp` 는 **Task 5에서 이미 추가되었다.** 블록 10에 아래 형태로 존재하는지만 확인하고, 없다면 그때 추가한다. 중복 정의하지 말 것.

```js
  window.__tp = (x, y) => {
    player.x = x; player.y = y; player.vx = 0; player.vy = 0;
  };
```

- [ ] **Step 7: 하니스에 `gameplay` 시나리오 추가**

```js
  // Task 6 — 코인 획득, 낙사 리스폰, 가시 리스폰, 깃발 CLEAR, R 재시작
  gameplay: async (page) => {
    await api.wait(page, 300);
    const start = await api.dbg(page);

    // 튜토리얼 코인 3개(행 16, 열 6/9/12)는 걸어가면 먹힌다.
    // 1400ms x 130px/s = 182px → x ≈ 214 (열 13) → 세 코인 모두 통과
    await api.hold(page, 'ArrowRight', 1400);
    await api.wait(page, 100);
    const walkedCoins = await api.dbg(page);

    // 계속 달려 첫 구덩이(열 16-19, x 256-320)로 낙하 → 시작점 리스폰
    await api.hold(page, 'ArrowRight', 1200);
    await api.wait(page, 800);
    const afterPitFall = await api.dbg(page);

    // 가시: 가시 구덩이(열 42-45) 바로 왼쪽 지면(열 41)에 놓고 걸어 들어간다.
    // 열 42-45는 행 18이 비어 있어 16px 떨어져 행 19에 착지하고, 그 위의
    // 가시 히트박스(y 296-304)가 플레이어 박스(y 280-304)와 겹쳐 죽는다.
    await page.evaluate(() => { window.__tp(41 * 16, 18 * 16 - 24); });
    await api.wait(page, 100);
    await api.hold(page, 'ArrowRight', 500);
    await api.wait(page, 500);
    const afterSpike = await api.dbg(page);

    // 깃발: 최종 지면(열 96-99)에 놓는다. 깃발은 열 97(x 1552-1568)이고
    // 플레이어 폭이 36px이라 열 96에 서는 순간 이미 겹친다 — 걸을 필요 없다.
    // 이 위치는 카메라 우측 clamp 상한(camX = 960)도 함께 검증한다.
    await page.evaluate(() => { window.__tp(96 * 16, 18 * 16 - 24); });
    await api.wait(page, 200);
    const afterFlag = await api.dbg(page);
    await api.shot(page, 'clear');

    // R 재시작
    await api.tap(page, 'r');
    await api.wait(page, 200);
    const afterR = await api.dbg(page);
    await api.shot(page, 'hud');
    return { start, walkedCoins, afterPitFall, afterSpike, afterFlag, afterR };
  },

  // Task 6 — 코요테 타임. 발판 끝이 존재하는 첫 시점이라 여기서 처음 검증 가능하다.
  coyote: async (page) => {
    // 튜토리얼 지면은 열 15(x 240-256)에서 끝난다. 그 끝에 놓고 걸어 나간다.
    await page.evaluate(() => { window.__tp(250, 18 * 16 - 24); });
    await api.wait(page, 150);
    const onLedge = await api.dbg(page);

    await page.keyboard.down('ArrowRight');
    // 하니스 왕복 지연 때문에 "떠난 직후 100ms 안에 Space 누르기" 같은
    // 레이스는 신뢰할 수 없다. 대신 타이머 상태를 본다: "공중이면서
    // coyote > 0" 인 샘플이 하나라도 잡히면 메커니즘이 살아 있는 것이다.
    // 떠날 때 coyote가 0으로 리셋되는 구현이면 어떤 샘플도 그 조합을 못 만든다.
    let airborneWithCoyote = null;
    for (let i = 0; i < 30; i++) {
      const d = await api.dbg(page);
      if (!d.onGround && d.coyote > 0) { airborneWithCoyote = d; break; }
      await api.wait(page, 10);
    }
    await page.keyboard.up('ArrowRight');
    return { onLedge, airborneWithCoyote };
  },
```

- [ ] **Step 8: 검증 실행**

```bash
node /tmp/cj/verify.js gameplay
node /tmp/cj/verify.js coyote
```

`gameplay` 기대 결과:
- `consoleErrors`: `[]`
- `result.start`: `state: "PLAYING"`, `collected: 0`, `coinsLeft: 12`
- `result.walkedCoins.collected`: **3** (행 16 열 6/9/12를 걸어서 통과). 1400 ms × 130 px/s ≈ 182 px → x ≈ 214 = 열 13 → 세 코인 모두 지나침
- `result.afterPitFall`: `x: 32`, `y: 264` (시작점 리스폰), `collected: 3` (**코인 유지**. 0이면 리스폰이 잘못 코인까지 초기화한 것)
- `result.afterSpike`: `x: 32`, `y: 264` (가시 접촉 → 시작점 리스폰)
- `result.afterFlag.state`: **`"CLEAR"`**
- `result.afterFlag.camX`: **960** (레벨 폭 1600 − 화면 640. 카메라 우측 경계 clamp)
- `result.afterR`: `state: "PLAYING"`, `collected: 0`, `coinsLeft: 12`, `x: 32`, `y: 264` (완전 초기화)

`coyote` 기대 결과:
- `result.onLedge`: `onGround: true`, `y: 264` (발판 끝에 서 있음)
- `result.airborneWithCoyote`: **`null`이 아니어야 한다.** `onGround: false` 이면서 `coyote`가 `0 < coyote ≤ 0.1`. `null`이면 발판을 떠날 때 코요테 타이머가 살아남지 않는다는 뜻 — `step()`에서 `if (player.onGround) player.coyote = COYOTE_TIME; else player.coyote -= dt;` 의 else 분기가 빠졌거나 순서가 틀렸다

- [ ] **Step 9: 스크린샷 확인**

`/tmp/cj/clear.png` 와 `/tmp/cj/hud.png` 를 Read 툴로 읽는다.

기대:
- `clear.png`: 어두운 반투명 오버레이 위에 `CLEAR!`, `COINS n/12`, `PRESS R TO RESTART`. 오버레이 아래로 지형이 희미하게 보인다.
- `hud.png`: 좌상단에 `COINS 0/12`. 시작 구간의 노란 코인 3개(`#E8C468`), 지형, Clawd가 보인다.

- [ ] **Step 10: 사용자 수동 플레이 (Phase 3 게이트 — 전체 클리어)**

```
ssh -L 8080:localhost:8080 <이 EC2>
# http://localhost:8080/index.html
```

확인 항목: 코인 12개를 모두 모을 수 있는가 / 가시가 억울하게 죽이지 않는가 / 구덩이 4개를 건널 수 있는가 / 계단을 오를 수 있는가 / 공중 발판 구간이 지나치게 어렵지 않은가 / 깃발에서 CLEAR가 뜨고 R로 재시작되는가.

> 이 게이트에서 난이도·코인 위치를 조정할 가능성이 높다. 조정은 `MAP` 문자열만 바꾸면 되고, 물리 상수는 손대지 않는 편이 안전하다 (레벨 제약이 상수에서 도출되므로).

- [ ] **Step 11: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 코인, 가시, 깃발, HUD, 게임 상태와 재시작

Phase 3 완료. 가시는 히트박스(12x8)와 정확히 같은 삼각형 하나로 그린다.
작은 삼각형 여러 개로 그리면 삼각형 사이 빈 공간도 히트박스에 들어가
"분명히 위에 있었는데 죽었다"가 된다. 코인은 반대로 10x10 히트박스에
8x8 시각을 넣어 보이는 것보다 넉넉히 먹히게 했다.

삼각형은 beginPath/fill 대신 1px 바를 쌓아 그린다. 경로 채우기는
안티에일리어싱이 생겨 픽셀아트가 깨진다.

리스폰은 위치와 속도만 초기화하고 코인 획득은 유지한다. 리스폰
페널티가 없어 플레이 테스트가 빠르다.

HUD는 drawText 한 곳으로 모아 뒀다. 시간이 남으면 그 함수만 3x5
비트맵 폰트로 교체하면 된다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: CDK로 S3 + CloudFront 배포 — **Phase 4 완료 게이트**

**Files:**
- Modify: `lib/clawd-jump-stack.ts`
- Modify: `bin/clawd-jump.ts`

**Interfaces:**
- Consumes: `frontend/index.html` (BucketDeployment의 asset 소스)
- Produces: `ClawdJumpStack` — `SiteUrl` CfnOutput

- [ ] **Step 1: AWS 자격증명과 리전 확인**

```bash
aws sts get-caller-identity
aws configure get region || echo $AWS_REGION
```

계정 ID와 리전이 나와야 한다. 실패하면 배포를 진행하지 않고 사용자에게 자격증명 설정을 요청한다.

- [ ] **Step 2: `lib/clawd-jump-stack.ts` 작성**

파일 전체를 교체한다.

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
      comment: 'Clawd Jump static site',
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
      description: 'Clawd Jump URL',
    });
  }
}
```

- [ ] **Step 3: `bin/clawd-jump.ts` 의 env 활성화**

`new ClawdJumpStack(...)` 호출을 교체한다 (주석 블록 전체를 지우고 아래로).

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

기대: `npm run build` 무출력 성공. `cdk synth`가 템플릿을 출력하고, 그 안에 `AWS::S3::Bucket`, `AWS::CloudFront::Distribution`, `AWS::CloudFront::OriginAccessControl`, `Custom::CDKBucketDeployment` 가 들어 있다.

> `S3BucketOrigin.withOriginAccessControl` 이 없다는 타입 에러가 나면 `aws-cdk-lib` 버전의 정확한 API를 `aws-core:aws-cdk` 스킬로 확인한다. 기억에 의존해 다른 이름을 추측하지 않는다.

- [ ] **Step 5: 부트스트랩 (필요시)**

```bash
npx cdk bootstrap 2>&1 | tail -10
```

이미 부트스트랩된 계정/리전이면 빠르게 no-op으로 끝난다.

- [ ] **Step 6: 배포**

```bash
npx cdk deploy --require-approval never 2>&1 | tail -30
```

CloudFront 배포 생성에 **5~10분** 걸린다. 출력 끝의 `SiteUrl` 값을 기록한다.

- [ ] **Step 7: 배포된 사이트 검증**

```bash
SITE=$(aws cloudformation describe-stacks --stack-name ClawdJumpStack \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)
echo "$SITE"
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$SITE"
curl -s "$SITE" | head -5
```

기대: `HTTP 200`, 그리고 `<!DOCTYPE html>` 로 시작하는 게임 HTML.

이어서 하니스로 실제 게임 동작을 확인한다 (URL만 바꿔 재사용).

```bash
CJ_URL="$SITE" node -e "
const p='/tmp/cj/verify.js';
let s=require('fs').readFileSync(p,'utf8');
require('fs').writeFileSync('/tmp/cj/verify-prod.js', s.replace(
  \"const URL = 'http://localhost:8080/index.html';\",
  'const URL = process.env.CJ_URL;'));
"
CJ_URL="$SITE" node /tmp/cj/verify-prod.js gameplay
```

기대: 로컬과 동일한 결과 (`consoleErrors: []`, `afterFlag.state: "CLEAR"`, `afterR.collected: 0`).

- [ ] **Step 8: 사용자 확인 (Phase 4 게이트)**

사용자에게 CloudFront URL을 전달하고 브라우저에서 플레이해 확인받는다.

- [ ] **Step 9: 커밋**

```bash
cd /home/ec2-user/capstone/clawd-jump
git add lib/clawd-jump-stack.ts bin/clawd-jump.ts
git commit -m "$(cat <<'EOF'
feat: S3 비공개 버킷 + CloudFront OAC 배포 스택

Phase 4 완료. S3 정적 웹사이트 호스팅 엔드포인트는 HTTP만 지원하고
버킷 공개를 요구하므로 쓰지 않는다. OAC는 CloudFront만 버킷을 읽는
서명된 요청을 사용해 버킷을 완전 비공개로 유지하면서 HTTPS, HTTP/2,
엣지 캐싱을 제공한다.

BucketDeployment의 소스는 평범한 디렉터리 asset이라 로컬에서 zip되며
Docker가 필요없다. 배포마다 /* 무효화를 걸어 갱신이 수초 내 반영된다.

removalPolicy DESTROY와 autoDeleteObjects는 실습 정리 편의를 위한
설정이며 프로덕션용이 아니다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 정리 (마지막 태스크 후)

```bash
pkill -f 'http[.]serve[r]'     # 대괄호 트릭 — 일반 패턴은 자기 셸을 죽인다
```

레포에 남아야 하는 산출물: `frontend/index.html`, `lib/clawd-jump-stack.ts`, `bin/clawd-jump.ts`, spec, 본 계획.
레포에 **남지 않아야** 하는 것: `/tmp/cj/*`, `/tmp/pw/*`, `/tmp/probe/*` (전부 레포 외부).

배포 리소스를 지우려면 `npx cdk destroy`. `autoDeleteObjects: true` 라 버킷 내용까지 정리된다.

## 시간 예산 배분 (총 2시간)

| 태스크 | 예상 | 누적 |
|---|---|---|
| 1 셸 + 루프 + 하니스 | 15분 | 15분 |
| 2 스프라이트 | 10분 | 25분 |
| 3 물리 (Phase 1 게이트) | 20분 | 45분 |
| 4 레벨 + 충돌 | 15분 | 60분 |
| 5 렌더 + 카메라 (Phase 2 게이트) | 15분 | 75분 |
| 6 게임플레이 (Phase 3 게이트) | 20분 | 95분 |
| 7 배포 (Phase 4 게이트) | 20분 (CloudFront 5~10분 대기 포함) | 115분 |

여유 5분. 사용자 수동 플레이 게이트에서 난이도 조정이 필요하면 Task 6 이후 `MAP` 문자열만 수정한다.
