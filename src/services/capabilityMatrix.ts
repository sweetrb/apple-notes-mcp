/**
 * OS-version-aware feature matrix for `get-capabilities` and `doctor`.
 *
 * Each feature group the server offers is one entry in {@link FEATURES}. A
 * feature declares the macOS floor it needs and the requirements it depends on;
 * {@link evaluateFeatures} turns those declarations plus one probe of the
 * runtime into `available`, `osSupported`, `minimumMacOSVersion`,
 * `requirements`, `missing`, `unverified`, and a machine-readable `reason`.
 *
 * Adding a feature is one new object in {@link FEATURES}; nothing else changes.
 *
 * The probe is deliberately cheap and side-effect free: `sw_vers` for the macOS
 * version, one `SELECT 1` against the Notes database for Full Disk Access, and
 * one `shortcuts list` for every bridge. It never opens Notes.app, never sends
 * Notes an Apple event, never runs a Shortcut, and never mutates anything. The
 * public helper gets only bounded `hello` / `speech_status` calls. Automation
 * permission, Shortcut first-run consent, and per-language speech assets stay
 * `unverified` instead of being guessed at or triggering a prompt/download.
 * `doctor` and `health-check` confirm Automation by contacting Notes.
 *
 * @module services/capabilityMatrix
 */
import { execFileSync } from "node:child_process";
import { release } from "node:os";
import { hasFullDiskAccess } from "../utils/checklistParser.js";
import { listInstalledShortcuts, nativeTagsShortcutName, resolveShortcut } from "./nativeTags.js";
import { backgroundShortcutName, markdownShortcutName } from "./backgroundNotes.js";
import {
  probePublicHelperStatus,
  unprobedPublicHelperStatus,
  type PublicHelperStatus,
} from "./publicHelperStatus.js";

/**
 * A requirement a feature can declare. `shortcut` requirements are resolved by
 * name at probe time, so environment-variable overrides are honored.
 */
export type Requirement =
  | { kind: "notes_automation" }
  | { kind: "full_disk_access" }
  | { kind: "shortcuts_cli" }
  | { kind: "shortcut"; name: () => string }
  /** Installation does not reveal whether the user answered first-run consent. */
  | { kind: "shortcut_consent" }
  | { kind: "public_native_helper" }
  | { kind: "speech_recognition" }
  /** Locale/model readiness is only known for an actual transcription request. */
  | { kind: "speech_locale_and_assets" }
  /**
   * A native helper that can WRITE to Notes. None ships: the opt-in private
   * helper (native-helper-status) is read-only, and write support was
   * deliberately deferred by the maintainer (#181, #204). Always unmet.
   */
  | { kind: "native_write_helper" };

/**
 * Machine-readable reasons, in the order they are checked. `reason` is the
 * first one that applies, or `null` when the feature is available.
 *
 * - `unsupported_platform`: not running on macOS.
 * - `not_implemented`: the server has no implementation for this feature yet (every feature
 *   that needs a native write helper; the opt-in private helper is read-only).
 * - `unknown_os_version`: the feature has a macOS floor and the version could not be read.
 * - `requires_macos_<major>`: the running macOS is older than the feature's floor.
 * - `full_disk_access_missing`: the Notes database is not readable by this process.
 * - `shortcuts_unavailable`: the `shortcuts` command could not be run.
 * - `shortcut_not_installed`: a bridge Shortcut is missing or installed more than once.
 * - `public_helper_unavailable`: installed helper integrity or handshake failed.
 * - `public_helper_unverified`: helper readiness was not inspected.
 * - `speech_permission_required`: the speech route needs access or has an explicit refusal.
 * - `speech_status_unverified`: the non-prompting speech status probe did not succeed.
 */
export type CapabilityReason =
  | "unsupported_platform"
  | "not_implemented"
  | "unknown_os_version"
  | `requires_macos_${number}`
  | "full_disk_access_missing"
  | "shortcuts_unavailable"
  | "shortcut_not_installed"
  | "public_helper_unavailable"
  | "public_helper_unverified"
  | "speech_permission_required"
  | "speech_status_unverified";

/** One feature group. Register a new feature by adding one of these to FEATURES. */
export interface FeatureDefinition {
  /** Stable camelCase key used in the `features` object. */
  name: string;
  /** One-sentence human description. */
  description: string;
  /** Tools (or tool modes) that depend on this feature. */
  tools: string[];
  /** Lowest macOS version the feature can run on, as `major.minor`, or null for any. */
  minimumMacOSVersion: string | null;
  requirements: Requirement[];
}

