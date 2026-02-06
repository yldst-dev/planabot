# 텔레그램 봇 헬스체크 연동 가이드

이 문서는 텔레그램 봇(Core/Brain)의 상태를 Status Dashboard에서 모니터링하기 위한 연동 가이드입니다.

## 1. 개요

### 1.1 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                      Status Dashboard                           │
│                    (이 프로젝트, Next.js)                        │
│                                                                 │
│  ┌─────────────┐    60초마다 폴링     ┌─────────────────────┐   │
│  │  /api/status │ ─────────────────▶  │ 텔레그램 봇 서버들    │   │
│  │             │ ◀───────────────────│                     │   │
│  │  lib/status │    HTTP 200 OK      │ Core (Rust)         │   │
│  │  /get-status│                     │ Brain (TypeScript)  │   │
│  └─────────────┘                     └─────────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────┐                                               │
│  │ status_history│ ◀── 상태 기록 저장                           │
│  │  (Supabase)  │                                              │
│  └─────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 동작 흐름

1. 사용자가 Status Dashboard 페이지 접속
2. 페이지가 `/api/status` API를 호출 (60초마다 자동 갱신)
3. API가 등록된 각 서비스의 `health_url`로 GET 요청 전송
4. 텔레그램 봇 헬스체크 서버가 HTTP 응답 반환
5. 응답 코드에 따라 상태(operational/degraded/outage) 결정
6. 상태 이력이 `status_history` 테이블에 저장
7. 프론트엔드에 결과 표시

### 1.3 전제 조건

- 텔레그램 봇에 HTTP 헬스체크 서버 구현 필요
- Core (Rust): 별도 HTTP 서버 또는 기존 서버에 엔드포인트 추가
- Brain (TypeScript): 별도 HTTP 서버 또는 기존 서버에 엔드포인트 추가
- 외부에서 접근 가능한 URL 필요 (공인 IP 또는 도메인)

---

## 2. 텔레그램 봇 헬스체크 서버 구현

### 2.1 응답 스펙

Status Dashboard가 기대하는 최소 응답:

| 항목 | 요구사항 |
|------|----------|
| HTTP 메서드 | GET |
| 정상 상태 코드 | 200-299 |
| 응답 형식 | 아무 형식 (JSON 권장) |
| 타임아웃 | 5초 이내 응답 필요 |

**권장 JSON 응답 형식:**

```json
{
  "status": "ok",
  "uptime": 12345,
  "version": "1.0.0",
  "timestamp": "2024-01-15T12:00:00Z"
}
```

> 참고: 응답 본문은 현재 사용되지 않습니다. HTTP 상태 코드만으로 서비스 상태를 판단합니다.

### 2.2 URL 시크릿 인증

무단 접근을 방지하기 위해 URL 쿼리 파라미터로 시크릿을 전달합니다.

**URL 형식:**
```
https://your-bot-server.com/health?secret=YOUR_SECRET_HERE
```

**시크릿 생성 방법:**
```bash
openssl rand -base64 32
```

### 2.3 Core (Rust) 예제

axum 프레임워크 기반 최소 예제:

```rust
use axum::{
    extract::Query,
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::env;

#[derive(Deserialize)]
struct HealthQuery {
    secret: Option<String>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    uptime: u64,
}

async fn health_check(Query(query): Query<HealthQuery>) -> Result<Json<HealthResponse>, StatusCode> {
    let expected_secret = env::var("HEALTH_SECRET").ok();
    
    // 시크릿 검증
    if let Some(expected) = expected_secret {
        match query.secret {
            Some(provided) if provided == expected => {}
            _ => return Err(StatusCode::UNAUTHORIZED),
        }
    }
    
    // TODO: 실제 헬스 상태 체크 로직 추가
    Ok(Json(HealthResponse {
        status: "ok",
        uptime: 12345, // 실제 uptime으로 교체
    }))
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/health", get(health_check));
    
    let port = env::var("HEALTH_PORT").unwrap_or_else(|_| "3001".to_string());
    let addr = format!("0.0.0.0:{}", port);
    
    println!("Health server listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
```

**Cargo.toml 의존성:**
```toml
[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
```

### 2.4 Brain (TypeScript) 예제

Express 프레임워크 기반 최소 예제:

```typescript
import express from 'express'

const app = express()
const PORT = process.env.HEALTH_PORT || 3002
const HEALTH_SECRET = process.env.HEALTH_SECRET

app.get('/health', (req, res) => {
  // 시크릿 검증
  if (HEALTH_SECRET && req.query.secret !== HEALTH_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // TODO: 실제 헬스 상태 체크 로직 추가
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    version: '1.0.0',
    timestamp: new Date().toISOString()
  })
})

app.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`)
})
```

**package.json 의존성:**
```json
{
  "dependencies": {
    "express": "^4.18.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0"
  }
}
```

---

## 3. Status Dashboard 설정

### 3.1 서비스 등록 방법

1. Admin 페이지 접속: `https://your-status-page.com/admin`
2. 사이드바에서 **Services** 클릭
3. **Add Service** 버튼 클릭
4. 폼 작성:

| 필드 | 값 예시 | 설명 |
|------|---------|------|
| Name | Telegram Bot - Core | 서비스 표시 이름 |
| Description | Rust 코어 모듈 | 선택적 설명 |
| Group | Telegram Bot | 그룹핑 (같은 그룹끼리 묶여서 표시) |
| URL | https://t.me/your_bot | 공개 URL (선택) |
| Health URL | `https://bot.example.com:3001/health?secret=xxx` | **헬스체크 엔드포인트** |
| Sort Order | 1 | 정렬 순서 |

5. **Save** 클릭

### 3.2 예시 설정값

