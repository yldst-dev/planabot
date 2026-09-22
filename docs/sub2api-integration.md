# sub2api와 GPT-5.6 Luna 연결

## 확인한 연결 방식

공식 모델 ID는 `gpt-5.6-luna`입니다. sub2api의 OpenAI 그룹에 Codex 계정을 연결하고 그 그룹에 연결된 API key를 발급합니다. Planabrain은 이 키를 Bearer 인증에 사용해 `/v1/chat/completions`를 호출합니다. sub2api가 내부에서 Codex의 Responses 요청으로 바꾸고 결과를 Chat Completions JSON으로 돌려줍니다.

모델 목록에 표시돼도 연결된 계정의 이용 권한, 사용량 한도, 그룹 모델 매핑에 따라 실제 호출이 실패할 수 있습니다. 모델 매핑에서 Luna를 다른 모델로 바꾸지 않아야 합니다. 관리 화면의 요청 기록에서도 실제 상위 모델을 확인하십시오.

저장소에 이미 있는 로컬 `sub2api/` 폴더는 Gemini Web 게이트웨이입니다. 이번 Codex 연결에는 별도의 Wei-Shaw/sub2api 서버가 필요하며 기존 폴더와 쿠키는 사용하지 않습니다.

## 별도 Dokploy sub2api 서버 연결

프로젝트 `.env`에 다음 값을 설정합니다. 키는 sub2api 관리 화면에서 발급받은 실제 값으로 채웁니다.

```dotenv
PLANABRAIN_AI_PROVIDER=sub2api
PLANABRAIN_SUB2API_API_KEY=
PLANABRAIN_SUB2API_BASE_URL=https://sub2api.example.com/v1
PLANABRAIN_SUB2API_MODEL=gpt-5.6-luna
PLANABRAIN_CHAT_THINKING_MODE=low
PLANABRAIN_CHAT_MAX_OUTPUT_TOKENS=8192
```

예시 URL은 별도로 Dokploy에 등록한 sub2api의 실제 HTTPS 주소로 바꿉니다. Planabot 컨테이너에서 접속 가능한 주소여야 합니다. 두 서비스가 서로 다른 Compose 프로젝트에 있으면 `127.0.0.1`과 `http://sub2api:8080`은 대개 연결되지 않습니다. 주소에 경로가 없으면 `/v1`을 붙입니다. `/openai/v1`처럼 명시한 경로는 유지합니다. URL에 사용자명, 비밀번호, 쿼리, 프래그먼트를 넣으면 시작 시 거절합니다. 키는 전용 환경변수로만 전달합니다.

이 provider는 `PLANABRAIN_SUB2API_MODEL`을 우선하고, 비어 있으면 `gpt-5.6-luna`를 사용합니다. 기존 `PLANABRAIN_CHAT_MODEL`과 OpenRouter 모델 값은 사용하지 않습니다. 임베딩과 보조 모델 설정은 별도입니다.

`PLANABRAIN_CHAT_THINKING_MODE`의 `off`는 `none`, `minimal`은 `low`로 보냅니다. `low`, `medium`, `high`는 그대로 보내고 `default`는 생략합니다. 출력 한도는 추론 토큰을 포함하는 `max_completion_tokens`로 보냅니다. 실제 Codex 상위 서버가 이 한도를 적용하는지는 게이트웨이와 계정 경로에 따라 다를 수 있습니다.

텍스트, 대화 기록, 이미지 입력을 지원합니다. OpenRouter 전용 검색 도구와 샘플링 옵션은 보내지 않습니다. 웹 검색이 필요하면 기존 Ollama 검색 키 및 주소를 유지하고 `PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH=1`로 설정합니다. 검색 결과를 먼저 가져오는 기존 경로를 사용합니다.

sub2api의 설치, 계정 연결, 이미지 갱신, 데이터 보관은 별도 Dokploy 서비스에서 관리합니다. 이 저장소의 `docker-compose.dokploy.yml`은 Planabot만 배포합니다. Planabot을 배포하기 전에 별도 sub2api 서비스에서 Codex 계정과 API key를 설정하고, Planabot의 Dokploy 환경변수에 위 연결값을 입력합니다.

## 키와 모델 실제 검증

다음 명령은 프로젝트 루트에서 실행합니다. `.env`의 주소와 키로 `/models`와 `/chat/completions`를 확인합니다. 시스템 프롬프트와 대화 저장소를 읽지 않으며 Telegram 메시지도 보내지 않습니다. 실제 모델 요청 1회가 발생합니다. Planabot 컨테이너에서도 같은 URL에 연결되는지 따로 확인해야 합니다.

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import { parse } from './planabrain/node_modules/dotenv/lib/main.js';
const env = { ...parse(fs.readFileSync('.env')), ...process.env };
const key = env.PLANABRAIN_SUB2API_API_KEY?.trim();
const base = env.PLANABRAIN_SUB2API_BASE_URL?.replace(/\/+$/, '');
const model = env.PLANABRAIN_SUB2API_MODEL?.trim() || 'gpt-5.6-luna';
if (!key || !base) throw new Error('sub2api key와 /v1 주소를 설정하십시오.');
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const list = await fetch(`${base}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
if (!list.ok) throw new Error(`모델 목록 HTTP ${list.status}`);
const models = await list.json();
console.log(JSON.stringify({ listed: models.data?.some(item => item.id === model), requestedModel: model }));
const response = await fetch(`${base}/chat/completions`, {
  method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(60000),
  body: JSON.stringify({ model, stream: false, reasoning_effort: 'low', max_completion_tokens: 1024, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
});
if (!response.ok) throw new Error(`대화 요청 HTTP ${response.status}`);
const body = await response.json();
if (!body.choices?.[0]?.message?.content) throw new Error('응답 본문이 없습니다.');
console.log(JSON.stringify({ responseModel: body.model, hasReply: true }));
JS
```

`401` 또는 `403`이면 키와 그룹 권한, `400`이면 모델 ID와 요청 옵션, `429`이면 계정 한도, `502` 또는 `503`이면 상위 계정 상태와 게이트웨이 로그를 확인합니다. 응답의 모델 이름만으로 상위 모델을 확정하지 말고 sub2api 요청 기록도 함께 확인하십시오.

## 출처

- [OpenAI GPT-5.6 Luna 모델 문서](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [sub2api API 라우트](https://github.com/Wei-Shaw/sub2api/blob/v0.2.7/backend/internal/server/routes/gateway.go)
- [Chat Completions와 Responses 변환](https://github.com/Wei-Shaw/sub2api/blob/v0.2.7/backend/internal/service/openai_gateway_chat_completions.go)