/** Evaluated status of one feature. */
export interface FeatureStatus {
  description: string;
  tools: string[];
  available: boolean;
  osSupported: boolean;
  minimumMacOSVersion: string | null;
  /** Every requirement, as a stable label (see {@link requirementLabel}). */
  requirements: string[];
  /** Requirements that were checked and are not met. */
  missing: string[];
  /** Requirements not verified by this diagnostic (for example Automation or speech assets). */
  unverified: string[];
  reason: CapabilityReason | null;
}

/** Runtime facts the matrix is evaluated against. */
export interface CapabilityEnvironment {
  platform: NodeJS.Platform;
  /** `sw_vers -productVersion`, or null when it could not be read. */
  macOSVersion: string | null;
  /** Darwin kernel release (`os.release()`), for diagnostics only. */
  darwinRelease: string;
  fullDiskAccess: boolean;
  /** `shortcuts list --show-identifiers` lines, or null when the command failed. */
  shortcutLines: string[] | null;
  /** Absent only for injected/older probes; absence must never imply helper readiness. */
  publicHelper?: PublicHelperStatus;
}

/** The runtime OS block reported beside the matrix. */
export interface RuntimeOS {
  platform: NodeJS.Platform;
  macOSVersion: string | null;
  darwinRelease: string;
}

export interface CapabilityMatrix {
  runtimeOS: RuntimeOS;
  features: Record<string, FeatureStatus>;
  publicHelper?: PublicHelperStatus;
}

const MACOS_SHORTCUTS_CLI = "12.0";
const MACOS_MARKDOWN_IMPORT = "26.0";

/**
 * Every feature group the server offers. Later work registers a feature by
 * adding one entry here. Keep names stable: clients key on them.
 */
export const FEATURES: FeatureDefinition[] = [
  {
    name: "applescriptCore",
    description:
      "Create, read, search, update, move, and delete notes and folders through Notes.app's AppleScript interface",
    tools: [
      "create-note",
      "search-notes",
      "get-note-content",
      "update-note",
      "append-to-note",
      "insert-link",
      "delete-note",
      "move-note",
      "list-notes",
      "list-folders",
      "create-folder",
      "list-accounts",
    ],
    minimumMacOSVersion: null,
    requirements: [{ kind: "notes_automation" }],
  },
  {
    name: "fullDiskAccessReads",
    description:
      "Read-only reads of the Notes database: queries, checklist state, metadata, links, note structure, tables, native objects, tags, smart folders, special and recent notes, folder tree, Paper and attachment exports, Markdown and HTML exports, and sync detail",
    tools: [
      "query-notes",
      "get-checklist-state",
      "get-note-metadata",
      "get-note-link",
      "get-native-objects",
      "get-note-blocks",
      "get-note-structure",
      "get-note-tables",
      "list-note-links",
      "list-native-tags",
      "list-smart-folders",
      "list-special-notes",
      "list-recent-notes",
      "list-folder-tree",
      "list-paper-attachments",
      "export-paper-image",
      "export-attachments",
      "export-notes-markdown",
      "export-notes-html",
      "get-note-markdown (checklist annotations)",
      "get-sync-status (pending uploads)",
    ],
    minimumMacOSVersion: null,
    requirements: [{ kind: "full_disk_access" }],
  },
  {
    name: "shortcutsBridges",
    description: "Run the optional native-write Shortcut bridges in the background",
    tools: [],
    minimumMacOSVersion: MACOS_SHORTCUTS_CLI,
    requirements: [{ kind: "shortcuts_cli" }],
  },
  {
    name: "backgroundOperationsBridge",
    description:
      "Native background edits through the Background Operations bridge, verified by exact-ID database readback",
    tools: [
      "append-native",
      "create-checklist-item",
      "create-checklist-items",
      "create-table",
      "insert-note-link",
      "set-note-pinned",
      "remove-native-tags",
    ],
    minimumMacOSVersion: MACOS_SHORTCUTS_CLI,
    requirements: [
      { kind: "notes_automation" },
      { kind: "full_disk_access" },
      { kind: "shortcuts_cli" },
      { kind: "shortcut", name: backgroundShortcutName },
      { kind: "shortcut_consent" },
    ],
  },
  {
    name: "nativeTagsBridge",
    description: "Add real Notes tags through the Native Tags bridge",
    tools: ["add-native-tags", "replace-native-tag"],
    minimumMacOSVersion: MACOS_SHORTCUTS_CLI,
    requirements: [
      { kind: "notes_automation" },
      { kind: "full_disk_access" },
      { kind: "shortcuts_cli" },
      { kind: "shortcut", name: nativeTagsShortcutName },
      { kind: "shortcut_consent" },
    ],
  },
  {
    name: "markdownNoteBridge",
    description:
      "Create a note from Markdown with real Title, Heading, and Subheading styles through the Create Markdown Note bridge",
    tools: ['create-note (format: "markdown")'],
    minimumMacOSVersion: MACOS_MARKDOWN_IMPORT,
    requirements: [
      { kind: "notes_automation" },
      { kind: "full_disk_access" },
      { kind: "shortcuts_cli" },
      { kind: "shortcut", name: markdownShortcutName },
      { kind: "shortcut_consent" },
    ],
  },
  // Placeholders for features that need a native WRITE helper, which this
  // server does not ship. The opt-in private helper is read-only (write
  // support was deliberately deferred), so enabling or installing it changes
  // nothing here: these always report `not_implemented`. Reading smart folders
  // is available through list-smart-folders (fullDiskAccessReads).
  {
    name: "checklistToggle",
    description: "Check or uncheck an existing checklist item in place",
    tools: [],
    minimumMacOSVersion: null,
    requirements: [{ kind: "native_write_helper" }],
  },
  {
    name: "smartFolders",
    description: "Create or edit Smart Folders and their tag rules",
    tools: [],
    minimumMacOSVersion: null,
    requirements: [{ kind: "native_write_helper" }],
  },
  {
    name: "svgAnalysis",
    description:
      "Analyze a local SVG file for conversion into editable strokes: classification, required losses, and a digest",
    tools: ["analyze-svg"],
    minimumMacOSVersion: null,
    requirements: [],
  },
  {
    name: "paragraphLinks",
    description:
      "List a note's paragraphs and return a link that opens Notes at one paragraph or heading, read from the Notes database",
    tools: ["list-note-paragraphs", "get-paragraph-link"],
    minimumMacOSVersion: null,
    requirements: [{ kind: "full_disk_access" }],
  },
  {
    name: "storedAudioTranscripts",
    description:
      "Read transcripts Notes already stored for a note's audio recordings; no speech helper is needed",
    tools: ["get-audio-transcripts"],
    minimumMacOSVersion: null,
    requirements: [{ kind: "full_disk_access" }],
  },
  {
    name: "classicDrawingDecode",
    description: "Decode classic PencilKit drawings with the verified public native helper",
    tools: ["get-note-drawings"],
    minimumMacOSVersion: null,
    requirements: [{ kind: "full_disk_access" }, { kind: "public_native_helper" }],
  },
  {
    name: "audioTranscription",
    description:
      "Transcribe audio on this Mac with the verified public helper; locale and speech-model readiness are checked per request",
    tools: ["transcribe-note-audio"],
    minimumMacOSVersion: null,
    requirements: [
      { kind: "full_disk_access" },
      { kind: "public_native_helper" },
      { kind: "speech_recognition" },
      { kind: "speech_locale_and_assets" },
    ],
  },
  {
    name: "markdownTemplateLibrary",
    description:
      "Validate, save, list, show and delete Markdown export templates (local JSON files; exporting with one still needs Full Disk Access)",
    tools: [
      "list-markdown-templates",
      "show-markdown-template",
      "validate-markdown-template",
      "save-markdown-template",
      "delete-markdown-template",
    ],
    minimumMacOSVersion: null,
    requirements: [],
  },
];

