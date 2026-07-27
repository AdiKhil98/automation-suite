import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Logger } from 'pino';
import { type AppConfig } from '../../config/env.js';
import {
  buildEvidenceExport,
  countBySourceType,
} from '../../domain/ku64-export/evidence-export.js';
import { resolveEvidenceOutputPath } from '../../domain/ku64-export/output-path.js';
import { Ku64ExportError } from '../../domain/ku64-export/types.js';
import {
  Ku64ExportReadRepository,
  createReadOnlyDb,
} from '../../persistence/ku64-export-read.js';

export interface Ku64ExportEvidenceOptions {
  readonly leadId?: string;
  readonly expectedDomain?: string;
  readonly confirmProductionRead?: boolean;
}

/**
 * Phase 3C-A — guarded, read-only KU64 evidence export.
 *
 * Fails closed before opening any connection unless BOTH the explicit
 * `--confirm-production-read` flag and `ALLOW_PRODUCTION_READ_EXPORT=true` are
 * present. Opens a session-level read-only pool over DATABASE_URL, loads exactly
 * one lead's redacted evidence, verifies the ku64.de binding, and writes a
 * deterministic JSON snapshot into .local-data/ku64-v2/evidence.json.
 *
 * It performs zero writes and never renders, deploys, drafts, schedules, or sends.
 */
export async function ku64ExportEvidenceCommand(
  config: AppConfig,
  logger: Logger,
  opts: Ku64ExportEvidenceOptions,
): Promise<void> {
  // --- Fail-closed gates (checked before any connection is opened). ---
  if (opts.confirmProductionRead !== true) {
    throw new Ku64ExportError('confirmation_required', 'refusing to run without --confirm-production-read');
  }
  if (config.ALLOW_PRODUCTION_READ_EXPORT !== true) {
    throw new Ku64ExportError('flag_disabled', 'refusing to run without ALLOW_PRODUCTION_READ_EXPORT=true');
  }
  const leadId = opts.leadId?.trim();
  if (!leadId) {
    throw new Ku64ExportError('lead_id_required', '--lead-id is required');
  }
  const expectedDomain = opts.expectedDomain?.trim();
  if (!expectedDomain) {
    throw new Ku64ExportError('expected_domain_required', '--expected-domain is required');
  }

  const repoRoot = process.cwd();
  // Resolve + assert the output path up front so a bad target fails before any read.
  const outputPath = resolveEvidenceOutputPath(repoRoot);

  logger.info(
    { leadId, expectedDomain, outputPath: path.relative(repoRoot, outputPath) },
    'ku64-v2-export-evidence: starting guarded read-only export',
  );

  const { db, pool } = createReadOnlyDb(config.DATABASE_URL);
  const repo = new Ku64ExportReadRepository(db);

  try {
    const raw = await repo.loadLeadExportData(leadId);
    const exportDoc = buildEvidenceExport(raw, {
      expectedDomain,
      confirmProductionRead: true,
      exportedAt: new Date().toISOString(),
    });

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(exportDoc, null, 2)}\n`, { mode: 0o600 });

    const counts = countBySourceType(exportDoc);
    logger.info(
      {
        leadId: exportDoc.leadId,
        normalizedDomain: exportDoc.normalizedDomain,
        recordCount: exportDoc.recordCount,
        recordsSha256: exportDoc.recordsSha256,
        counts,
      },
      'ku64-v2-export-evidence: export written (zero database writes)',
    );

    console.log('KU64 evidence export complete (read-only; zero database writes).');
    console.log(`  lead id:            ${exportDoc.leadId}`);
    console.log(`  normalized domain:  ${exportDoc.normalizedDomain}`);
    console.log(`  schema version:     ${exportDoc.schemaVersion}`);
    console.log(`  output path:        ${path.relative(repoRoot, outputPath)}`);
    console.log(`  records:            ${exportDoc.recordCount}`);
    console.log(`  records sha256:     ${exportDoc.recordsSha256}`);
    console.log('  records by type:');
    for (const key of Object.keys(counts).sort()) {
      console.log(`    ${key.padEnd(22)} ${counts[key]}`);
    }
  } finally {
    await pool.end();
  }
}
