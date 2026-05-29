# pyeong-leaderboard

작은 Node.js + Express + SQLite 리더보드 서버입니다. `users.user_name` 값을 닉네임으로 사용하며, 점수 제출과 리더보드 조회를 제공합니다. 관리자용 닉네임 수정 화면은 `/admin`에서 열 수 있습니다.

## 실행

```bash
npm install
npm start
```

기본 포트는 `3001`입니다. 환경 변수로 바꿀 수 있습니다.

- `PORT`: 서버 포트
- `DATABASE_FILE`: SQLite 파일 경로
- `DEFAULT_LIMIT`: 리더보드 기본 조회 개수
- `MAX_LAP_SECONDS`: 허용되는 최대 랩 시간

## 기능

- 유저 등록/업데이트: `POST /api/register`
- 점수 제출: `POST /api/score`
- 리더보드 조회: `GET /api/leaderboard?limit=10`
- 상태 확인: `GET /api/health`
- 관리자 닉네임 관리 화면: `GET /admin`

## 관리자 페이지

`/admin`에서는 DB에 저장된 유저 목록을 검색하고, 각 유저의 닉네임을 직접 수정할 수 있습니다.

관리자 페이지가 사용하는 API는 다음과 같습니다.

- 유저 목록 조회: `GET /api/admin/users?query=...&limit=...`
- 닉네임 수정: `PUT /api/admin/users/:id`

## DB 구조

SQLite 데이터베이스 파일은 기본적으로 `leaderboard.db`입니다.

- `users`
  - `device_id`: 기기 식별자
  - `user_name`: 닉네임
  - `created_at`, `updated_at`
- `scores`
  - `user_id`: `users.id` 참조
  - `lap_seconds`: 랩 기록
  - `lap_time_text`: 표시용 시간 문자열

## 예시 요청

```bash
curl -X POST http://localhost:3001/api/register \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"device-001","user_name":"홍길동"}'
```

```bash
curl -X PUT http://localhost:3001/api/admin/users/1 \
  -H 'Content-Type: application/json' \
  -d '{"nickname":"새닉네임"}'
```

## 확인

```bash
npm test
```

이 명령은 `server.js` 문법을 검사합니다.