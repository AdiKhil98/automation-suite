import { afterEach, describe, expect, it, vi } from 'vitest';
import { setContactTimezoneCommand } from '../../src/cli/commands/set-contact-timezone.js';
import { type CliContext } from '../../src/cli/context.js';
import { AppError } from '../../src/utils/errors.js';

const LEAD = 'lead-tz-fixture-1';

function fakeCtx(): { ctx: CliContext; tx: ReturnType<typeof vi.fn>; getById: ReturnType<typeof vi.fn> } {
  const tx = vi.fn(async () => { /* spy: write path not executed */ });
  const getById = vi.fn(async () => ({ id: LEAD, status: 'DRAFT_CREATED' }));
  const ctx = { leads: { getById }, db: { transaction: tx } } as unknown as CliContext;
  return { ctx, tx, getById };
}

const base = { lead: LEAD, timezone: 'Europe/London', sourceType: 'manual', sourceUrl: 'operator: manual entry' };

afterEach(() => { process.exitCode = 0; });

describe('set-contact-timezone command', () => {
  it('requires lead, timezone, source-type, and source-url', async () => {
    const { ctx } = fakeCtx();
    await expect(setContactTimezoneCommand(ctx, { ...base, lead: undefined })).rejects.toBeInstanceOf(AppError);
    await expect(setContactTimezoneCommand(ctx, { ...base, timezone: undefined })).rejects.toBeInstanceOf(AppError);
    await expect(setContactTimezoneCommand(ctx, { ...base, sourceType: undefined })).rejects.toBeInstanceOf(AppError);
    await expect(setContactTimezoneCommand(ctx, { ...base, sourceUrl: undefined })).rejects.toBeInstanceOf(AppError);
  });

  it('rejects an invalid provenance source-type', async () => {
    const { ctx } = fakeCtx();
    await expect(setContactTimezoneCommand(ctx, { ...base, sourceType: 'guessed' })).rejects.toBeInstanceOf(AppError);
  });

  it('refuses an invalid IANA timezone and writes nothing', async () => {
    const { ctx, tx } = fakeCtx();
    await setContactTimezoneCommand(ctx, { ...base, timezone: 'Europe/Croydon' });
    expect(process.exitCode).toBe(1);
    expect(tx).not.toHaveBeenCalled();
  });

  it('dry-previews by default — a valid timezone writes nothing without --confirm', async () => {
    const { ctx, tx } = fakeCtx();
    await setContactTimezoneCommand(ctx, { ...base });
    expect(tx).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('persists (enters the transaction) only with --confirm on a valid IANA zone', async () => {
    const { ctx, tx, getById } = fakeCtx();
    await setContactTimezoneCommand(ctx, { ...base, confirm: true });
    expect(getById).toHaveBeenCalledWith(LEAD);
    expect(tx).toHaveBeenCalledTimes(1);
  });
});
