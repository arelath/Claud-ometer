import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  productionBrowserSourceMaps: true,
  serverExternalPackages: ['@anthropic-ai/tokenizer', 'tiktoken'],
};

export default nextConfig;
