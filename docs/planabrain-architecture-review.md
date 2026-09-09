# 프라나브레인 구조 개선 및 검수 결과

## 적용 범위

봇에서 요청을 준비하고 모델에 전달한 뒤 답변과 기억을 저장하는 경로를 개선했습니다. 기존 GeminiWeb 연결 작업을 유지하면서 실행 제어, 모델 연결, 검색 근거, 대화 기록, 기억 저장을 분리했습니다. 모델 버전 변경과 신규 의존성 추가는 없습니다.

## 구조와 동작

| 구간 | 변경 내용 |
| --- | --- |
| Rust 진입점 | 대화별 요청 순서 보장, 요청 식별자 전달, 준비와 생성의 처리 기한 공유, 취소 시 임시 이미지 정리 |
| application | CLI와 HTTP가 같은 대화 서비스를 호출하며 이미지 크기·형식·허용 경로를 검사 |
| runtime | 취소 신호, 처리 기한, 외부 호출과 도구 사용 한도, 단계별 시간과 토큰 사용량 기록 |
| integrations | 모델 연결, 전송, 검색 도구, 출처 해석, 재시도, 이어쓰기 분리 |
| chat | 질문 분류, 링크 문맥, 검색 근거 선택, 기록 재사용, 입력 크기 제한, 전달 문장 정리 분리 |
| memoryflow | 저장 충돌 감지, 요청 중복 방지, 대화 범위 분리, 요약의 별도 실행과 충돌 시 폐기 |

기본 실행 기한은 175000ms이며 같은 실행 안에서 외부 호출은 12회, 도구 사용은 8회까지 허용합니다. 재시도와 이어쓰기에도 같은 한도를 적용합니다. HTTP 요청 처리 동시 실행은 4개로 제한합니다. 준비와 생성은 같은 처리 기한을 사용하지만 호출 횟수는 각 실행에서 집계하며 기억 저장은 별도 단계입니다.

Google과 Vertex는 기존에 설치된 `@google/genai`로 통합했습니다. 취소 신호와 검색 근거, 사용량을 직접 처리합니다. 사용하지 않는 LangChain 및 구형 Google 의존성을 제거했고 남겨 둔 의존성의 잠금 버전은 유지했습니다.

연속 대화에서도 지원되는 검색 도구를 사용할 수 있습니다. 검색이 필요한 질문에 근거가 없는 응답은 기록에 재사용하지 않습니다. 문장 재작성이나 이미지 처리로 모델에 전달한 내용과 최종 답변이 달라지면 대화 기록 구간을 새로 시작합니다. 입력은 추정 24000 tokens 안에서 관리하며 연속 대화의 기존 기록을 몰래 잘라 재사용하지 않습니다.

SQLite 저장은 트랜잭션과 revision 비교를 함께 사용합니다. JSON 저장은 완성된 파일의 원자적 공개와 revision 충돌 검사로 별도 프로세스 사이의 덮어쓰기를 막습니다. 초기화 뒤 도착한 오래된 저장 요청도 거부합니다. 요청 식별자는 범위별 최근 128개를 보관해 기억 중복 저장을 방지합니다. 요약은 원본 대화를 저장한 뒤 수행하며 요약 중 기록이 바뀌면 오래된 요약을 저장하지 않습니다.

기억은 사용자·채팅·대화 범위를 구분합니다. 기록 정리 뒤에도 참여자 정보를 유지합니다. 사용자 기억 초기화는 해당 사용자가 참여한 공유 대화의 기억 전체를 함께 비우므로 같은 대화에 참여한 다른 사용자의 문맥도 제거될 수 있습니다. JSON 초기화는 이전 revision 파일의 내용도 비웁니다.

## 검수 결과

| 검사 | 결과 |
| --- | --- |
| TypeScript 타입 검사 | 통과 |
| TypeScript 소스 테스트, Node 24 | 201개 통과 |
| 빌드 결과 테스트, Node 22 | 201개 통과 |
| 빌드 결과 테스트, Node 20 | 196개 통과, SQLite 전용 5개 제외 |
| 최종 Docker 이미지 내부 테스트 | 201개 통과 |
| TypeScript 빌드 | 통과, 빌드 전에 이전 dist 삭제 |
| Rust 1.86.0 fmt | 통과 |
| Rust 1.86.0 clippy, all-targets, 경고 오류 처리 | 통과 |
| Rust 테스트 | 96개 통과, 기존 외부 연동 검사 7개 제외 |
| Rust release 빌드 | 통과 |
| Docker 이미지 빌드 | 통과 |
| 실제 GeminiWeb 연결 | 산술 질문 1회 정상 응답, 호출·토큰 사용량 기록 확인 |
| 변경 파일 공백 검사 | 통과 |

추가 검사는 별도 프로세스의 동시 기억 저장, 요청 중복 처리, 초기화 뒤 오래된 저장 차단, 원본 기록 제거 뒤 참여자 기억 삭제, 저장소 손상 처리, 채팅 간 격리, HTTP 연결 종료 시 취소, 입력 한도, 이미지 전달과 경로 차단, Google 검색 근거와 취소 신호, 이어쓰기 근거 보존, 한국어 검색 후속 질문과 기억 검색 예산을 포함합니다.

프로젝트에 별도 TypeScript 린트 명령은 없습니다. 타입 검사와 테스트, 빌드로 확인했습니다.

## 운영 시 알아둘 제한

