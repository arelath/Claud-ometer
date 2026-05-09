import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  productionBrowserSourceMaps: true,
  serverExternalPackages: ['@anthropic-ai/tokenizer', 'tiktoken', 'node-pty'],
  outputFileTracingExcludes: {
    '*': [
      'coverage/**/*',
      'dist-electron/**/*',
      'reports/**/*',
      '.test-artifacts/**/*',
      'vendor/**/*',
      'vender/**/*',
    ],
  },
};

export default nextConfig;
