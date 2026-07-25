import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // ESM 项目，保持与源码一致的模块解析
    deps: {
      interopDefault: true
    }
  },
  resolve: {
    // 与 tsc 一致：允许 .js 扩展名映射到 .ts
    alias: {}
  }
});
