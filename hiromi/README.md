# hiromi

hitomi.la 비공식 클라이언트와 HTTP API입니다. Go와 클린 아키텍처로 작성했습니다.

hitomi.la와 무관합니다. 공개된 갤러리 JSON, nozomi 인덱스, gg.js 라우팅을 읽을 뿐입니다. 성인 콘텐츠를 다룹니다.

## 필요 환경

- Go 1.24 이상 (이 저장소의 `go.mod`는 1.24.0)

```bash
git clone <저장소-주소>
cd hiromi
go test ./...
```

## 실행

API 서버:

```bash
go run ./cmd/hiromi
```

텔레그램 봇:

```bash
export TELEGRAM_BOT_TOKEN=...
go run ./cmd/bot
```

품번이나 hitomi.la 주소를 보내면 받기 버튼이 나옵니다. 준비가 끝나면 다운로드는 개인 채팅으로 보냅니다. 그룹에는 공유 주소가 보이지 않습니다. 올린 파일은 단일 `viewer.html`이고, 작업이 끝나면 `downloads/{id}` 폴더는 지웁니다. send.vis.ee 한도는 호스트 최댓값(현재 20회, 259200초)입니다. 봇은 크기와 상관없이 항상 send.vis.ee에 올리고, 동시에 준비하는 작업은 2개이며 나머지는 차례를 기다립니다. 받기 기록은 72시간 뒤에 지웁니다.

기본 주소는 `127.0.0.1:8080`이라 이 컴퓨터에서만 요청을 받습니다. 이 API에는 인증이 없으므로 `HIROMI_ADDR=:8080`처럼 바깥으로 열 때는 신뢰할 수 없는 네트워크에 노출하지 마십시오. 내려받기는 POST만 받고, 브라우저 페이지가 보낸 요청(`Origin` 헤더가 있는 POST)은 거절합니다.

```bash
make test
make build
./bin/hiromi
```

## 내려받기

작품을 파싱한 뒤 품번 폴더에 저장합니다.

```bash
go run ./cmd/hiromi download 1234567
go run ./cmd/hiromi download -dir downloads -format webp -workers 2 1234567 1234568
```

| 플래그 | 기본값 | 설명 |
| --- | --- | --- |
| `-dir` | `downloads` 또는 `HIROMI_DOWNLOAD_DIR` | 저장 루트 |
| `-format` | `webp` | `webp`, `avif`, `jxl` |
| `-workers` | `2` | 동시 내려받기 수 |
| `-skip` | `true` | 이미 있는 파일은 건너뜀 |
| `-video` | `true` | 영상이 있으면 함께 받음 |

저장 예:

```text
downloads/1234567/info.json
downloads/1234567/viewer.html
downloads/1234567/001.webp
downloads/1234567/002.webp
```

`viewer.html` 은 shadcn New York Neutral 토큰을 쓴 단일 파일 뷰어입니다. 받은 이미지를 넣어 브라우저로 엽니다.

이미지 CDN이 503을 주면 간격을 두고 다시 받으며, 필요하면 `w1`/`w2` 호스트를 바꿉니다. `downloads/`는 git에 올라가지 않습니다.

## 공유

```bash
go run ./cmd/hiromi share 1234567
```

품번이나 hitomi.la 주소 하나를 받아 내려받고 `viewer.html`을 send.vis.ee에 올립니다. 결과는 표준 출력에 JSON 한 줄(`ok`, `token`, `url`, `title`, `pages`, `size` 등)로 냅니다. 실패하면 `ok`가 `false`이고 `error`와 `code`(`too_large`, `id_mismatch`, `busy` 중 하나이고 그 밖의 실패에는 없음)를 담아 종료 코드 1로 끝납니다. 업로드 호스트는 `SENDVIS_HOST`, 저장 폴더는 `HIROMI_DOWNLOAD_DIR`로 정합니다.

## 환경 변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `HIROMI_ADDR` | `127.0.0.1:8080` | 서버 주소 |
| `HIROMI_FRONT` | `https://hitomi.la` | 사이트 주소 |
| `HIROMI_LTN` | `https://ltn.gold-usergeneratedcontent.net` | 메타데이터 CDN |
| `HIROMI_CDN` | `gold-usergeneratedcontent.net` | 이미지 CDN |
| `HIROMI_TAGINDEX` | `https://tagindex.hitomi.la` | 태그 검색 |
| `HIROMI_TIMEOUT` | `30s` | 원격 요청 제한 시간 |
| `HIROMI_GG_TTL` | `30m` | gg.js 캐시 |
| `HIROMI_INDEX_TTL` | `10m` | 검색 인덱스 버전 캐시 |
| `HIROMI_DISABLE_SNI` | `true` | hitomi.la TLS에서 SNI를 비웁니다. 아래 인증서 안내를 보십시오 |
| `HIROMI_DOWNLOAD_DIR` | `downloads` | 품번별 저장 폴더 |
| `HIROMI_DOWNLOAD_TIMEOUT` | `10m` | 파일 내려받기 제한 시간 |
| `HIROMI_USER_AGENT` | 브라우저 UA | HTTP User-Agent |
| `TELEGRAM_BOT_TOKEN` | 비움 | 텔레그램 봇 토큰. `cmd/bot` 단독 실행에만 필요하며, planabot 본체의 `TELEGRAM_API_TOKEN`과는 다른 이름입니다. `hiromi share`는 이 값을 쓰지 않습니다 |
| `SENDVIS_HOST` | `https://send.vis.ee` | 뷰어 HTML 업로드 호스트 |

