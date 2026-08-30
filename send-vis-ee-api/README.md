# send.vis.ee 비공식 클라이언트

[send.vis.ee](https://send.vis.ee/)용 비공식 Go 클라이언트입니다. 브라우저가 쓰는 Send v3 프로토콜을 그대로 구현했고, CLI와 로컬 REST, 라이브러리로 파일을 올리고 관리합니다.

send.vis.ee 운영자와 무관한 비공식 구현입니다. 공식 SDK나 API 키가 있는 것이 아닙니다. 호스트 이용 한도와 운영 정책을 지키십시오.

대상 인스턴스: `https://send.vis.ee` (Send `v3.4.27`)

| 항목 | 값 |
| --- | --- |
| 최대 파일 크기 | 2684354560바이트 (2.5GiB) |
| 최대 보관 | 259200초 (3일) |
| 최대 다운로드 | 20회 |
| 권장 다운로드 횟수 | 1, 2, 3, 5, 10, 20 |
| 권장 만료 | 300, 3600, 86400, 259200초 |

파일은 이 프로그램이 암호화한 뒤에 올라갑니다. 서버는 평문을 받지 않습니다. 공유 주소 `#` 뒤가 복호화 비밀입니다.

## 업로드가 하는 일

공개된 REST 업로드 API를 부르는 방식이 아닙니다. 웹사이트와 같은 Send v3 경로를 직접 탑니다.

1. 16바이트 비밀키를 만듭니다.
2. HKDF-SHA256으로 메타데이터 키, HMAC 인증키, ECE 암호키를 유도합니다.
3. 파일 이름, 크기, MIME을 AES-128-GCM으로 암호화합니다.
4. `wss://send.vis.ee/api/ws`에 WebSocket으로 붙습니다.
5. JSON으로 암호 메타데이터, 인증키, 만료, 다운로드 한도를 보냅니다.
6. 서버가 `id`, 다운로드 주소, `ownerToken`을 줍니다.
7. 파일 본문을 ECE(64KiB 레코드, AES-128-GCM)로 암호화해 바이너리 메시지로 보냅니다.
8. 마지막에 1바이트 `0`으로 끝을 알립니다.
9. 서버가 `{ "ok": true }`를 주면 공유 주소는 `https://send.vis.ee/download/{id}/#{비밀}`입니다.

삭제, 정보, 비밀번호, 한도 변경, 존재 확인, 메타데이터, 내려받기는 HTTP입니다.

| 용도 | 경로 |
| --- | --- |
| 업로드 | `wss://send.vis.ee/api/ws` |
| 삭제 | `POST /api/delete/{id}` |
| 소유 정보 | `POST /api/info/{id}` |
| 비밀번호 | `POST /api/password/{id}` |
| 다운로드 한도 | `POST /api/params/{id}` |
| 존재 확인 | `GET /api/exists/{id}` |
| 메타데이터 | `GET /api/metadata/{id}` |
| 내려받기 | `GET /api/download/{id}` |

관리 요청에는 업로드 때 받은 `owner_token`이 들어갑니다. 내려받기와 메타데이터는 `Authorization: send-v1 <HMAC>`입니다. 비밀번호를 걸면 인증키를 공유 주소 전체(비밀 포함)를 salt로 한 PBKDF2-HMAC-SHA256(100회, 64바이트)으로 바꿉니다.

구현 기준은 [timvisee/send](https://github.com/timvisee/send) v3.4.27입니다.

## 구성

| 계층 | 경로 | 역할 |
| --- | --- | --- |
| 도메인 | `internal/domain` | 파일, 한도, 공유 주소, 오류 |
| 유스케이스 | `internal/usecase` | 업로드, 조회, 삭제, 비밀번호, 한도 변경 |
| 인프라 | `internal/infra/sendhost`, `crypto`, `history` | Send v3 게이트웨이, ECE/HKDF, 로컬 이력 |
| 전달 | `internal/delivery/http`, `cli` | 로컬 REST와 CLI |
| 진입점 | `cmd/api`, `cmd/sendvis` | 서버, CLI |
| 라이브러리 | `pkg/sendvis` | 다른 Go 프로그램에서 호출 |

## 준비

Go 1.24 이상이 필요합니다.

```bash
go test ./...
go run ./cmd/api
go run ./cmd/sendvis instance
```

기본 수신 주소는 `127.0.0.1:8080`입니다. 이력 파일은 사용자 설정 폴더의 `sendvis/history.json`입니다. 여기에는 공유 비밀과 `owner_token`이 들어 있으니 저장소에 넣지 마십시오.

환경 변수:

| 이름 | 기본 | 설명 |
| --- | --- | --- |
| `SENDVIS_HOST` | `https://send.vis.ee` | Send 인스턴스 |
| `SENDVIS_LISTEN` | `127.0.0.1:8080` | 로컬 API 주소 |
| `SENDVIS_HISTORY` | 사용자 설정 폴더 | 업로드 이력 JSON |
| `SENDVIS_API_KEY` | 비움 | 설정하면 `X-API-Key` 필요 |
| `SENDVIS_USER_AGENT` | `sendvis-unofficial/1.0` | 원격 요청 UA |

로컬 REST를 `127.0.0.1` 밖으로 열면 `SENDVIS_API_KEY`를 켜십시오. 응답에 복호화 비밀과 소유 토큰이 포함됩니다.

## CLI

```bash
go run ./cmd/sendvis upload --downloads 1 --expire 86400 ./hello.txt
go run ./cmd/sendvis list
go run ./cmd/sendvis info <id-or-url>
go run ./cmd/sendvis download <url> -o ./out
go run ./cmd/sendvis password <id> 'pass'
go run ./cmd/sendvis limit <id> 10
go run ./cmd/sendvis delete <id>
go run ./cmd/sendvis instance
```

옵션은 파일 경로 앞이나 뒤에 둘 수 있습니다.

## 로컬 REST

```bash
curl -sS -F file=@./hello.txt \
  -F download_limit=1 \
  -F expire_seconds=86400 \
  http://127.0.0.1:8080/v1/files
```

본문 스트림:

```bash
curl -sS --data-binary @./hello.txt \
  -H 'Content-Type: text/plain' \
  -H 'X-Filename: hello.txt' \
  'http://127.0.0.1:8080/v1/files?download_limit=1&expire_seconds=3600'
```

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/healthz` | 생존 확인 |
| GET | `/v1/instance` | 원격 한도와 버전 |
| POST | `/v1/files` | 업로드 |
| GET | `/v1/files` | 로컬 이력 |
| GET | `/v1/files/{id}` | 상세, 기본으로 원격 새로고침 |
| DELETE | `/v1/files/{id}` | 원격 삭제 후 이력 제거 |
| POST | `/v1/files/{id}/password` | `{"password":"..."}` |
| PATCH | `/v1/files/{id}` | `{"download_limit":5}` |
| GET | `/v1/files/{id}/exists` | 원격 존재 여부 |
| GET | `/v1/files/{id}/download` | 복호화 다운로드, `?password=` |
| POST | `/v1/import` | 기존 공유 주소 이력에 넣기 |
| POST | `/v1/inspect` | 주소만으로 메타데이터 조회 |
| POST | `/v1/download` | 주소로 복호화 받아오기 |

업로드 응답 예:

```json
{
  "id": "0123456789abcdef",
  "url": "https://send.vis.ee/download/0123456789abcdef/#...",
  "owner_token": "...",
  "secret": "...",
  "download_limit": 1,
  "expire_seconds": 86400
}
```

`url`을 그대로 공유하면 됩니다. `owner_token`은 삭제와 한도 변경에 필요합니다.

## 라이브러리

```go
import "github.com/yldst-dev/send.vis.ee-api/pkg/sendvis"

client, err := sendvis.New(sendvis.Options{MemoryOnly: true})
file, err := client.UploadPath(ctx, "report.pdf", 5, 86400, "")
```

```bash
go get github.com/yldst-dev/send.vis.ee-api/pkg/sendvis
```

## 라이선스

MIT License. 전문은 `LICENSE` 파일을 보십시오. send.vis.ee와 timvisee/send의 상표, 이용 약관, 라이선스와는 별개입니다.