/** Stable string label for a requirement, as reported in `requirements`/`missing`. */
export function requirementLabel(requirement: Requirement): string {
  return requirement.kind === "shortcut" ? `shortcut:${requirement.name()}` : requirement.kind;
}

/**
 * Compare two dotted version strings numerically. Returns a negative number
 * when `a < b`, zero when equal, positive when `a > b`. Missing segments are 0.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Evaluate one feature definition against a probed environment. Pure. */
export function evaluateFeature(
  feature: FeatureDefinition,
  env: CapabilityEnvironment
): FeatureStatus {
  const isMac = env.platform === "darwin";
  const floor = feature.minimumMacOSVersion;
  const versionKnown = env.macOSVersion !== null;
  const osSupported =
    isMac && (floor === null || (versionKnown && compareVersions(env.macOSVersion!, floor) >= 0));

  const missing: string[] = [];
  const unverified: string[] = [];
  const failures = new Set<CapabilityReason>();
  for (const requirement of feature.requirements) {
    const label = requirementLabel(requirement);
    switch (requirement.kind) {
      case "notes_automation":
        // Checking the Automation grant means sending Notes an Apple event.
        unverified.push(label);
        break;
      case "shortcut_consent":
        // `shortcuts list` reports installation, never first-run access consent.
        unverified.push(label);
        break;
      case "full_disk_access":
        if (!env.fullDiskAccess) {
          missing.push(label);
          failures.add("full_disk_access_missing");
        }
        break;
      case "shortcuts_cli":
        if (env.shortcutLines === null) {
          missing.push(label);
          failures.add("shortcuts_unavailable");
        }
        break;
      case "shortcut":
        // Unknowable when the CLI failed; shortcuts_cli already reports that.
        if (env.shortcutLines === null) unverified.push(label);
        else if (!resolveShortcut(env.shortcutLines, requirement.name()).installed) {
          missing.push(label);
          failures.add("shortcut_not_installed");
        }
        break;
      case "native_write_helper":
        missing.push(label);
        failures.add("not_implemented");
        break;
      case "public_native_helper":
        if (!env.publicHelper || env.publicHelper.reason === "not_probed") {
          unverified.push(label);
          failures.add("public_helper_unverified");
        } else if (!env.publicHelper.ready) {
          missing.push(label);
          failures.add("public_helper_unavailable");
        }
        break;
      case "speech_recognition": {
        const speech = env.publicHelper?.speech;
        if (!speech?.verified || speech.authorization === null || speech.requiresGrant === null) {
          unverified.push(label);
          failures.add("speech_status_unverified");
        } else if (
          speech.authorization === "denied" ||
          speech.authorization === "restricted" ||
          (speech.requiresGrant && speech.authorization !== "authorized")
        ) {
          missing.push(label);
          failures.add("speech_permission_required");
        }
        break;
      }
      case "speech_locale_and_assets":
        unverified.push(label);
        break;
    }
  }

  let reason: CapabilityReason | null = null;
  if (!isMac) reason = "unsupported_platform";
  else if (failures.has("not_implemented")) reason = "not_implemented";
  else if (floor !== null && !versionKnown) reason = "unknown_os_version";
  else if (!osSupported) reason = `requires_macos_${Number.parseInt(floor!, 10)}`;
  else if (failures.has("full_disk_access_missing")) reason = "full_disk_access_missing";
  else if (failures.has("shortcuts_unavailable")) reason = "shortcuts_unavailable";
  else if (failures.has("shortcut_not_installed")) reason = "shortcut_not_installed";
  else if (failures.has("public_helper_unavailable")) reason = "public_helper_unavailable";
  else if (failures.has("public_helper_unverified")) reason = "public_helper_unverified";
  else if (failures.has("speech_permission_required")) reason = "speech_permission_required";
  else if (failures.has("speech_status_unverified")) reason = "speech_status_unverified";

  return {
    description: feature.description,
    tools: feature.tools,
    available: reason === null,
    osSupported,
    minimumMacOSVersion: floor,
    requirements: feature.requirements.map(requirementLabel),
    missing,
    unverified,
    reason,
  };
}

