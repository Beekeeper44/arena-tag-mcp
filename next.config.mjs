/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["supertokens-node"],
  // The Tag Bot screen lives in public/tagbot.html and is served at /
  async rewrites() {
    return [{ source: "/", destination: "/tagbot.html" }];
  },
  async headers() {
    return [{ source: "/tagbot.html", headers: [{ key: "Cache-Control", value: "no-store" }, { key: "X-Frame-Options", value: "DENY" }] }];
  },
};
export default nextConfig;
