import { describe, it, expect } from "vitest";

function parseThreshold(text: string) {
  const s = (text || "").toLowerCase();
  let digits = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch >= "0" && ch <= "9") digits += ch;
    else if (digits.length) break;
  }
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return 100000;
  if (s.includes("k")) return n * 1000;
  if (n >= 200 && n <= 999) return n * 1000;
  return n;
}

describe("parseThreshold", () => {
  it("parses $200k", () => expect(parseThreshold("$200k")).toBe(200000));
  it("treats 200 as shorthand for 200k", () => expect(parseThreshold("200")).toBe(200000));
  it("parses 150000 as-is", () => expect(parseThreshold("150000")).toBe(150000));
  it("defaults to 100000 for invalid", () => expect(parseThreshold("n/a")).toBe(100000));
  it("parses 'over 75k' as 75000", () => expect(parseThreshold("over 75k")).toBe(75000));
});
