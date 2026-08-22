/**
 * 캐러셀 한 장의 출력 규격. story-card(Playwright)와 photo-first(AI 자산)가
 * **같은 값**을 써야 한다는 것이 부모 AC5의 결정이다 — 1080x1350은
 * 인스타그램 권장 4:5 해상도다.
 *
 * 두 경로가 각자 상수를 들고 있다가 어긋난 것이 UNC-267의 원인이었다
 * (story-card 1080x1350 vs photo-first 1024x1280). 상수원은 여기 하나다.
 */
export const CAROUSEL_WIDTH = 1080;
export const CAROUSEL_HEIGHT = 1350;
