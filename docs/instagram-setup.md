# Instagram 계정 연결 (Meta 앱 세팅 가이드)

`uncommitted instagram connect`로 내 Instagram 계정을 연결하기 전에 Meta 쪽에서
한 번만 하면 되는 준비 과정입니다. 연결에는 **만료되지 않는 시스템 사용자 토큰**을
씁니다. OAuth 로그인이나 토큰 갱신은 없습니다.

> 이 가이드는 2026-11 기준 Meta 화면을 따릅니다. 메뉴 이름은 바뀔 수 있습니다.

## 1. Instagram 계정을 프로페셔널 계정으로 전환

개인 계정은 게시 API를 쓸 수 없습니다.

1. Instagram 앱 → 설정 → 계정 유형 및 도구 → **프로페셔널 계정으로 전환**.
2. 크리에이터 또는 비즈니스 중 아무거나 고릅니다.

## 2. 비즈니스 포트폴리오 만들기

1. [business.facebook.com](https://business.facebook.com)에서 비즈니스 포트폴리오를
   만듭니다. 무료이고 비즈니스 인증 서류는 필요 없습니다.
2. 설정 → 계정 → **Instagram 계정**에서 1번의 계정을 추가합니다.

## 3. Meta 앱 만들기 (통합 로그인)

1. [developers.facebook.com](https://developers.facebook.com) → 내 앱 → 앱 만들기.
2. 사용 사례에서 Instagram API를 고르고, **API setup with Unified login**(통합 로그인)을
   선택합니다. 새 앱에서는 "Instagram 로그인" 방식이 나오지 않습니다.
3. 앱을 2번의 비즈니스 포트폴리오에 연결합니다.
4. 앱 설정 → 기본 설정에서 **앱 ID**와 **앱 시크릿**을 확인합니다. 앱 시크릿은
   `instagram status`가 토큰을 검사할 때 씁니다.

## 4. 시스템 사용자 토큰 발급

1. 비즈니스 설정 → 사용자 → **시스템 사용자** → 추가(관리자 또는 직원).
2. 시스템 사용자에게 자산 할당: 3번의 **앱**과 1번의 **Instagram 계정**.
3. **새 토큰 생성** → 3번 앱 선택 → 만료: **안 함** → 권한:
   `instagram_basic`, `instagram_content_publish`.
4. 생성된 토큰을 복사합니다. 이 화면을 닫으면 다시 볼 수 없습니다.

## 5. 비밀값 저장

Uncommitted는 비밀값을 이 순서로 찾습니다.

1. macOS 키체인 (account `uncommitted`)
2. `~/.uncommitted/config.json`의 `secrets` (권한 0600)

둘 다 없으면 저장 방법을 안내하고 종료 코드 2로 끝납니다.

### 키체인 (권장)

토큰을 클립보드에 복사한 뒤:

```sh
security add-generic-password -a uncommitted -s instagram-access-token -w "$(pbpaste)"
```

앱 시크릿을 복사한 뒤:

```sh
security add-generic-password -a uncommitted -s meta-app-secret -w "$(pbpaste)"
```

> **주의:** `-w` 뒤에 값을 붙이지 않고 대화형으로 입력하면 **128자에서 잘립니다.**
> 시스템 사용자 토큰은 이보다 길어서 잘린 토큰이 저장됩니다. 반드시
> `-w "$(pbpaste)"` 형태로 저장하세요. 이미 항목이 있으면 `-U`를 붙여 덮어씁니다.

키체인 항목 이름을 바꾸고 싶으면 config의 `instagram` 아래에
`accessTokenKeychainService`, `appSecretKeychainService`를 적습니다.

### config 파일 (키체인을 쓰지 않을 때)

```sh
pbpaste | uncommitted instagram connect --token-from-stdin --ig-user-id <IG 사용자 ID>
pbpaste | uncommitted instagram connect --app-secret-from-stdin
```

값은 `~/.uncommitted/config.json`에 0600 권한으로 저장됩니다. 키체인과 config
모두에 값이 있으면 키체인 값을 씁니다.

## 6. IG 사용자 ID 찾기

시스템 사용자 토큰으로는 연결된 계정 ID를 API로 알아낼 수 없습니다. 비즈니스 설정
→ 계정 → **Instagram 계정**에서 계정을 누르면 숫자 ID(`1784…`로 시작)가 보입니다.

## 7. 연결과 확인

```sh
uncommitted instagram connect --ig-user-id <IG 사용자 ID>
```

성공하면 `연결됨: @handle`이 나옵니다. config에는 IG 사용자 ID, handle, 앱 ID만
저장되고 토큰 원문은 저장되지 않습니다. 앱 ID는 토큰으로 자동 확인하고, 실패하면
`--app-id <앱 ID>`를 함께 넘깁니다.

```sh
uncommitted instagram status
```

연결된 계정, IG 사용자 ID, 토큰 상태(유효 / 만료 없음), 게시 권한 여부, 각
비밀값의 출처(`keychain` 또는 `config`)를 보여 줍니다. 비밀값 원문은 출력하지 않습니다.

```sh
uncommitted instagram disconnect
```

config의 연결 정보와 config에 저장한 비밀값을 지웁니다. 키체인 항목은 지우지 않고
지우는 명령을 안내합니다.

## 8. 게시용 이미지 임시 호스팅 (S3 호환)

Instagram API는 이미지를 공개 URL로만 받습니다. 게시할 때 이미지를 S3 호환
스토리지(Cloudflare R2, AWS S3 등)에 잠깐 올리고, 게시가 끝나면(성공이든 실패든)
지웁니다. 객체 키는 `uncommitted/<랜덤>/01.jpg` 형태로, 날짜·프로젝트명·경로를 담지 않습니다.

### 8-1. 버킷 준비 (R2 예시)

1. Cloudflare 대시보드 → R2 → 버킷을 만듭니다.
2. 버킷 설정 → 수명 주기 규칙에 "1일 후 삭제"를 넣어 둡니다(정리 실패 대비).
3. R2 → API 토큰 관리 → 이 버킷 범위의 **객체 읽기/쓰기** 토큰을 만들고 access key ID와
   secret access key를 받아 둡니다.
4. endpoint는 `https://<계정ID>.r2.cloudflarestorage.com`, region은 `auto`입니다.

### 8-2. 공개 URL 방식: presigned URL vs 공개 버킷

- **presigned URL (기본, 권장)**: 버킷은 비공개로 두고, 게시할 때 1시간 동안만 유효한
  서명된 GET URL을 Meta에 넘깁니다. 추가 설정이 필요 없습니다.
- **공개 버킷 + base URL**: 버킷에 공개 도메인(r2.dev 또는 커스텀 도메인)을 연결했다면
  `--public-base-url https://<도메인>`을 지정합니다. 이 경우 URL에 서명이 붙지 않고,
  삭제 전까지 누구나 받을 수 있습니다.

### 8-3. 키 저장과 설정

키는 5번과 같은 순서(키체인 → config 0600)로 읽습니다.

```sh
# 키체인 (권장): 각 값을 복사한 뒤
security add-generic-password -a uncommitted -s r2-access-key-id -w "$(pbpaste)"
security add-generic-password -a uncommitted -s r2-secret-access-key -w "$(pbpaste)"

uncommitted instagram host set --endpoint https://<계정ID>.r2.cloudflarestorage.com --bucket <버킷>
```

키체인을 쓰지 않으면 두 줄(access key ID, secret access key)을 stdin으로 넘겨 config(0600)에
저장합니다.

```sh
printf '%s\n%s\n' <ACCESS_KEY_ID> <SECRET_ACCESS_KEY> | uncommitted instagram host set --endpoint <...> --bucket <...> --keys-from-stdin
```

키체인 항목 이름은 `--access-key-service`, `--secret-key-service`로 바꿀 수 있습니다.

### 8-4. 확인

```sh
uncommitted instagram host status   # 설정과 키 출처(keychain/config)만 표시
uncommitted instagram host test     # 업로드 → 익명 GET → 삭제 → 삭제 확인
```

`host test`는 성공하면 `호스팅 OK` 한 줄을, 실패하면 실패한 단계와 HTTP 상태를 한 줄로 알려 줍니다.

## 9. 드래프트 게시

연결(7번)과 호스팅(8번)이 끝났으면 드래프트를 캐러셀로 게시할 수 있습니다.

```sh
uncommitted publish instagram --dry-run   # 업로드·게시 없이 검증과 미리보기만
uncommitted publish instagram             # 미리보기 → 확인(y) → 게시 → permalink 출력
uncommitted publish instagram --yes       # 확인 없이 게시 (스케줄 등 비대화형)
uncommitted publish instagram --date 2026-11-20 --revision rev-002
```

- 기본 대상은 latest 드래프트입니다. `--date`만 주면 그 날짜의 최신 리비전, `--revision`은 `--date`와 함께 씁니다.
- 게시 전에 장수, 캡션 앞부분, safety 상태, 24시간 게시 한도 사용량을 보여 줍니다.
- 캐러셀은 2~10장이어야 합니다. 1장짜리 드래프트는 게시하지 않습니다.
- safety `blocked`면 업로드 전에 거절합니다(exit 6). `warning`이면 확인 프롬프트에 경고를 함께 보여 주고, `--yes`면 경고를 출력한 뒤 진행합니다.
- 게시가 끝나면 리비전 폴더에 `publish-record.json`(`platform`, `mediaId`, `permalink`, `publishedAt`, `safetyStatus`)을 남깁니다. 이 파일이 있는 리비전은 다시 게시하지 않고 `이미 게시됨: <permalink>`를 출력합니다.
- 컨테이너 처리는 1분 간격으로 최대 5분 기다립니다.
- 게시 중에는 리비전 폴더에 `publish.lock`을 만들어 같은 리비전의 동시 게시를 막고, 끝나면 지웁니다. 강제 종료 등으로 남았다면 Instagram에서 게시 여부를 확인한 뒤 지우세요. `media_publish`가 성공하면 정리·permalink 조회 전에 `publish-record.json`을 먼저 씁니다.
- 실패하면 `게시 실패 [단계]: 메시지` 한 줄과 exit 7로 끝납니다. 업로드한 임시 이미지는 성공·실패와 관계없이 지웁니다. 토큰과 presigned URL 서명은 출력하지 않습니다.

## 10. 스케줄 자동 게시 (opt-in)

```sh
uncommitted schedule install --time 23:30 --publish instagram --publish-delay 30m
uncommitted publish skip                   # 오늘 자동 게시를 막기
```

매일 `schedule run-now`가 드래프트를 만든 뒤 safe 드래프트만 게시합니다. 지연, 건너뛰는 조건, 결과 확인은 `docs/scheduler.md`의 "Auto-publish to Instagram"을 보세요.

## 11. 점검과 재시도

```sh
uncommitted doctor                          # Instagram 항목까지 한 번에 점검
uncommitted publish instagram --retry --yes # 실패한 게시를 다시 시도
```

`doctor`는 Instagram이 연결돼 있으면 다음을 확인합니다. 토큰과 시크릿 값은 출력하지 않습니다.

- 연결: 연결된 handle
- 토큰: 유효·만료 여부와 남은 일수. 시스템 사용자 토큰은 자동 갱신이 없어서 7일 안에 만료되면 경고, 만료·무효면 실패(exit 2)로 표시하고 `uncommitted instagram connect`를 다시 하라고 안내합니다.
- 권한: `instagram_content_publish`
- 호스팅: `instagram host test`와 같은 업로드 → 공개 URL 확인 → 삭제를 실제로 한 번 합니다.
- 게시 한도: 24시간 `content_publishing_limit` 사용량

연결하지 않았다면 "연결 안 됨" 한 줄만 나오고 네트워크를 쓰지 않습니다. 스케줄 자동 게시가 켜져 있으면 `schedule status`에도 토큰 경고가 함께 나옵니다.

게시가 실패하면 리비전 폴더에 `publish-attempt.json`(실패 단계, 메시지, 시각, 캐러셀 컨테이너 ID)이 남습니다. 토큰, 시크릿, presigned URL은 넣지 않습니다.

- `--retry`는 이 기록에 24시간이 안 된 캐러셀 컨테이너가 있고 아직 쓸 수 있으면, 이미지를 다시 올리지 않고 `media_publish`만 다시 호출합니다. 컨테이너가 없거나 24시간이 지났거나 만료됐으면 처음부터 게시합니다.
- 기록된 컨테이너가 이미 게시된 상태(PUBLISHED)면 중복 게시를 막으려고 멈춥니다. Instagram에서 게시물을 확인하세요.
- 게시가 성공하면 `publish-attempt.json`을 지웁니다.

Graph API의 일시적 오류(5xx, 네트워크 끊김)는 각 단계 안에서 2초, 5초 뒤 최대 2번 다시 시도합니다. 4xx는 다시 시도하지 않고 바로 실패를 보고합니다. `media_publish`는 다시 시도하기 전에 컨테이너가 이미 게시됐는지 확인합니다.

## 문제 해결

| 메시지 | 원인과 조치 |
| --- | --- |
| 액세스 토큰이 무효이거나 취소됐습니다 | 토큰이 잘렸거나(128자 함정) 취소됐습니다. 4번에서 다시 발급해 `-w "$(pbpaste)"`로 저장하세요. |
| `instagram_content_publish` 권한이 없습니다 | 4-3에서 권한을 빠뜨렸습니다. 권한을 넣어 다시 발급하세요. |
| Instagram 계정을 찾을 수 없습니다 | IG 사용자 ID가 틀렸거나, 계정이 프로페셔널 계정이 아니거나, 시스템 사용자에 계정이 할당되지 않았습니다. |
| 토큰을 검사하지 못했습니다 | 앱 시크릿이 다른 앱의 값이거나 틀렸습니다. 3-4의 값을 다시 저장하세요. |
| 24시간 게시 한도에 도달했습니다 | Instagram API 게시 한도(24시간)를 다 썼습니다. 한도가 풀린 뒤 다시 실행하세요. |
| 게시 실패 [하위 컨테이너 처리] | Meta가 이미지를 가져오지 못했거나 거절했습니다. 함께 나온 Meta 메시지를 보고, `uncommitted instagram host test`로 호스팅부터 확인하세요. |
| 이 컨테이너는 이미 게시됐습니다 | 응답을 받기 전에 게시가 끝났습니다. Instagram에서 게시물을 확인하고, 맞다면 `publish-record.json`을 직접 남기세요. |
