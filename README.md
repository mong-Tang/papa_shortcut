# Papa Launcher (Electron 위젯 런처)

Windows 11 바탕화면 위젯 형태의 실행 런처입니다.  
기존 PowerShell 기반 런처를 Electron + React + TypeScript 구조로 전환했습니다.

핵심 UX:
- 더블클릭 = 즉시 실행
- Enter = 선택 항목 즉시 실행
- 더블클릭 동작 없음
- 앱 내부에서 항목 편집 가능(`Edit`)

## 1. 개발 환경

- Windows 11
- Node.js 22 이상
- npm (`npm.cmd` 사용)

## 2. 개발 실행

```powershell
npm.cmd install
npm.cmd run dev
```

개발 모드 구성:
- Renderer: Vite dev server (`127.0.0.1:5173`)
- Main: Electron (`dist-electron/electron/main.js`)

## 3. 빌드/패키징

```powershell
npm.cmd run build
```

설치형 EXE(NSIS) 생성:

```powershell
npm.cmd run dist
```

OneDrive 경로에서 `EPERM rename` 오류가 발생하면:

```powershell
npm.cmd run dist:temp
```

- 출력 위치: `%TEMP%\papa-launcher-dist`

## 4. 프로젝트 구조

```text
electron/
  main.ts
  preload.ts
src/
  renderer/
    App.tsx
    main.tsx
    styles.css
  shared/
    config-schema.ts
    types.ts
config/
  launcher.config.json
assets/
  icons/
```

## 5. 설정 파일

읽기 우선순위:
1. 사용자 설정: `%APPDATA%\papa-launcher\config\launcher.config.json`
2. 번들 기본값: `resources/config/launcher.config.json`

저장 위치:
- 항상 사용자 설정 경로에 저장됩니다.
- 저장 시 기존 파일은 `.bak`로 백업 후 교체 저장됩니다.

예시(`config/launcher.config.json`):

```json
{
  "version": 2,
  "app": {
    "title": "Papa Launcher",
    "fullscreen": false,
    "mode": "widget",
    "widget": {
      "width": 460,
      "height": 760,
      "anchor": "bottom-right",
      "offsetX": 0,
      "offsetY": 0,
      "alwaysOnTop": true,
      "skipTaskbar": false,
      "resizable": true,
      "frame": false,
      "hideOnBlur": false,
      "hideTrigger": "outside-click",
      "blurBehavior": "windows-docking",
      "edgeVisiblePx": 30,
      "toggleShortcut": "Control+Shift+Space"
    },
    "theme": "blue"
  },
  "categories": [
    { "id": "all", "label": "전체" },
    { "id": "game", "label": "게임" }
  ],
  "items": [
    {
      "id": "chrome",
      "name": "크롬",
      "categoryId": "all",
      "target": "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "args": "",
      "workingDir": "C:/Program Files/Google/Chrome/Application",
      "icon": "assets/icons/web.svg",
      "keywords": ["브라우저"]
    }
  ]
}
```

주요 규칙:
- `version`은 `2` 고정
- `categories[].id` 중복 불가
- `items[].id` 중복 불가
- `items[].categoryId`는 존재하는 카테고리여야 함
- `target`은 URL / exe / 폴더 / 파일 경로 지원

## 6. 실행 동작

- 단일 클릭: 선택만 변경
- 더블클릭: 즉시 실행
- 방향키: 선택 이동
- Enter: 선택 항목 실행
- Esc: 검색 포커스 해제(앱 종료 아님)
- 실행 실패: 상태바 + 오류 모달 표시

위젯 모드 추가 동작:
- `hideOnBlur: true`일 때만 포커스 이탈 시 위젯 숨김
- `hideTrigger: "outside-click"`이 기본값이며, 위젯 외부 클릭에서만 숨김/도킹 트리거
- `hideTrigger: "blur"`를 지정하면 기존 포커스 이탈(blur) 기반 트리거로 동작
- `blurBehavior: "windows-docking"`일 때 포커스 이탈 시 우측 가장자리로 도킹(얇은 영역 노출)
- `blurBehavior: "dock-right-edge"`도 하위 호환으로 동일 동작
- `edgeVisiblePx`로 도킹 시 노출 두께(px) 조절
- `toggleShortcut`으로 위젯 표시/숨김 토글
- `resizable: true`일 때 위젯은 세로(상하)만 크기 조절 가능(가로 폭은 고정)

## 7. 항목 편집기

- 상단 `Edit` 버튼으로 편집기 열기
- `Add Item`, `Delete Item`, `Save` 제공
- 저장 전 유효성 검사:
  - ID/Name/Category/Target 필수
  - ID 중복 금지
  - 존재하지 않는 category 금지

## 8. 테스트

```powershell
npm.cmd run test
```

현재 포함:
- `src/shared/config-schema.test.ts`

## 9. IPC 계약

- `getConfig(): LauncherConfig | ErrorResult`
- `reloadConfig(): ReloadResult`
- `launchItem(itemId: string): LaunchResult`
- `saveConfig(config): SaveConfigResult`

## 10. 문제 해결

로그 파일:
- `%APPDATA%\papa-launcher\logs\launcher.log`

앱이 바로 꺼지는 경우:
1. 환경 변수 확인
```powershell
$env:ELECTRON_RUN_AS_NODE
```
2. 값이 `1`이면 해제
```powershell
$env:ELECTRON_RUN_AS_NODE=$null
```

## 11. 레거시 파일

기존 PowerShell 기반 파일(`windows/*.ps1`, `windows/shortcuts.json`)은 저장소에 남아 있습니다.  
새 런처는 Electron 구조를 기준으로 동작합니다.
