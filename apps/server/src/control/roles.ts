/** Role permission matrix (Doc 01 §4.3.1). */
import { SyncraError } from '@syncra/shared';

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

export type Capability =
  | 'docs.write'
  | 'keys.manage'
  | 'keys.manage-secret'
  | 'webhooks.manage'
  | 'members.manage'
  | 'billing.manage'
  | 'tenant.delete'
  | 'audit.read';

const MATRIX: Record<Capability, readonly Role[]> = {
  'docs.write': ['owner', 'admin', 'developer'],
  'keys.manage': ['owner', 'admin', 'developer'], // developers: publishable keys only
  'keys.manage-secret': ['owner', 'admin'],
  'webhooks.manage': ['owner', 'admin', 'developer'],
  'members.manage': ['owner', 'admin'],
  'billing.manage': ['owner'],
  'tenant.delete': ['owner'],
  'audit.read': ['owner', 'admin'],
};

export const can = (role: Role, cap: Capability): boolean => MATRIX[cap].includes(role);

export function requireCan(role: Role, cap: Capability): void {
  if (!can(role, cap)) throw new SyncraError('FORBIDDEN', 'Your role does not allow this action');
}
