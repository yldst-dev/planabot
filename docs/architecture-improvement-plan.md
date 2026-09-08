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
| 2 | CI 릴리즈 게이트, send-vis-ee-api 테스트, Docker 빌드 검증, Dockerfile 캐시 레이어, 이미지 healthcheck | G6 | 완료 |
| 3 | 브리지 타임아웃·취소·동시성 제한 정리, 준비 단계 명령 통합(`turn-prepare`) | G2 | 대기 |
| 4 | 죽은 RAG 코드 제거, CLI 명령 레지스트리, provider 인터페이스와 OpenAI 호환 provider 통합 | G3 | 완료 |
| 5 | 링크 핸들러 공통 파이프라인, `bot/handlers.rs` 분할 | G4 | 완료 |
| 6 | 저장소 추상화와 원자적 쓰기, 갤러리 청구 만료 | G5 | 완료 |
| 7 | planabrain 상주 프로세스(HTTP)로 전환 | G2 | 완료 |

## 원칙

- 각 단계는 기존 테스트와 새 테스트를 모두 통과한 뒤 별도 커밋으로 남긴다.
- 사용자에게 보이는 메시지 문구와 봇 동작은 바꾸지 않는다. 바꿔야 하면 이 문서에 적는다.
- Rust는 1.86에서 컴파일되어야 한다(`cargo +1.86.0 clippy -- -D warnings`).
- Go 전면 재작성은 이 계획 밖이다. 7단계까지 끝나면 planabrain을 Go 서비스로 바꿀지 다시 판단한다.

## 진행 기록

- 2026-09-08: 계획 작성. 1단계 시작.
- 2026-09-08: 1단계 완료. TS는 `config/paths.ts`의 `resolveDataPath`로, Rust는 `planabrain_data_root`로 같은 기준을 쓰고, Rust가 자식 프로세스에 `PLANABRAIN_DATA_DIR`를 항상 넘긴다. 기본값은 planabrain 폴더의 상위이므로 배포에서는 `/app/.planabrain`이 되어 `planabrain-data` 볼륨과 일치한다. 로컬 데이터는 `planabrain/.planabrain`에서 `.planabrain`으로 옮겼다. 로컬 compose에도 `.planabrain` 바인드 마운트를 추가했다.
- 2026-09-08: 2단계 완료. CI에 Go 모듈 두 개의 gofmt·vet·테스트와 Docker 이미지 빌드 잡을 추가하고 릴리즈가 둘을 기다리게 했다. Dockerfile에 Cargo 의존성 사전 빌드 레이어와 두 헬스 엔드포인트를 함께 보는 HEALTHCHECK를 넣었고, `.dockerignore`에 `.planabrain`, `sub2api` 등을 추가했다. planabrain 헬스 응답의 버전은 package.json에서 읽는다. 런타임 이미지에서 Node 툴체인 전체 복사를 줄이는 일은 Docker로 검증할 수 있을 때 하기로 미뤘다.
- 2026-09-08: 4단계 완료. `rag`, `retrieval`, `loaders`와 `ingest` 명령을 지우고 LangChain classic·textsplitters 의존성을 뺐다. CLI 명령은 `cli/registry.ts` 한 곳에서 이름, 검증, 디스패치가 나온다. `integrations/chat.ts`에 provider 레지스트리(이미지 지원, 자격 증명, 검색 가용성, 호출)를 두어 `invokeChatOnce`, `isSearchToolAvailable`, 친밀 모드의 자격 증명 확인이 모두 여기서 나오고, Cerebras와 Model Studio는 `invokeOpenAICompatibleToolChat` 하나를 공유한다. 남은 것: `integrations/gemini/embeddings.ts`와 임베딩 관련 설정은 RAG 제거로 참조하는 코드가 없어졌다(제거 여부는 사용자 확인 필요). 설정 60필드의 provider별 그룹화는 미뤘다.
- 2026-09-08: 5단계 전반 완료. `urlchanger/delivery.rs`가 원본 삭제, 새 메시지 전송, 삭제 실패 시 답장, 사진·동영상 실패 시 텍스트 대체를 한 곳에서 처리하고, 음악·유튜브·X·인스타그램·Threads·구글 공유 핸들러는 `LinkPlan`(관리자용 메시지 목록과 답장용 메시지 목록)만 만든다. 계획 생성 함수는 순수 함수라 문구 테스트 5개를 붙였다. `bot/handlers.rs` 분할은 다음 작업이다.
- 2026-09-08: 5단계 완료. `bot/handlers.rs`(1,868줄)를 `handlers/{command,plana,schedule,callback,message}.rs`로 나누고 진입점 일곱 개만 `handlers/mod.rs`에서 내보낸다. 동작과 문구는 그대로다. 남은 것: `Requester` 제네릭 바운드는 여전히 각 함수에 붙어 있으며, 목 `Requester`를 도입해 핸들러 테스트를 붙이는 일은 다음 단계 이후로 미뤘다.
- 2026-09-08: 6단계 완료. `core/src/persist.rs`의 `write_json_atomic`(임시 파일 후 rename)이 그룹 목록, planabrain 응답 기록, 일정, 갤러리 청구 저장을 모두 맡는다. 상태와 일정 저장소는 비동기 쓰기 잠금을 스냅샷 전에 잡아 오래된 스냅샷이 나중에 착지하는 경쟁을 없앴다. 갤러리 다운로드 청구는 `.planabot/share_claims.json`(`PLANABOT_SHARE_CLAIMS_PATH`)에 24시간 만료로 보관되어 자정 재시동 뒤에도 유효하다.

- 2026-09-08: 7단계 완료. `planabrain serve`가 127.0.0.1의 자동 선택 포트에서 `/v1/turn-prepare`, `/v1/ask`, `/v1/memory-exchange`, `/v1/health`를 토큰 인증으로 제공하고, 표준 입력이 닫히면 함께 종료된다. Rust는 `planabrain::server::spawn_supervisor`가 시작 시 서버를 띄워 준비 신호(`{"ready":true,"port":N}`)를 읽고 종료 시 지수 백오프로 다시 띄운다. 브리지 세 함수는 서버가 있으면 HTTP로, 연결이 안 되면 기존 CLI 실행으로 자동 복귀한다. 실제 데몬 상대 왕복은 약 6밀리초로 CLI 실행(약 500밀리초)보다 빠르다. 서버는 `PLANABOT_PLANABRAIN_SERVER=0`으로 끌 수 있다. 서버는 설정을 시작 시 한 번 읽으므로 `.env` 변경은 봇 재시작이 필요하다.

## 다음 작업

- 나머지 CLI 호출(`todo-list`, `memory-reset-user`, `schedule-interpret`, `tokens`)도 상주 서버 경로로 옮길 수 있다. 빈도가 낮아 미뤘다.
- `Requester` 목 구현과 텔레그램 핸들러 테스트, 설정 60필드의 provider별 그룹화, 런타임 이미지의 Node 툴체인 축소(Docker 검증 필요).
- 2026-09-08: 임베딩 파이프라인 제거. `integrations/gemini/embeddings.ts`, Vertex Express 임베딩 클라이언트, `embeddingProvider`·`embeddingModel`·`openRouterEmbedding*` 설정과 관련 환경 변수 문서를 지웠다. 예전 RAG 인덱스 파일(`.planabrain/index.json`)은 더 이상 읽지 않으므로 지워도 된다.
