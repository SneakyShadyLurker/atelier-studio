// Canonical regex for a user identity. Lives at the top level because both
// `auth/authelia.ts` (validates inbound Remote-User) and deeper layers
// (`storage/files.ts` path segments, `db/migrate.ts` pre-migration audit)
// need to apply the same rule without a layer inversion through `auth/`.
//
// First character forbids leading `.` so the bare strings `.` and `..` (path
// traversal segments) can never satisfy the pattern. Trailing range allows
// `.` only after a valid lead char, so `..foo` would also fail. Length cap
// 256 bounds artifact-path width and log-line size.
export const USER_ID_PATTERN = /^[A-Za-z0-9_@-][A-Za-z0-9_.@-]{0,255}$/;
