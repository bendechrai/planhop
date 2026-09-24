import { describe, expect, it } from "vitest";
import { formatTable } from "../src/table.js";

describe("formatTable", () => {
  it("sizes columns to the longest cell so long account names stay aligned", () => {
    const lines = formatTable(
      ["", "account", "5h used", "login"],
      [["->", "claude2.dechrai.com", "0%", "claude2@dechrai.com"], ["", "a", "100%", "a@example.com"]],
      ["left", "left", "right", "left"],
    );
    expect(lines).toEqual([
      "    account              5h used  login",
      "->  claude2.dechrai.com       0%  claude2@dechrai.com",
      "    a" + " ".repeat(23) + "100%  a@example.com",
    ]);
  });
});
