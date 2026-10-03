/**
 * Release evidence for private writes. A feature is live-validated only when
 * this registry references an accompanying, checksummed validation artifact.
 * No current feature has that evidence. Mock and copy-store tests alone must
 * never populate this registry: the record must cover the dirty-editor,
 * replica-identity and second-device upload experiments required by #262.
 */
export const WRITER_VALIDATION_FEATURES = [
  "APPEND",
  "EDIT",
  "COMPOSE",
  "CHECKLIST",
  "HIGHLIGHT",
  "LINK_CARD",
  "PARAGRAPH_IDS",
  "SECTION_LINKS",
  "TABLES",
  "SMART_FOLDERS",
  "PAPER",
  "PURGE_REPAIR",
  "SYNC_PUSH",
] as const;
export type WriterValidationFeature = (typeof WRITER_VALIDATION_FEATURES)[number];

export interface WriterValidationRecord {
  /** Repository-relative Markdown artifact containing the actual observations. */
  artifact: string;
  /** SHA-256 of the artifact, pinned so edits require another evidence review. */
  artifactSha256: string;
  /** SHA-256 of the native writer source that the evidence covers. */
  writerSourceSha256: string;
  /** ISO date of the completed trials. */
  validatedAt: string;
}

/** Adding evidence is the only supported way to enable a *_LIVE_VALIDATED flag. */
export const WRITER_VALIDATION_RECORDS: Readonly<
  Record<WriterValidationFeature, WriterValidationRecord | null>
> = {
  APPEND: null,
  EDIT: null,
  COMPOSE: null,
  CHECKLIST: null,
  HIGHLIGHT: null,
  LINK_CARD: null,
  PARAGRAPH_IDS: null,
  SECTION_LINKS: null,
  TABLES: null,
  SMART_FOLDERS: null,
  PAPER: null,
  PURGE_REPAIR: null,
  SYNC_PUSH: null,
};

/** False unless the release supplies a named, versioned evidence artifact. */
export function writerFeatureIsValidated(
  feature: WriterValidationFeature,
  records: Readonly<
    Record<WriterValidationFeature, WriterValidationRecord | null>
  > = WRITER_VALIDATION_RECORDS
): boolean {
  const record = records[feature];
  return (
    record != null &&
    /^docs\/private-writer-validation\/[a-z0-9-]+\.md$/.test(record.artifact) &&
    /^[a-f0-9]{64}$/.test(record.artifactSha256) &&
    /^[a-f0-9]{64}$/.test(record.writerSourceSha256) &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.validatedAt)
  );
}

/** Tool and status keys share the same explicit feature opt-in. */
export const WRITER_VALIDATION_KEYS: Readonly<Record<string, WriterValidationFeature>> = {
  "native-append-plain-text": "APPEND",
  appendPlainText: "APPEND",
  "native-edit-note": "EDIT",
  editNote: "EDIT",
  editReplaceFile: "EDIT",
  "compose-note": "COMPOSE",
  composeNote: "COMPOSE",
  composeObjects: "COMPOSE",
  composeAttachments: "COMPOSE",
  "native-set-checklist-item": "CHECKLIST",
  checklistToggle: "CHECKLIST",
  "native-highlight-text": "HIGHLIGHT",
  highlight: "HIGHLIGHT",
  "native-add-url-card": "LINK_CARD",
  linkCard: "LINK_CARD",
  "native-set-paragraph-id": "PARAGRAPH_IDS",
  setParagraphId: "PARAGRAPH_IDS",
  "native-add-section-link": "SECTION_LINKS",
  addSectionLink: "SECTION_LINKS",
  "native-delete-table-row": "TABLES",
  "native-insert-table-row": "TABLES",
  "native-set-table-cell": "TABLES",
  "native-prune-orphan-table": "TABLES",
  editTables: "TABLES",
  pruneOrphanTable: "TABLES",
  "native-create-smart-folder": "SMART_FOLDERS",
  "native-update-smart-folder": "SMART_FOLDERS",
  "native-delete-smart-folder": "SMART_FOLDERS",
  editSmartFolders: "SMART_FOLDERS",
  "native-add-paper": "PAPER",
  addPaper: "PAPER",
  "native-repair-purge-flag": "PURGE_REPAIR",
  purgeRepair: "PURGE_REPAIR",
  "native-sync-push": "SYNC_PUSH",
};

/** A blanket native-operation opt-in deliberately never enables the writer. */
export function writerUnverifiedEnv(toolOrFeature: string): string | undefined {
  const feature = Object.hasOwn(WRITER_VALIDATION_KEYS, toolOrFeature)
    ? WRITER_VALIDATION_KEYS[toolOrFeature]
    : undefined;
  return feature ? `APPLE_NOTES_MCP_ALLOW_UNVERIFIED_${feature}` : undefined;
}
