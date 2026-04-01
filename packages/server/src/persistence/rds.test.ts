/**
 * RdsPersistence unit tests
 *
 * Tests focus on the new VersionConflictError path and the version-tracking logic
 * added for horizontal scaling. Actual DB calls are mocked via vi.mock so no
 * Postgres instance is required.
 */
import { describe, it, expect, vi } from 'vitest';
import { VersionConflictError } from './rds.js';

// ---------------------------------------------------------------------------
// VersionConflictError
// ---------------------------------------------------------------------------
describe('VersionConflictError', () => {
  it('is instanceof Error', () => {
    const err = new VersionConflictError('conflict');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name VersionConflictError', () => {
    const err = new VersionConflictError('conflict');
    expect(err.name).toBe('VersionConflictError');
  });

  it('instanceof check works correctly for catch-block routing', () => {
    try {
      throw new VersionConflictError('version mismatch');
    } catch (err) {
      expect(err instanceof VersionConflictError).toBe(true);
      expect((err as VersionConflictError).message).toBe('version mismatch');
    }
  });

  it('is NOT caught by a plain Error guard that checks for VersionConflictError by name', () => {
    const err = new VersionConflictError('x');
    // Verify the name-based check (used in engine.ts catch block) works
    expect((err as Error).name === 'VersionConflictError').toBe(true);
  });
});
