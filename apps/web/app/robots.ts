import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://deadlockmeta.gg";
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/me/"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
