import { execFile } from 'node:child_process';
import { access, chmod, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
export interface AclInspection { exists: boolean; ownerOnly: boolean }
export interface CredentialAclAdapter { inspect(path: string): Promise<AclInspection>; remediateOwnerOnly(path: string): Promise<void> }

/** OS ACL adapter. It reads permissions only; remediation must be gated by the caller. */
export class NodeCredentialAclAdapter implements CredentialAclAdapter {
  async inspect(path: string): Promise<AclInspection> {
    try { await access(path); } catch { return { exists: false, ownerOnly: false }; }
    if (process.platform !== 'win32') { const info = await stat(path); return { exists: true, ownerOnly: (info.mode & 0o077) === 0 }; }
    const script = "$a=Get-Acl -LiteralPath $args[0];$owner=$a.Owner;$other=@($a.Access|Where-Object{$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $owner});[pscustomobject]@{exists=$true;ownerOnly=($other.Count -eq 0)}|ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, path], { windowsHide: true });
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== 'object' || !('ownerOnly' in parsed) || typeof (parsed as { ownerOnly?: unknown }).ownerOnly !== 'boolean') throw new Error('credential_acl_inspection_invalid');
    return { exists: true, ownerOnly: (parsed as { ownerOnly: boolean }).ownerOnly };
  }

  async remediateOwnerOnly(path: string): Promise<void> {
    if (process.platform !== 'win32') { await chmod(path, 0o600); return; }
    const script = "$a=Get-Acl -LiteralPath $args[0];$owner=$a.Owner;$a.SetAccessRuleProtection($true,$false);@($a.Access)|ForEach-Object{[void]$a.RemoveAccessRuleAll($_)};$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($owner,'FullControl','Allow');$a.AddAccessRule($rule);Set-Acl -LiteralPath $args[0] -AclObject $a";
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, path], { windowsHide: true });
  }
}

export interface CredentialAclTarget { label: 'oauth_client' | 'oauth_tokens'; path: string }
export class CredentialAclService {
  readonly targets: CredentialAclTarget[];
  constructor(clientFile: string, tokenFile: string, private readonly adapter: CredentialAclAdapter) {
    this.targets = [{ label: 'oauth_client', path: resolve(clientFile) }, { label: 'oauth_tokens', path: resolve(tokenFile) }];
  }
  async inspect(): Promise<Array<{ label: CredentialAclTarget['label']; exists: boolean; ownerOnly: boolean }>> {
    return Promise.all(this.targets.map(async (target) => ({ label: target.label, ...await this.adapter.inspect(target.path) })));
  }
  async remediate(): Promise<void> {
    for (const target of this.targets) { const state = await this.adapter.inspect(target.path); if (state.exists && !state.ownerOnly) await this.adapter.remediateOwnerOnly(target.path); }
  }
}
