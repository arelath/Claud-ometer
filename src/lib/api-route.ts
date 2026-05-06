import { NextResponse } from 'next/server';

export class ApiRouteError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ApiRouteError';
    this.status = status;
  }
}

export function apiError(message: string, status = 400): never {
  throw new ApiRouteError(message, status);
}

export function withErrorHandler<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Response | Promise<Response>,
  context: string,
  fallbackMessage: string,
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApiRouteError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }

      console.error(`${context}:`, error);
      return NextResponse.json({ error: fallbackMessage }, { status: 500 });
    }
  };
}
