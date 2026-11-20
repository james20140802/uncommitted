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

## 문제 해결

| 메시지 | 원인과 조치 |
| --- | --- |
| 액세스 토큰이 무효이거나 취소됐습니다 | 토큰이 잘렸거나(128자 함정) 취소됐습니다. 4번에서 다시 발급해 `-w "$(pbpaste)"`로 저장하세요. |
| `instagram_content_publish` 권한이 없습니다 | 4-3에서 권한을 빠뜨렸습니다. 권한을 넣어 다시 발급하세요. |
| Instagram 계정을 찾을 수 없습니다 | IG 사용자 ID가 틀렸거나, 계정이 프로페셔널 계정이 아니거나, 시스템 사용자에 계정이 할당되지 않았습니다. |
| 토큰을 검사하지 못했습니다 | 앱 시크릿이 다른 앱의 값이거나 틀렸습니다. 3-4의 값을 다시 저장하세요. |