/** Evaluate every feature against a probed environment. Pure. */
export function evaluateFeatures(
  env: CapabilityEnvironment,
  features: FeatureDefinition[] = FEATURES
): CapabilityMatrix {
  return {
    runtimeOS: {
      platform: env.platform,
      macOSVersion: env.macOSVersion,
      darwinRelease: env.darwinRelease,
    },
    features: Object.fromEntries(features.map((f) => [f.name, evaluateFeature(f, env)])),
    publicHelper: env.publicHelper ?? unprobedPublicHelperStatus(),
  };
}

/** Read the macOS product version with `sw_vers`, or null when unavailable. */
export function readMacOSVersion(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^\d+(\.\d+)*$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Probe the runtime once. Read-only: no Notes.app, no Apple events, no
 * Shortcut runs. Skips the macOS-only probes on other platforms.
 */
export function probeCapabilityEnvironment(): CapabilityEnvironment {
  const platform = process.platform;
  const isMac = platform === "darwin";
  let shortcutLines: string[] | null = null;
  if (isMac) {
    try {
      shortcutLines = listInstalledShortcuts();
    } catch {
      shortcutLines = null;
    }
  }
  return {
    platform,
    macOSVersion: readMacOSVersion(),
    darwinRelease: release(),
    fullDiskAccess: isMac && hasFullDiskAccess(),
    shortcutLines,
    publicHelper: isMac ? probePublicHelperStatus() : unprobedPublicHelperStatus(),
  };
}

/** Probe the runtime and evaluate every registered feature. */
export function getCapabilityMatrix(
  probe: () => CapabilityEnvironment = probeCapabilityEnvironment
): CapabilityMatrix {
  return evaluateFeatures(probe());
}

/** One-line-per-feature text summary for human-readable reports. */
export function formatCapabilityMatrix(matrix: CapabilityMatrix): string {
  const os = matrix.runtimeOS;
  const lines = [
    `Feature matrix (macOS ${os.macOSVersion ?? "unknown"}, Darwin ${os.darwinRelease}):`,
  ];
  for (const [name, status] of Object.entries(matrix.features)) {
    lines.push(
      status.available
        ? `  ✓ ${name}: available${status.unverified.length ? ` (unverified: ${status.unverified.join(", ")})` : ""}`
        : `  ✗ ${name}: ${status.reason}${status.missing.length ? ` (missing: ${status.missing.join(", ")})` : ""}${status.unverified.length ? ` (unverified: ${status.unverified.join(", ")})` : ""}`
    );
  }
  return lines.join("\n");
}
