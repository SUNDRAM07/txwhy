import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/tx/"] },
    sitemap: "https://txwhy.vercel.app/sitemap.xml",
  };
}
