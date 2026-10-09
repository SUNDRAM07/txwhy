import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server in .next/standalone, so the Dockerfile ships the API without node_modules.
  // Vercel builds its own output and must not see this, so it is off whenever VERCEL is set.
  output: process.env.VERCEL ? undefined : "standalone",
};

export default nextConfig;
