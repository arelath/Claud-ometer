import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  productionBrowserSourceMaps: true,
  serverExternalPackages: ['@anthropic-ai/tokenizer', 'tiktoken'],
};

export default nextConfig;
