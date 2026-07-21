import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CredentialAclService, type AclInspection, type CredentialAclAdapter } from '../../src/integrations/gmail/credential-acl.js';

class FakeAcl implements CredentialAclAdapter {
  readonly fixed: string[] = []; constructor(private readonly states: Map<string, AclInspection>) {}
  async inspect(path: string) { return this.states.get(path) ?? { exists: false, ownerOnly: false }; }
  async remediateOwnerOnly(path: string) { this.fixed.push(path); this.states.set(path, { exists: true, ownerOnly: true }); }
}

describe('credential ACL service', () => {
  it('inspects and remediates only the two configured temporary fictional files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acl-fictional-')); const client = join(dir, 'client.example.json'); const tokens = join(dir, 'tokens.example.json');
    await writeFile(client, '{}'); await writeFile(tokens, '{}');
    const states = new Map<string, AclInspection>([[client, { exists: true, ownerOnly: false }], [tokens, { exists: true, ownerOnly: true }]]);
    const fake = new FakeAcl(states); const service = new CredentialAclService(client, tokens, fake);
    expect(await service.inspect()).toEqual([{ label: 'oauth_client', exists: true, ownerOnly: false }, { label: 'oauth_tokens', exists: true, ownerOnly: true }]);
    await service.remediate(); expect(fake.fixed).toEqual([client]);
    expect((await service.inspect()).every((x) => x.ownerOnly)).toBe(true);
  });
  it('does not create or remediate missing files', async () => {
    const fake = new FakeAcl(new Map()); const service = new CredentialAclService('missing-client.example', 'missing-token.example', fake);
    await service.remediate(); expect(fake.fixed).toEqual([]);
  });
});
