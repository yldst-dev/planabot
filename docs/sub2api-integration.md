# sub2api와 GPT-5.6 Luna 연결

## 확인한 연결 방식

공식 모델 ID는 `gpt-5.6-luna`입니다. sub2api의 OpenAI 그룹에 Codex 계정을 연결하고 그 그룹에 연결된 API key를 발급합니다. Planabrain은 이 키를 Bearer 인증에 사용해 `/v1/chat/completions`를 호출합니다. sub2api가 내부에서 Codex의 Responses 요청으로 바꾸고 결과를 Chat Completions JSON으로 돌려줍니다.

모델 목록에 표시돼도 연결된 계정의 이용 권한, 사용량 한도, 그룹 모델 매핑에 따라 실제 호출이 실패할 수 있습니다. 모델 매핑에서 Luna를 다른 모델로 바꾸지 않아야 합니다. 관리 화면의 요청 기록에서도 실제 상위 모델을 확인하십시오.

저장소에 이미 있는 로컬 `sub2api/` 폴더는 Gemini Web 게이트웨이입니다. 이번 Codex 연결에는 별도의 Wei-Shaw/sub2api 서버가 필요하며 기존 폴더와 쿠키는 사용하지 않습니다.

## 기존 sub2api 서버 사용

프로젝트 `.env`에 다음 값을 설정합니다. 키는 sub2api 관리 화면에서 발급받은 실제 값으로 채웁니다.

```dotenv
PLANABRAIN_AI_PROVIDER=sub2api
PLANABRAIN_SUB2API_API_KEY=
PLANABRAIN_SUB2API_BASE_URL=http://127.0.0.1:8084/v1
PLANABRAIN_SUB2API_MODEL=gpt-5.6-luna
PLANABRAIN_CHAT_THINKING_MODE=low
PLANABRAIN_CHAT_MAX_OUTPUT_TOKENS=8192
```

주소에 경로가 없으면 `/v1`을 붙입니다. `/openai/v1`처럼 명시한 경로는 유지합니다. URL에 사용자명, 비밀번호, 쿼리, 프래그먼트를 넣으면 시작 시 거절합니다. 키는 전용 환경변수로만 전달합니다.

이 provider는 `PLANABRAIN_SUB2API_MODEL`을 우선하고, 비어 있으면 `gpt-5.6-luna`를 사용합니다. 기존 `PLANABRAIN_CHAT_MODEL`과 OpenRouter 모델 값은 사용하지 않습니다. 임베딩과 보조 모델 설정은 별도입니다.

`PLANABRAIN_CHAT_THINKING_MODE`의 `off`는 `none`, `minimal`은 `low`로 보냅니다. `low`, `medium`, `high`는 그대로 보내고 `default`는 생략합니다. 출력 한도는 추론 토큰을 포함하는 `max_completion_tokens`로 보냅니다. 실제 Codex 상위 서버가 이 한도를 적용하는지는 게이트웨이와 계정 경로에 따라 다를 수 있습니다.

텍스트, 대화 기록, 이미지 입력을 지원합니다. OpenRouter 전용 검색 도구와 샘플링 옵션은 보내지 않습니다. 웹 검색이 필요하면 기존 Ollama 검색 키 및 주소를 유지하고 `PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH=1`로 설정합니다. 검색 결과를 먼저 가져오는 기존 경로를 사용합니다.

## 같은 VM의 Docker Compose에 새로 구성

`docker-compose.sub2api.yml`은 `docker-compose.dokploy.yml`에 합쳐 쓰는 추가 구성입니다. sub2api `0.2.7`, PostgreSQL `18`, Redis `8`을 사용하며 기존 서비스의 의존성 버전은 바꾸지 않습니다.

`.env`에서 다음 값을 각각 채웁니다. 비밀번호와 암호화 키는 `openssl rand -hex 32`를 매번 실행해 서로 다른 값으로 생성합니다. `JWT_SECRET`과 `TOTP_ENCRYPTION_KEY`에 해당하는 아래 값은 재배포할 때도 유지해야 합니다.

```dotenv
SUB2API_ADMIN_EMAIL=admin@sub2api.local
SUB2API_ADMIN_PASSWORD=
SUB2API_POSTGRES_PASSWORD=
SUB2API_REDIS_PASSWORD=
SUB2API_JWT_SECRET=
SUB2API_TOTP_ENCRYPTION_KEY=
```

먼저 게이트웨이만 시작합니다.

```sh
docker compose -f docker-compose.dokploy.yml -f docker-compose.sub2api.yml config --quiet
docker compose -f docker-compose.dokploy.yml -f docker-compose.sub2api.yml up -d sub2api
```

관리 화면은 VM의 `http://127.0.0.1:8084`에서만 열립니다. 다른 컴퓨터에서는 SSH 터널로 접속합니다.

```sh
ssh -N -L 8084:127.0.0.1:8084 deploy@vm-host
```

