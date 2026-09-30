import type { MetadataRoute } from "next";
import { listCodes, listPrograms } from "@/lib/catalog";

const BASE = "https://txwhy.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ["", "/repair", "/errors", "/failures", "/stats", "/llms.txt", "/skill.md", "/openapi.json"].map((path) => ({
    url: `${BASE}${path}`,
    changeFrequency: "daily" as const,
    priority: path === "" ? 1 : 0.8,
  }));
  const programs = listPrograms().map((p) => ({ url: `${BASE}/errors/${p.slug}`, changeFrequency: "monthly" as const, priority: 0.6 }));
  const errors = listPrograms().flatMap((p) =>
    p.errors.map((e) => ({ url: `${BASE}/errors/${p.slug}/${e.code}`, changeFrequency: "monthly" as const, priority: 0.5 })),
  );
  const codes = listCodes().map((c) => ({ url: `${BASE}/errors/code/0x${c.toString(16)}`, changeFrequency: "monthly" as const, priority: 0.6 }));
  return [...pages, ...programs, ...codes, ...errors];
}
