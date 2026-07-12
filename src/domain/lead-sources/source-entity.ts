/**
 * Stable provider identity: a unique (provider, source Place ID) mapped to a lead.
 * The Place ID is the only Google-provided value stored permanently. This is the
 * idempotency anchor — re-collecting the same Place ID reuses the same entity.
 */
export interface NewSourceEntity {
  provider: string;
  sourcePlaceId: string;
  leadId: string;
}

export interface SourceEntity extends NewSourceEntity {
  id: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}
