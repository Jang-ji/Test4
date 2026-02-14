# X K-POP 알림 보드

X 계정의 새 게시글을 주기적으로 확인하고, 웹페이지에서 실시간 알림(SSE + 브라우저 Notification)으로 보여주는 간단한 서버입니다.

초기 감시 목록:
- BTS (`bts_bighit`)
- Stray Kids (`Stray_Kids`)
- BLACKPINK (`BLACKPINK`)

## 1) 준비

Node.js 18+ 필요 (`fetch` 내장 사용).

X API Bearer Token을 환경 변수로 설정:

```bash
export X_BEARER_TOKEN="YOUR_X_BEARER_TOKEN"
```

또는 `.env.example` 값을 참고해서 shell/profile에 설정할 수 있습니다.

선택 환경 변수:
- `PORT` (기본값: `8787`)
- `POLL_INTERVAL_MS` (기본값: `30000`)
- `X_API_BASE_URL` (기본값: `https://api.x.com/2`)

## 2) 실행

```bash
node server.mjs
```

브라우저에서 열기:

```text
http://localhost:8787
```

## 3) 계정 추가 방법

두 가지 방법이 있습니다.

1. 웹페이지의 `계정 추가` 폼 사용  
2. `config/accounts.json`에 직접 추가 후 서버 재시작

`config/accounts.json` 형식:

```json
[
  { "name": "BTS", "username": "bts_bighit" },
  { "name": "Stray Kids", "username": "Stray_Kids" },
  { "name": "BLACKPINK", "username": "BLACKPINK" }
]
```

## 4) 동작 방식

- 서버가 X API를 주기적으로 조회
- 계정별 최신 게시글 ID가 바뀌면 `new_post` 이벤트를 브라우저로 전송
- 브라우저는 계정 카드마다 최근 5개 게시글과 이미지 미리보기를 표시하고 Notification을 표시

참고:
- "완전 실시간(push)"이 아니라 `POLL_INTERVAL_MS` 간격의 준실시간입니다.
- 초기 로드 시 첫 게시글은 기준점으로 저장하며, 그 이후 새 글부터 알림이 발생합니다.

## 5) GitHub 업로드

```bash
cd /Users/jismac/test4
git init
git add .
git commit -m "feat: X K-POP alert board"
git branch -M main
git remote add origin https://github.com/<YOUR_ID>/<YOUR_REPO>.git
git push -u origin main
```

## 6) Vercel 배포 (GitHub 연결)

1. Vercel 대시보드에서 `Add New > Project` 선택  
2. 방금 올린 GitHub 저장소 Import  
3. Environment Variables 설정
   - `X_BEARER_TOKEN` (필수)
   - `POLL_INTERVAL_MS` (선택, 기본 `30000`)
   - `X_API_BASE_URL` (선택, 기본 `https://api.x.com/2`)
4. `Deploy` 실행

이 프로젝트는 `vercel.json`이 포함되어 있어서 `/` 요청이 `/public/index.html`로 매핑됩니다.

## 7) Vercel 배포 시 동작 차이

- Vercel에서는 서버 프로세스가 상시 실행되지 않으므로 `SSE 실시간 스트림` 대신 `폴링 모드`로 동작합니다.
- Vercel에서는 파일시스템 영구 쓰기가 불가능하므로 웹 UI의 `계정 추가 저장`이 비활성화됩니다.
  - 계정 추가는 `config/accounts.json` 수정 후 GitHub push -> Vercel 재배포 방식으로 반영하세요.
