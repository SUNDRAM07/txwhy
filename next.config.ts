import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server in .next/standalone, so the Dockerfile ships the API without node_modules.
  output: "standalone",
};

export default nextConfig;