로컬 브라우저의 `http://127.0.0.1:8084`에서 관리자 로그인 후 OpenAI 그룹, Codex OAuth 계정, 그룹에 연결된 API key를 설정합니다. 계정의 OAuth 로그인은 계정 소유자가 완료해야 합니다. 발급받은 키를 `.env`의 `PLANABRAIN_SUB2API_API_KEY`에 저장한 뒤 봇을 시작합니다.

```sh
docker compose -f docker-compose.dokploy.yml -f docker-compose.sub2api.yml up -d --build planabot
```

Dokploy에서도 두 Compose 파일을 합쳐 배포합니다. 봇의 기본 주소는 내부 DNS인 `http://sub2api:8080/v1`로 덮어씁니다. 이 기본 구성은 로컬 접속용이며 외부 접속은 아래 Cloudflare Tunnel 구성을 추가합니다. 데이터베이스와 Redis는 외부 포트를 열지 않고 내부 저장소 네트워크에서만 통신합니다. 데이터와 계정 정보는 별도 명명 볼륨에 보관합니다.

호스트의 `127.0.0.1`에만 실행한 서버에는 Linux 컨테이너의 `host.docker.internal`로 접근할 수 없습니다. 같은 Compose 서비스 주소를 사용하는 위 구성이 이 문제를 피합니다. macOS의 개발 서버와 별도 VM 사이에서도 각 장비의 `127.0.0.1`은 서로 다른 주소입니다.

## Cloudflare Tunnel로 외부 접속

sub2api는 Dokploy VM에서 계속 실행하고, 같은 Compose 네트워크의 `sub2api-tunnel` 컨테이너가 Cloudflare에 연결합니다. 외부에서는 `https://sub2api.example.com`으로 접속하고, 내부 봇은 계속 `http://sub2api:8080/v1`을 사용합니다. 예시 도메인은 소유한 Cloudflare 도메인으로 바꿉니다.

추가 파일 `docker-compose.sub2api-tunnel.yml`을 선택한 경우에만 Tunnel을 실행합니다. 포트 포워딩이나 VM의 인바운드 포트 추가 개방은 필요하지 않습니다. VM에서 Cloudflare Tunnel로 나가는 연결은 허용돼 있어야 합니다.

1. Cloudflare에서 사용할 도메인을 등록하고 DNS를 관리합니다.
2. 외부 호스트 이름에 맞는 Access의 Self-hosted 애플리케이션을 만들고, 접속할 이메일만 Allow 정책에 허용합니다. 이 설정은 저장소의 Compose 파일이 자동으로 만들지 않습니다.
3. Cloudflare 대시보드의 Networking > Tunnels에서 원격 관리 Tunnel을 생성합니다. Docker 연결 안내에서 발급된 Tunnel 토큰을 Dokploy 환경변수 `SUB2API_TUNNEL_TOKEN`에 저장합니다. sub2api API key와는 다른 값입니다.
4. Tunnel의 Published application 경로에 호스트 이름 `sub2api.example.com`, 서비스 주소 `http://sub2api:8080`을 입력합니다. 커넥터 컨테이너 기준 주소이므로 `localhost:8084`를 사용하지 않습니다.
5. 다음 3개 Compose 파일을 순서대로 합쳐 배포합니다.

```sh
docker compose -f docker-compose.dokploy.yml -f docker-compose.sub2api.yml -f docker-compose.sub2api-tunnel.yml config --quiet
docker compose -f docker-compose.dokploy.yml -f docker-compose.sub2api.yml -f docker-compose.sub2api-tunnel.yml up -d sub2api sub2api-tunnel
```

새 설치에서는 먼저 위 명령으로 sub2api와 Tunnel을 실행하고, 외부 브라우저에서 Access 로그인과 sub2api 관리자 로그인을 마칩니다. Codex 계정 연결 및 API key 발급 후 `PLANABRAIN_SUB2API_API_KEY`를 채우고 봇을 시작합니다.

```sh
docker compose -f docker-compose.dokploy.yml -f docker-compose.sub2api.yml -f docker-compose.sub2api-tunnel.yml up -d --build planabot
```

Dokploy의 Docker Compose 설정에서 Custom Command를 사용할 수 있습니다. 기본 명령의 `-p` 프로젝트 이름과 첫 번째 `-f` 경로는 유지하고, `up` 앞에 `-f docker-compose.sub2api.yml -f docker-compose.sub2api-tunnel.yml`을 추가합니다. Dokploy는 명령 앞에 `docker`를 붙이므로 입력은 `compose ...`로 시작합니다. 처음에는 실행 서비스를 `sub2api sub2api-tunnel`로 한정하고, 키 발급 후 전체 서비스를 배포합니다. 프로젝트 이름을 바꾸면 기존 명명 볼륨과 다른 볼륨이 만들어질 수 있습니다. 이 구성에서는 Dokploy의 Domains에 별도 공개 도메인을 추가할 필요가 없습니다.

