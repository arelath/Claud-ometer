import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  productionBrowserSourceMaps: true,
  serverExternalPackages: ['@anthropic-ai/tokenizer', 'tiktoken', 'node-pty'],
};

export default nextConfig;
