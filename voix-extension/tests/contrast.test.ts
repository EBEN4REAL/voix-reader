import { describe, expect, it } from "vitest";

// WCAG 2.x contrast for the text/background pairs the widget actually uses.

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const PAIRS: [string, string, string][] = [
  ["ink on accent (primary button)", "#062A3D", "#00BFFF"],
  ["ink on surface", "#062A3D", "#FFFFFF"],
  ["muted on surface", "#4A6578", "#FFFFFF"],
  ["link on surface", "#0A5F8E", "#FFFFFF"],
  ["link on tint (chip, notice)", "#0A5F8E", "#E8F8FF"],
  ["muted on tint (notice body)", "#4A6578", "#E8F8FF"],
  ["ink on highlight (current sentence)", "#062A3D", "#CDEFFF"],
  ["muted on list background (read sentences)", "#4A6578", "#F7FBFD"],
  ["error text on error notice", "#A61B1B", "#FFF1F0"],
];

describe("colour contrast", () => {
  it.each(PAIRS)("%s is at least 4.5:1", (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("confirms white on sky blue fails (so it is never used for text)", () => {
    expect(contrast("#FFFFFF", "#00BFFF")).toBeLessThan(4.5);
  });
});
