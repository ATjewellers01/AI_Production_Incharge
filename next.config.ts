import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // NOT `output: 'standalone'` — deliberately. The standalone build was
  // diagnosed on 2026-09-10 as unreachable on this app's Render Docker
  // deploy (clean "live" boot, correct port, but every request silently
  // 502'd straight from Render's edge with zero backend logs). The
  // Dockerfile runs plain `next start` on this full build instead, which
  // was confirmed working end-to-end (login page + API) on the same
  // Render setup. See the Dockerfile's own comment for the full trail
  // before ever reintroducing standalone output.
};

export default nextConfig;
