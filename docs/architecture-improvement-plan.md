# 아키텍처 개선 계획

작성일: 2026-09-08. 대상은 Rust 봇 본체(`core/`)와 TypeScript planabrain(`planabrain/`)이다. Go 도구(`hiromi/`, `send-vis-ee-api/`)는 계층 분리가 이미 되어 있어 CI 게이트만 손본다.

## 목표

| 번호 | 목표 | 측정 기준 |
|---|---|---|
| G1 | planabrain 데이터가 배포 볼륨에 기록된다 | 상대 경로 설정이 작업 폴더와 무관하게 하나의 데이터 루트로 풀린다 |
| G2 | 메시지 처리 비용과 실패 격리 | 메시지당 Node 프로세스 기동 6회를 3회 이하로 줄이고 모든 외부 프로세스 호출에 타임아웃을 건다 |
| G3 | planabrain 내부 구조 | provider가 인터페이스와 레지스트리로 분리되고, 죽은 코드가 없으며, CLI 명령 목록이 한 곳에만 있다 |
| G4 | Rust 핸들러 구조 | 링크 처리 관리자·비관리자 쌍 6개가 공통 파이프라인 하나로 합쳐지고 `bot/handlers.rs`가 역할별 모듈로 나뉜다 |
| G5 | 상태 저장 | JSON 저장소가 원자적 쓰기와 직렬화된 쓰기를 공유하고 갤러리 청구에 만료가 있다 |
| G6 | CI와 이미지 | 릴리즈 게이트가 Go 테스트를 포함하고 Docker 빌드가 CI에서 검증되며 이미지에 Node 툴체인 전체가 들어가지 않는다 |

## 단계

| 단계 | 내용 | 목표 | 상태 |
|---|---|---|---|
| 1 | 데이터 루트 단일화(`PLANABRAIN_DATA_DIR`), 로컬 데이터 이전 | G1 | 완료 |
| 2 | CI 릴리즈 게이트, send-vis-ee-api 테스트, Docker 빌드 검증, Dockerfile 캐시 레이어와 런타임 축소, compose healthcheck | G6 | 대기 |
| 3 | 브리지 타임아웃·취소·동시성 제한 정리, 준비 단계 명령 통합(`turn-prepare`) | G2 | 대기 |
| 4 | 죽은 RAG 코드 제거, CLI 명령 레지스트리, provider 인터페이스와 OpenAI 호환 provider 통합 | G3 | 대기 |
| 5 | 링크 핸들러 공통 파이프라인, `bot/handlers.rs` 분할 | G4 | 대기 |
| 6 | 저장소 추상화와 원자적 쓰기, 갤러리 청구 만료 | G5 | 대기 |
| 7 | planabrain 상주 프로세스(HTTP)로 전환 | G2 | 대기 |

## 원칙

- 각 단계는 기존 테스트와 새 테스트를 모두 통과한 뒤 별도 커밋으로 남긴다.
- 사용자에게 보이는 메시지 문구와 봇 동작은 바꾸지 않는다. 바꿔야 하면 이 문서에 적는다.
- Rust는 1.86에서 컴파일되어야 한다(`cargo +1.86.0 clippy -- -D warnings`).
- Go 전면 재작성은 이 계획 밖이다. 7단계까지 끝나면 planabrain을 Go 서비스로 바꿀지 다시 판단한다.

## 진행 기록

- 2026-09-08: 계획 작성. 1단계 시작.
- 2026-09-08: 1단계 완료. TS는 `config/paths.ts`의 `resolveDataPath`로, Rust는 `planabrain_data_root`로 같은 기준을 쓰고, Rust가 자식 프로세스에 `PLANABRAIN_DATA_DIR`를 항상 넘긴다. 기본값은 planabrain 폴더의 상위이므로 배포에서는 `/app/.planabrain`이 되어 `planabrain-data` 볼륨과 일치한다. 로컬 데이터는 `planabrain/.planabrain`에서 `.planabrain`으로 옮겼다. 로컬 compose에도 `.planabrain` 바인드 마운트를 추가했다.
