import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { CredentialAclService, NodeCredentialAclAdapter } from '../../integrations/gmail/credential-acl.js';
import { type CliContext } from '../context.js';

export async function gmailCredentialAclCommand(ctx: CliContext, opts: { fix?: boolean; by?: string }): Promise<void> {
  const service = new CredentialAclService(ctx.config.GMAIL_OAUTH_CLIENT_FILE, ctx.config.GMAIL_CREDENTIALS_FILE, new NodeCredentialAclAdapter());
  const before = await service.inspect();
  for (const item of before) console.log(`${item.label}: exists=${item.exists}; ownerOnly=${item.ownerOnly}`);
  if (!opts.fix) { console.log('Inspection only. No ACL was changed.'); return; }
  if (!opts.by?.trim() || !stdin.isTTY || !stdout.isTTY) { console.log('Operator identity and interactive TTY confirmation are required. No ACL was changed.'); return; }
  const phrase = 'FIX GMAIL CREDENTIAL ACLS'; const rl = createInterface({ input: stdin, output: stdout });
  try { if ((await rl.question(`Type exactly: ${phrase}\n> `)) !== phrase) { console.log('Confirmation did not match. No ACL was changed.'); return; }
    await service.remediate(); const after = await service.inspect();
    console.log(`ACL remediation completed by ${opts.by.trim()}.`);
    for (const item of after) console.log(`${item.label}: exists=${item.exists}; ownerOnly=${item.ownerOnly}`);
  } finally { rl.close(); }
}
