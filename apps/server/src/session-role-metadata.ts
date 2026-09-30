import { SessionRole, ToolScope } from '@cockpit/protocol';
import { z } from 'zod';

const roles = SessionRole.strict().array().max(64);
export const SessionRoleMetadata = z.union([
  roles,
  z.object({ roles, toolScope: ToolScope }).strict(),
]);
export type SessionRoleMetadata = z.infer<typeof SessionRoleMetadata>;
export const metadataRoles = (value: SessionRoleMetadata) => Array.isArray(value) ? value : value.roles;
