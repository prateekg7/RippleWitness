import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';
describe('scaffold smoke', () => { it('core package resolves', () => { expect(PACKAGE_NAME).toBe('@ripplewitness/core'); }); });
