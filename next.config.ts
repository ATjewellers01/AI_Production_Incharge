import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output so the Docker image only needs the compiled server +
  // its actually-used node_modules subset, not the whole dev tree.
  output: 'standalone',
};

export default nextConfig;
