import { describe, expect, it, vi } from 'vitest';
import { ApiRouteError, apiError, withErrorHandler } from '@/lib/api-route';

describe('api route helpers', () => {
  it('throws typed route errors with the provided status', () => {
    expect(() => apiError('Missing id', 422)).toThrow(ApiRouteError);

    try {
      apiError('Missing id', 422);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      expect((error as ApiRouteError).message).toBe('Missing id');
      expect((error as ApiRouteError).status).toBe(422);
    }
  });

  it('returns handler responses unchanged', async () => {
    const response = new Response('ok', { status: 201 });
    const wrapped = withErrorHandler(() => response, 'creating thing', 'failed');

    await expect(wrapped()).resolves.toBe(response);
  });

  it('serializes expected API errors without logging', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapped = withErrorHandler(() => apiError('Bad input', 409), 'updating thing', 'failed');

    const response = await wrapped();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Bad input' });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('logs unexpected errors and returns the fallback message', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapped = withErrorHandler(() => {
      throw new Error('database is unavailable');
    }, 'loading stats', 'Unable to load stats');

    const response = await wrapped();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Unable to load stats' });
    expect(consoleSpy).toHaveBeenCalledWith('loading stats:', expect.any(Error));
  });
});