브라우저로 관리 화면만 사용할 때는 Access 로그인으로 충분합니다. 외부 프로그램이 API를 호출한다면 Access Service Token을 발급하고 해당 토큰을 허용하는 Service Auth 정책도 애플리케이션에 연결합니다. 요청에 아래 3개 헤더가 모두 필요합니다.

```text
CF-Access-Client-Id: <access-client-id>
CF-Access-Client-Secret: <access-client-secret>
Authorization: Bearer <sub2api-api-key>
```

외부 API 주소는 `https://sub2api.example.com/v1`입니다. 사용자 지정 헤더를 지원하지 않는 클라이언트는 위 Access 구성을 그대로 이용할 수 없습니다. 같은 Compose 안의 Planabrain은 Tunnel을 거치지 않으므로 Access 헤더를 추가할 필요가 없습니다. 외부 호스트에서 API key만 보내면 Access 단계에서 차단될 수 있습니다.

배포 후 Tunnel이 Healthy인지 확인하고, 외부 브라우저에서 허용 계정과 미허용 계정의 접속 결과를 확인합니다. API는 Service Token과 sub2api 키를 함께 보낸 `/v1/models` 요청 및 대화 요청으로 검증합니다. Tunnel이 Healthy여도 서비스 주소가 틀리면 원본 서버에 연결되지 않을 수 있습니다.

외부 접속을 끄려면 Cloudflare의 Published application 경로를 제거하고 `sub2api-tunnel` 서비스만 중지합니다. 내부 봇 연결과 데이터 볼륨은 유지됩니다.

## Workers에 직접 올릴 수 있는지

일반 Workers는 기존 Go HTTP 서버 바이너리나 Docker Compose를 그대로 실행하는 환경이 아닙니다. sub2api를 일반 Worker로 바꾸려면 HTTP 처리, 데이터베이스, Redis 및 파일 저장 부분을 Workers 환경에 맞춰 이식해야 합니다.

Cloudflare Containers는 기존 Linux 컨테이너 이미지를 실행할 수 있으므로 sub2api를 옮길 때 검토할 수 있는 별도 경로입니다. Worker와 Durable Object를 통한 요청 전달, 외부 PostgreSQL과 Redis 연결, 설정 및 파일의 영속 저장 설계가 필요합니다. 현재 Compose의 명명 볼륨이 자동으로 옮겨지는 것은 아닙니다. Containers 디스크는 임시 저장소이며 컨테이너가 다시 시작할 때 데이터가 유지된다고 가정할 수 없습니다. Durable Object 저장소가 기존 PostgreSQL이나 Redis 프로토콜을 자동 대체하지도 않습니다.

Containers는 Workers Paid 플랜에서 제공되고 컴퓨팅 및 관련 서비스 사용량에 따라 요금이 발생합니다. 문서를 바탕으로 실행 후보임을 확인한 것이며, sub2api 이미지를 Containers에 실제 배포해 검증한 상태는 아닙니다. 현재 목적에는 기존 데이터 저장과 계정 갱신 구조를 유지할 수 있는 Dokploy와 Tunnel 조합을 권장합니다.

## 키와 모델 실제 검증

다음 명령은 프로젝트 루트에서 실행합니다. `.env`의 주소와 키로 `/models`와 `/chat/completions`를 확인합니다. 시스템 프롬프트와 대화 저장소를 읽지 않으며 Telegram 메시지도 보내지 않습니다. 실제 모델 요청 1회가 발생합니다. Docker 내부 주소를 사용하는 경우 동일 네트워크 안에서 실행하거나 로컬 주소를 별도 검증 환경에 설정하십시오.

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
- [sub2api 0.2.7 릴리즈 및 이미지 이름](https://github.com/Wei-Shaw/sub2api/releases/tag/v0.2.7)
- [sub2api API 라우트](https://github.com/Wei-Shaw/sub2api/blob/v0.2.7/backend/internal/server/routes/gateway.go)
- [Chat Completions와 Responses 변환](https://github.com/Wei-Shaw/sub2api/blob/v0.2.7/backend/internal/service/openai_gateway_chat_completions.go)
- [공식 Docker Compose](https://github.com/Wei-Shaw/sub2api/blob/v0.2.7/deploy/docker-compose.yml)
- [Cloudflare Tunnel 생성과 외부 호스트 연결](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [cloudflared 토큰 환경변수](https://developers.cloudflare.com/tunnel/guides/kubernetes/)
- [Cloudflare Access Service Token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Dokploy Compose Custom Command](https://docs.dokploy.com/docs/core/docker-compose)
- [Workers 실행 환경](https://developers.cloudflare.com/workers/reference/how-workers-works/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Containers 저장소와 수명](https://developers.cloudflare.com/containers/faq/)
- [Containers 요금](https://developers.cloudflare.com/containers/platform/pricing/)
