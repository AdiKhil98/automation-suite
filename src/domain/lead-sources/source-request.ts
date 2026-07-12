/**
 * One row per API request/page. Cost/usage is accounted HERE (once per request),
 * never per candidate, because a single request can return many candidates. Stores
 * only permitted data: our query parameters, the field mask, page index, result
 * count, billing tier, estimated cost, status and timestamps — no provider content.
 */
export type RequestStatus = 'OK' | 'EMPTY' | 'FAILED';

export interface NewSourceRequest {
  runId: string;
  campaign: string;
  provider: string;
  query: unknown; // our request parameters only (textQuery, pageSize, pageIndex)
  fieldMask: string;
  pageIndex: number;
  resultCount: number;
  billedTier: string | null;
  estimatedCostUsd: number | null;
  status: RequestStatus;
  startedAt: Date;
  completedAt: Date | null;
}

export interface SourceRequest extends NewSourceRequest {
  id: string;
}