## HTTP API

| 방법 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/healthz` | 상태 |
| GET | `/v1/galleries/{id}` | 작품 정보, 태그, 파일 링크 |
| GET | `/v1/galleries/{id}/files` | 파일과 포맷별 URL |
| GET | `/v1/galleries/{id}/files/{index}` | 한 장 정보 |
| GET | `/v1/galleries/{id}/related` | 관련 작품. `embed=1`이면 본문 포함 |
| GET | `/v1/search` | 태그·제목 검색 |
| GET | `/v1/index` | 목록. search와 같은 인자 |
| GET | `/v1/tags?type=artist&starts_with=a` | 태그 목록 |
| GET | `/v1/tags/search?q=character:serina` | 태그 자동완성 |
| GET | `/v1/tags/{type}/{name}/languages` | 해당 태그의 언어 |
| GET | `/v1/languages` | 언어 목록 |
| GET | `/v1/types` | 작품 종류, 태그 종류, 정렬 |
| GET | `/v1/media?hash=&format=webp&thumb=small` | 이미지 URL 계산 |
| GET | `/v1/proxy/galleries/{id}/files/{index}` | 이미지 프록시. `format`, `thumb` |
| POST | `/v1/galleries/{id}/download` | 파싱 후 `downloads/{id}`에 저장. 영상은 최대 1GiB |
| POST | `/v1/downloads` | 여러 품번, 한 번에 20개까지. JSON `{"ids":[123,456]}` 또는 `?ids=123,456` |

검색 인자:

- `q`: `type:manga language:korean` 또는 `character:serina -type:anime`
- `title`: 제목 단어
- `language`: `korean`, `english`, `all`
- `type`, `artist`, `series`, `character`, `group`, `tag`
- `sort`: `added`, `published`, `random`, `today`, `week`, `month`, `year`
- `page`, `size`: 기본 size 25, 최대 100
- `embed=1`: 목록에 작품 본문을 붙임

```bash
curl 'http://127.0.0.1:8080/healthz'
curl 'http://127.0.0.1:8080/v1/galleries/1234567'
curl 'http://127.0.0.1:8080/v1/search?q=language:korean&sort=today&size=10'
curl 'http://127.0.0.1:8080/v1/search?title=serina&size=5'
curl -X POST 'http://127.0.0.1:8080/v1/galleries/1234567/download?format=webp'
```

## 구조

```text
cmd/hiromi                 서버와 download, share 명령
cmd/bot                    텔레그램 봇
internal/domain            엔티티와 오류
internal/port              저장소 포트
internal/usecase           응용 서비스
internal/infra/hitomi      hitomi.la 어댑터
internal/infra/httpapi     HTTP 어댑터
internal/infra/localfs     품번 폴더 저장
internal/infra/viewer      단일 HTML 뷰어
internal/infra/sendshare   send.vis.ee 업로드
internal/infra/telegram    텔레그램 전달 계층
internal/infra/jobstore    다운로드 클레임 저장
internal/app               설정과 조립
```

이미지 URL은 `gg.js`의 case 집합과 `b` 경로로 계산합니다. 목록은 `*.nozomi` 바이너리(32비트 big-endian ID)입니다. hitomi.la HTML과 tagindex는 SNI를 비운 TLS로 붙습니다. 이 경로(hitomi.la와 하위 도메인, 태그 목록과 태그 검색)에서는 서버가 임시 인증서만 내놓으므로 인증서를 검증할 수 없습니다. `HIROMI_DISABLE_SNI=false`로 두면 일반 SNI와 전체 검증으로 붙습니다. 네트워크가 허용할 때만 쓸 수 있습니다.

## 주의

이 소프트웨어는 비공식입니다. hitomi.la의 이용 약관과 현지 법령을 직접 확인해야 합니다. 원격 사이트가 응답 형식이나 CDN 주소를 바꾸면 동작이 깨질 수 있습니다.