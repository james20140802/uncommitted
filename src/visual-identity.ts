// 계정 고유의 알아볼 수 있는 룩을 여러 날에 걸쳐 일관되게 유지하기 위한
// 정적 art-direction 아이덴티티 레이어. 무드/소재 변주는 이 룩 "안에서"만 일어난다.
export type VisualIdentityLayer = {
  palette: string;
  composition: string;
  materialGrammar: string;
};

export const VISUAL_IDENTITY: VisualIdentityLayer = {
  palette:
    "muted analog-film palette: warm paper-white base, desaturated teal, soft amber accents, low contrast",
  composition:
    "single off-center focal object, generous negative space, eye-level or gentle top-down framing, calm balance",
  materialGrammar:
    "matte tactile surfaces, natural window light, fine grain, desk materials of paper, ceramic, brushed metal, warm wood"
};

export function visualIdentityPromptLines(): string[] {
  return [
    `Consistent account visual identity — keep this look across every image.`,
    `Palette: ${VISUAL_IDENTITY.palette}.`,
    `Composition: ${VISUAL_IDENTITY.composition}.`,
    `Materials: ${VISUAL_IDENTITY.materialGrammar}.`
  ];
}
