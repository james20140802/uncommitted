import { describe, expect, it } from "vitest";
import { resolveCarouselVisualStyle } from "../src/generate-command.js";

describe("carousel visual style backward compatibility (UNC-268 / parent AC2)", () => {
  it("keeps an existing photo-first config on photo-first", () => {
    expect(resolveCarouselVisualStyle("photo-first")).toBe("photo-first");
  });

  it("keeps a config with no carouselVisualStyle key on photo-first", () => {
    expect(resolveCarouselVisualStyle(undefined)).toBe("photo-first");
  });

  it("honours an explicit story-card config", () => {
    expect(resolveCarouselVisualStyle("story-card")).toBe("story-card");
  });

  it("treats an unrecognised value as photo-first rather than throwing", () => {
    expect(resolveCarouselVisualStyle("nonsense")).toBe("photo-first");
  });
});
