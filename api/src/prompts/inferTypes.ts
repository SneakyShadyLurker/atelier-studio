import type { TemplateConflict } from '@atelier/shared';
import type { RawInferOp } from './inferParse';
export type { RawInferOp } from './inferParse';

export interface SnapTag { idx: number; id: string; label: string; parentIdx?: number }
export interface SnapDim { idx: number; id: string; name: string; tags: SnapTag[] }
export interface SnapOption {
  idx: number;
  id: string;
  value: string;
  weight: number;
  tagIdxs: number[];
  excludeTagIdxs?: number[];
  expandedTagIdxs?: number[];
  expandedExcludeTagIdxs?: number[];
}
export interface SnapList { idx: number; id: string; name: string; options: SnapOption[] }
export interface LibrarySnapshot { dimensions: SnapDim[]; lists: SnapList[] }

export interface TagRef { dimName: string; label: string }

export interface RawBundle {
  key: string;
  ops: RawInferOp[];
  dependsOn: string[];
  // Internal proposal order, independent of dimension-centric display grouping.
  opOrder?: number[];
}
export interface StoredProposal {
  userId: string;
  rawBundles: RawBundle[];
  baseSnapshotHash: string;
  // Drift guard for template name/body edits between infer and apply/rescue.
  // `baseSnapshotHash` covers dimensions + lists only; this covers templates.
  // See librarySnapshot.ts:templatesDigest.
  baseTemplateHash: string;
  expiresAt: number;
  version: number;
  conflicts: TemplateConflict[];
  rescueAttempted: Set<string>;
  inFlightRescues: number;
}
