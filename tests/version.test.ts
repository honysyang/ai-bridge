import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { getAppVersion } from '../src/lib/version.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

describe('version', () => {
  it('getAppVersion 返回 package.json 中的版本号', () => {
    expect(getAppVersion()).toBe(pkg.version);
    expect(getAppVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('README 中的版本号与 package.json 一致', () => {
    const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf-8');
    expect(readme).toContain(`v${pkg.version}`);
  });
});
