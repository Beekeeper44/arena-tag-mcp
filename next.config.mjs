/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["supertokens-node"],
  // The Tag Bot screen lives in public/tagbot.html and is served at /.
  // beforeFiles so it wins even if an old app/page.tsx is still in the repo.
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/tagbot.html" }] };
  },
  async headers() {
    return [{ source: "/tagbot.html", headers: [{ key: "Cache-Control", value: "no-store" }, { key: "X-Frame-Options", value: "DENY" }] }];
  },
};
export default nextConfig;
