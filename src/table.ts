export type Align = "left" | "right";

/**
 * Plain-text table with each column as wide as its widest cell, two spaces
 * between columns. The last column isn't padded, so lines don't end in spaces.
 */
export function formatTable(headers: string[], rows: string[][], align: Align[]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => {
        if (i === cells.length - 1) return c;
        const w = widths[i] ?? 0;
        return align[i] === "right" ? c.padStart(w) : c.padEnd(w);
      })
      .join("  ");
  return [line(headers), ...rows.map(line)];
}
