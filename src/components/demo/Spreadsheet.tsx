const SS_COLS = ["", "A", "B", "C", "D", "E", "F", "G"];
const SS_HEADERS = ["", "Region", "Product", "Q1", "Q2", "Q3", "Q4", "Total"];
const SS_ROWS: string[][] = [
  ["1", "North America", "Pro Plan", "84,210", "92,450", "108,300", "121,840", "406,800"],
  ["2", "North America", "Team Plan", "42,180", "48,300", "55,720", "62,440", "208,640"],
  ["3", "North America", "Studio Plan", "12,400", "15,820", "18,640", "22,180", "69,040"],
  ["4", "Europe", "Pro Plan", "68,420", "74,180", "82,400", "94,200", "319,200"],
  ["5", "Europe", "Team Plan", "31,240", "36,840", "42,180", "48,420", "158,680"],
  ["6", "Europe", "Studio Plan", "9,840", "12,180", "14,420", "17,240", "53,680"],
  ["7", "Asia Pacific", "Pro Plan", "44,180", "52,400", "62,840", "78,200", "237,620"],
  ["8", "Asia Pacific", "Team Plan", "18,420", "22,840", "28,180", "34,420", "103,860"],
  ["9", "Asia Pacific", "Studio Plan", "5,240", "7,180", "9,420", "12,840", "34,680"],
  ["10", "Latin America", "Pro Plan", "12,180", "14,420", "17,840", "21,240", "65,680"],
];

export function Spreadsheet({ highlightCell }: { highlightCell?: { r: number; c: number } }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#1d1d1f",
        color: "#fff",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 32,
          flexShrink: 0,
          background: "linear-gradient(180deg, #2a2a2c, #232326)",
          borderBottom: "0.5px solid rgba(255,255,255,0.08)",
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          padding: "0 10px",
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#ff5f57" }} />
          <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#febc2e" }} />
          <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#28c840" }} />
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
          Q4 Sales Report — Numbers
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            color: "rgba(255,255,255,0.45)",
            fontSize: 11,
          }}
        >
          <span>Share</span>
        </div>
      </div>

      <div
        style={{
          height: 36,
          flexShrink: 0,
          background: "#222224",
          borderBottom: "0.5px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          color: "rgba(255,255,255,0.55)",
          fontSize: 11,
          fontWeight: 500,
        }}
      >
        {["Insert", "Table", "Chart", "Text", "Shape", "Media", "Comment"].map((t) => (
          <span key={t} style={{ padding: "4px 8px", borderRadius: 5 }}>
            {t}
          </span>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--accent)", fontWeight: 600 }}>SUM</span>
        <span style={{ color: "rgba(255,255,255,0.7)" }}>=SUM(D2:G2)</span>
      </div>

      <div style={{ flex: 1, overflow: "hidden", position: "relative", background: "#1d1d1f" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <thead>
            <tr>
              {SS_HEADERS.map((_, i) => (
                <th
                  key={i}
                  style={{
                    background: "#2a2a2c",
                    borderBottom: "0.5px solid rgba(255,255,255,0.10)",
                    borderRight: "0.5px solid rgba(255,255,255,0.06)",
                    padding: "6px 10px",
                    textAlign: i === 0 ? "center" : i >= 3 ? "right" : "left",
                    fontWeight: 500,
                    color: "rgba(255,255,255,0.55)",
                    fontSize: 10,
                    width: i === 0 ? 28 : "auto",
                  }}
                >
                  {i === 0 ? "" : SS_COLS[i]}
                </th>
              ))}
            </tr>
            <tr>
              {SS_HEADERS.map((h, i) => (
                <th
                  key={i}
                  style={{
                    background: "#252527",
                    borderBottom: "0.5px solid rgba(255,255,255,0.10)",
                    borderRight: "0.5px solid rgba(255,255,255,0.06)",
                    padding: "5px 10px",
                    textAlign: i === 0 ? "center" : i >= 3 ? "right" : "left",
                    fontWeight: 600,
                    color: i === 0 ? "rgba(255,255,255,0.40)" : "rgba(255,255,255,0.85)",
                    fontSize: 11,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SS_ROWS.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const isHL = highlightCell && highlightCell.r === ri && highlightCell.c === ci;
                  return (
                    <td
                      key={ci}
                      style={{
                        padding: "7px 10px",
                        borderBottom: "0.5px solid rgba(255,255,255,0.04)",
                        borderRight: "0.5px solid rgba(255,255,255,0.04)",
                        background:
                          ci === 0
                            ? "#252527"
                            : ri === 9 && ci === 7
                            ? "rgba(94,92,230,0.18)"
                            : "transparent",
                        color:
                          ci === 0
                            ? "rgba(255,255,255,0.40)"
                            : ci === 7
                            ? "#fff"
                            : "rgba(255,255,255,0.82)",
                        textAlign: ci === 0 ? "center" : ci >= 3 ? "right" : "left",
                        fontWeight: ci === 7 ? 600 : 400,
                        fontSize: 11,
                        outline: isHL ? "2px solid var(--accent)" : "none",
                        outlineOffset: isHL ? "-1px" : "0",
                      }}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td
                style={{
                  background: "#252527",
                  padding: "7px 10px",
                  textAlign: "center",
                  color: "rgba(255,255,255,0.40)",
                  borderBottom: "0.5px solid rgba(255,255,255,0.04)",
                }}
              >
                11
              </td>
              <td
                colSpan={2}
                style={{
                  padding: "7px 10px",
                  color: "rgba(255,255,255,0.95)",
                  fontWeight: 600,
                  borderBottom: "0.5px solid rgba(255,255,255,0.04)",
                  borderTop: "0.5px solid rgba(255,255,255,0.18)",
                }}
              >
                Grand Total
              </td>
              {["328,330", "376,610", "439,990", "513,060"].map((v, i) => (
                <td
                  key={i}
                  style={{
                    padding: "7px 10px",
                    textAlign: "right",
                    color: "rgba(255,255,255,0.95)",
                    fontWeight: 600,
                    borderBottom: "0.5px solid rgba(255,255,255,0.04)",
                    borderTop: "0.5px solid rgba(255,255,255,0.18)",
                  }}
                >
                  {v}
                </td>
              ))}
              <td
                style={{
                  padding: "7px 10px",
                  textAlign: "right",
                  background: "rgba(94,92,230,0.22)",
                  color: "#fff",
                  fontWeight: 700,
                  borderBottom: "0.5px solid rgba(255,255,255,0.04)",
                  borderTop: "0.5px solid rgba(255,255,255,0.18)",
                }}
              >
                1,657,990
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
