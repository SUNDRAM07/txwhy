import { ImageResponse } from "next/og";
import { getTrace } from "@/lib/trace";

export const alt = "TxWhy diagnosis of a Solana transaction";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Link preview: shows the actual failure, so a pasted TxWhy link explains itself in the chat. */
export default async function Image({ params }: { params: Promise<{ signature: string }> }) {
  const { signature } = await params;
  let title = "Solana transaction";
  let detail = "See the exact failing step and get back a transaction that works.";
  let failed = true;
  let where = "";
  try {
    const trace = await getTrace(signature);
    if (trace) {
      failed = !trace.success;
      title = trace.success ? "Transaction succeeded" : (trace.error?.title ?? "Transaction failed");
      if (trace.error?.cause) detail = trace.error.cause;
      const path: string[] = [];
      const walk = (nodes: typeof trace.tree) => {
        for (const n of nodes) {
          if (n.failed) {
            path.push(n.programName);
            walk(n.children);
          }
        }
      };
      walk(trace.tree);
      if (path.length > 0) where = `Failed in ${path[path.length - 1]}`;
    }
  } catch {
    /* fall back to the generic card */
  }
  if (detail.length > 170) detail = `${detail.slice(0, 167)}…`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0a0a0a",
          color: "#fafafa",
          padding: 64,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700 }}>
            <span>Tx</span>
            <span style={{ color: "#10b981" }}>Why</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 24,
              fontWeight: 700,
              padding: "6px 18px",
              borderRadius: 999,
              background: failed ? "rgba(239,68,68,0.18)" : "rgba(16,185,129,0.18)",
              color: failed ? "#f87171" : "#34d399",
            }}
          >
            {failed ? "FAILED" : "SUCCESS"}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", fontSize: 68, fontWeight: 800, lineHeight: 1.05, color: failed ? "#f87171" : "#34d399" }}>
            {title.length > 44 ? `${title.slice(0, 42)}…` : title}
          </div>
          {where ? <div style={{ display: "flex", fontSize: 30, color: "#a3a3a3" }}>{where}</div> : null}
          <div style={{ display: "flex", fontSize: 30, lineHeight: 1.35, color: "#d4d4d4" }}>{detail}</div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#737373" }}>
          <span>{`${signature.slice(0, 14)}…${signature.slice(-8)}`}</span>
          <span style={{ color: "#10b981" }}>Failed transaction in. Working transaction out.</span>
        </div>
      </div>
    ),
    size,
  );
}