실제 외부 요청은 현재 설정된 GeminiWeb만 검사했습니다. 다른 제공자는 자동 검사로 요청과 응답 처리를 확인했으며 실제 계정별 기능과 응답 품질, 부하 상황은 측정하지 않았습니다. 이번 작업에서 운영 배포는 하지 않았습니다.

GeminiWeb은 기존 요구대로 게이트웨이의 내장 검색을 사용합니다. 게이트웨이가 구조화된 검색 근거를 주지 않는 경우까지 출처 검증을 강제하지 않습니다. 해당 경로의 검색 품질은 별도 실제 질의 평가가 필요합니다.

HTTP 답변·준비 요청 중복 방지는 프로세스 메모리에서 최대 256개, 600000ms 동안 유지됩니다. 프로세스 재시작을 넘는 일정 변경의 정확히 1회 실행을 보장하는 영속 작업 큐는 이번 범위에 포함하지 않았습니다. 여러 기억 범위의 저장은 각각 원자적이며 전체 범위를 묶은 단일 트랜잭션은 아닙니다.

JSON 저장은 오래된 쓰기를 계속 차단하기 위해 비어 있는 revision 파일 이름을 유지합니다. 파일 수는 늘어날 수 있으므로 Node 22 배포의 기본 SQLite 저장을 기준으로 운영합니다. Node 20은 JSON 대체 경로를 검사했습니다.

기존 자료 중 참여자 정보가 이미 없어진 과거 요약은 작성자를 복원할 수 없습니다. 과거 자료까지 완전히 비워야 할 때는 전체 기억 초기화가 필요합니다. 초기화는 애플리케이션 저장 내용 제거이며 별도 백업이나 저장 장치의 물리적 흔적 제거를 뜻하지 않습니다.

기억 검색은 기존 로컬 검색 방식을 유지했습니다. 추가한 평가는 고정 질의에 대한 회귀 검사이며 실제 대화의 정답률 향상을 수치로 입증하는 대규모 품질 평가는 아닙니다.

## 주요 변경 파일

| 파일 | 변경 내용 |
| --- | --- |
| [core/src/bot/handlers/plana.rs](../core/src/bot/handlers/plana.rs) | 요청 순서와 처리 기한 연결 |
| [core/src/bot/state.rs](../core/src/bot/state.rs) | 대화별 실행 잠금 |
| [core/src/planabrain/mod.rs](../core/src/planabrain/mod.rs) | 요청 정보와 CLI 결과 형식, 이미지 수명 관리 |
| [core/src/planabrain/server.rs](../core/src/planabrain/server.rs) | 요청 계약 검사 갱신 |
| [core/src/schedule.rs](../core/src/schedule.rs) | 기존 테스트의 Clippy 경고 정리 |
| [planabrain/package.json](../planabrain/package.json) | 사용하지 않는 의존성 제거와 빌드 정리 |
| [planabrain/src/application/turnService.ts](../planabrain/src/application/turnService.ts) | 공통 실행 서비스와 이미지 검사 |
| [planabrain/src/application/requestCache.ts](../planabrain/src/application/requestCache.ts) | 중복 요청 처리 |
| [planabrain/src/runtime/execution.ts](../planabrain/src/runtime/execution.ts) | 취소, 기한, 한도와 사용량 기록 |
| [planabrain/src/runtime/serial.ts](../planabrain/src/runtime/serial.ts) | 취소 가능한 순차 실행 |
| [planabrain/src/cli/commands/serve.ts](../planabrain/src/cli/commands/serve.ts) | 인증, 입력 검사, 과부하 제한과 연결 취소 |
| [planabrain/src/integrations/chat.ts](../planabrain/src/integrations/chat.ts) | 모델 호출 조합과 이어쓰기 |
| [planabrain/src/integrations/providers/registry.ts](../planabrain/src/integrations/providers/registry.ts) | 제공자 기능과 연결 등록 |
| [planabrain/src/integrations/google/native.ts](../planabrain/src/integrations/google/native.ts) | Google과 Vertex 공통 연결 |
| [planabrain/src/chat/webSearchAnswer.ts](../planabrain/src/chat/webSearchAnswer.ts) | 대화 생성과 근거 정책 |
| [planabrain/src/chat/contextBudget.ts](../planabrain/src/chat/contextBudget.ts) | 입력 크기 제한 |
| [planabrain/src/memory/userMemoryStore.ts](../planabrain/src/memory/userMemoryStore.ts) | 기존 기억 경로의 범위 분리 |
| [planabrain/src/memoryflow/memory-engine.ts](../planabrain/src/memoryflow/memory-engine.ts) | 기억 저장과 요약 실행 분리 |
| [planabrain/src/memoryflow/sqlite-store.ts](../planabrain/src/memoryflow/sqlite-store.ts) | 원자적 저장, 충돌 검사와 초기화 |
| [planabrain/src/memoryflow/json-store.ts](../planabrain/src/memoryflow/json-store.ts) | 프로세스 간 저장 충돌과 초기화 보호 |
| [planabrain/src/memoryflow/concurrency.test.ts](../planabrain/src/memoryflow/concurrency.test.ts) | 별도 프로세스 저장과 초기화 회귀 검사 |
| [planabrain/src/integrations/architecture.test.ts](../planabrain/src/integrations/architecture.test.ts) | 검색·이미지·취소·요약 연결 검사 |
| [planabrain/src/evaluation/policy.test.ts](../planabrain/src/evaluation/policy.test.ts) | 한국어 검색과 기억 선택 회귀 평가 |
