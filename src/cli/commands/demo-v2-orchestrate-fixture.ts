import { readFile } from 'node:fs/promises';
import { parseComponentRegistry } from '../../domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../domain/demo-v2/manifests/reference-library.js';
import { orchestrateDemoV2Fixture } from '../../domain/demo-v2/orchestration-service.js';
import {
  DEMO_V2_FIXTURE_NAMES,
  demoV2Fixture,
  type DemoV2FixtureName,
} from '../../fixtures/demo-v2-orchestration.js';

export async function demoV2OrchestrationFixtureCommand(opts: {
  fixture: string;
  stage?: string;
}): Promise<void> {
  if (!DEMO_V2_FIXTURE_NAMES.includes(opts.fixture as DemoV2FixtureName)) {
    throw new Error(`unknown_demo_v2_fixture:${opts.fixture}`);
  }
  const component = parseComponentRegistry(JSON.parse(await readFile(
    './design-library/component-registry.v1.json', 'utf8',
  )) as unknown);
  const reference = parseReferenceLibrary(JSON.parse(await readFile(
    './design-library/reference-library.v1.json', 'utf8',
  )) as unknown);
  const fixture = demoV2Fixture(opts.fixture as DemoV2FixtureName, {
    componentVersion: component.manifest.version,
    componentHash: component.hash,
    referenceVersion: reference.manifest.version,
    referenceHash: reference.hash,
  });
  const output = await orchestrateDemoV2Fixture(fixture);
  const stage = opts.stage ?? 'report';
  const selected: Record<string, unknown> = {
    intelligence: output.intelligence,
    content: output.content,
    translation: output.translation,
    assets: { candidates: output.assets, selections: output.selections },
    brief: output.creativeBrief,
    plan: output.experiencePlan,
    report: output.report,
  };
  if (!(stage in selected)) throw new Error(`unknown_demo_v2_stage:${stage}`);
  process.stdout.write(`${JSON.stringify(selected[stage], null, 2)}\n`);
}