**Core 서비스:**
```
Name:        Telegram Bot - Core
Description: Rust 기반 코어 처리 모듈
Group:       Telegram Bot
Health URL:  https://your-server.com:3001/health?secret=abc123xyz
Sort Order:  1
```

**Brain 서비스:**
```
Name:        Telegram Bot - Brain
Description: TypeScript 기반 AI 처리 모듈
Group:       Telegram Bot
Health URL:  https://your-server.com:3002/health?secret=abc123xyz
Sort Order:  2
```

### 3.3 Manual Status Override

헬스체크 외에 수동으로 상태를 설정할 수도 있습니다:

- **Manual Status**: `operational` / `degraded` / `outage` / `maintenance`
- **Status Message**: 수동 상태일 때 표시할 메시지

> 수동 상태가 설정되면 헬스체크 결과보다 우선합니다.

---

## 4. API 통신 스펙

### 4.1 헬스체크 요청 (Status Dashboard → Bot)

```http
GET https://your-bot-server.com:3001/health?secret=YOUR_SECRET HTTP/1.1
Host: your-bot-server.com
User-Agent: StatusPage-HealthCheck/1.0
```

**특이사항:**
- 타임아웃: 5초 (`lib/status/get-status.ts:28`)
- 리다이렉트: 따라가지 않음 (기본 fetch 동작)
- 인증: URL 쿼리 파라미터로 시크릿 전달

### 4.2 예상 응답

**정상 (200 OK):**
```json
{
  "status": "ok",
  "uptime": 86400
}
```

**인증 실패 (401 Unauthorized):**
```json
{
  "error": "Unauthorized"
}
```

**서버 오류 (500 Internal Server Error):**
```json
{
  "error": "Internal server error"
}
```

### 4.3 HTTP 상태 코드 → 서비스 상태 매핑

| HTTP 상태 코드 | 서비스 상태 | 설명 |
|---------------|-------------|------|
| 200-299 | `operational` | 정상 작동 |
| 400-499 | `degraded` | 성능 저하 (클라이언트 오류) |
| 500+ | `outage` | 서비스 중단 |
| Timeout (5초 초과) | `outage` | 응답 없음 |
| 네트워크 오류 | `outage` | 연결 실패 |

> 참고: `lib/status/get-status.ts:47-74` 참조

---

## 5. 보안 권장사항

### 5.1 시크릿 관리

- 시크릿은 최소 32자 이상의 랜덤 문자열 사용
- 각 서비스(Core/Brain)마다 다른 시크릿 사용 권장
- 환경 변수로 관리, 코드에 하드코딩 금지

**시크릿 생성:**
```bash
# Linux/macOS
openssl rand -base64 32

# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 5.2 네트워크 보안

- **HTTPS 필수**: 시크릿이 URL에 포함되므로 반드시 HTTPS 사용
- **방화벽**: 헬스체크 포트는 Status Dashboard IP만 허용 권장
- **Rate Limiting**: 과도한 요청 방지를 위한 rate limit 설정 권장

### 5.3 포트 분리

헬스체크 서버를 메인 봇 서버와 분리된 포트에서 실행:

```
Main Bot Server:    포트 8080 (내부용)
Core Health Check:  포트 3001 (외부 노출)
Brain Health Check: 포트 3002 (외부 노출)
```

---

## 6. 트러블슈팅

### 6.1 상태가 항상 `outage`로 표시됨

**원인 1: 타임아웃**
- 헬스체크 서버가 5초 이내에 응답해야 함
- 해결: 헬스체크 로직 최적화, 무거운 작업 제거

**원인 2: 네트워크 접근 불가**
- Status Dashboard 서버에서 봇 서버로 접근 불가
- 해결: 방화벽 설정 확인, 포트 개방

**원인 3: HTTPS 인증서 오류**
- 자체 서명 인증서 사용 시 실패 가능
- 해결: Let's Encrypt 등 공인 인증서 사용

### 6.2 401 Unauthorized 오류

- 시크릿이 일치하지 않음
- URL 인코딩 문제 확인 (특수문자 포함 시)
- 환경 변수가 제대로 로드되었는지 확인

### 6.3 상태가 `degraded`로 표시됨

- HTTP 400-499 상태 코드 반환 중
- 헬스체크 서버 로그에서 실제 응답 코드 확인
- 인증 로직 확인

### 6.4 로그 확인 방법

**Status Dashboard 측:**
```bash
# Vercel 배포 시
vercel logs --follow

# 로컬 개발 시
bun run dev
# 콘솔에서 fetch 오류 확인
```

**텔레그램 봇 측:**
```bash
# 수동 테스트
curl -v "https://your-server.com:3001/health?secret=YOUR_SECRET"
```

### 6.5 수동 상태로 임시 전환

헬스체크 문제 해결 중 임시로 수동 상태 설정:

1. Admin → Services → 해당 서비스 Edit
2. Manual Status: `operational` 또는 `maintenance`
3. Status Message: "점검 중" 등 메시지 입력
4. Save

---

## 7. 체크리스트

### 텔레그램 봇 측

- [ ] Core (Rust) 헬스체크 서버 구현
- [ ] Brain (TypeScript) 헬스체크 서버 구현
- [ ] `HEALTH_SECRET` 환경 변수 설정
- [ ] 헬스체크 포트 방화벽 개방
- [ ] HTTPS 인증서 설정
- [ ] 수동 테스트 (`curl`로 확인)

### Status Dashboard 측

- [ ] Core 서비스 등록 (Health URL 포함)
- [ ] Brain 서비스 등록 (Health URL 포함)
- [ ] 그룹핑 설정 ("Telegram Bot")
- [ ] 상태 표시 확인
- [ ] 5일 이력 그래프 확인
