## 변경 사항

- 장기 메모리 격리를 강화했습니다.
  - 개인 의미 메모리에 출처 메타데이터(`sourceTurnId`, `createdByUserId`, `visibility`, `scopeKind`)를 저장합니다.
  - 사용자별 메모리와 답글 체인 맥락을 더 엄격하게 분리합니다.
- `conversation` 메모리에 TTL을 추가했습니다.
  - `PLANABRAIN_LOCAL_MEMORY_CONVERSATION_TTL_DAYS`로 오래된 답글 체인 문맥을 자동 정리합니다.
- 개별 의미 메모리 관리 명령을 추가했습니다.
  - `memory-list-facts`
  - `memory-update-fact`
  - `memory-delete-fact`
  - `memory-reset-all`
- Docker 실행 중 메모리 전체 초기화 명령을 추가했습니다.
  - `docker compose exec planabot reset-local-memory`
- 메모리 poisoning 방지 규칙과 retrieval 로그를 추가했습니다.
  - 조작성 문구가 섞인 발화는 semantic memory 승격을 제한합니다.
  - `PLANABRAIN_LOCAL_MEMORY_RETRIEVAL_LOGGING_ENABLED=1`로 회수 로그를 볼 수 있습니다.
