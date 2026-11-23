import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root. Without this, Next walks up and finds a stray
  // C:\Users\alial\package-lock.json (plus a node_modules beside it) and picks the HOME
  // directory as the root. Turbopack then computes its .next/dev/node_modules junction
  // targets through a traversal back down to this project, and junction creation fails with
  // "os error 80: The file exists" — which 500s every route that imports @prisma/client or
  // pg, while static pages still render. Pinning the root keeps those paths local.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
