import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // DIAGNOSTIC (minimal-test branch): standalone output disabled here to
  // test plain `next start` instead — see Dockerfile on this branch.
  // Normally this should be `output: 'standalone'` (master branch keeps it).
};

export default nextConfig;
