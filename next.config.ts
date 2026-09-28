import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces the standalone `server.js` artifact the Railway/Docker path uses.
  // Vercel ignores `output` and builds with the framework preset, so this is
  // inert there rather than a second deployment story to maintain.
  output: process.env.VERCEL ? undefined : "standalone",

  // Lets two dev servers run side by side without clobbering each other's
  // build output. Defaults to `.next` when unset.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["gsap"],
  },
  // OpenTelemetry's Node loader does a dynamic `require` that webpack cannot
  // statically analyse. It is third-party noise pulled in by @sentry/nextjs and
  // does not affect correctness.
  webpack(config) {
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { message: /Critical dependency: the request of a dependency is an expression/ },
    ];
    return config;
  },
};

export default nextConfig;
