/**
 * First-run Shortcuts consent for the native-write bridges (#172, item 5).
 *
 * The server runs headless, so the first time an action inside a bridge
 * Shortcut needs consent, Shortcuts wants to show a prompt that a background
 * `shortcuts run` cannot display. The run stalls until the transport timeout
 * and readback fails, while `doctor` and `get-capabilities` still report the
 * bridge installed. Running that Shortcut once in the foreground in
 * Shortcuts.app shows the prompt, and Always Allow clears it for good — once
 * per bridge Shortcut. Relaunching Shortcuts.app or Notes.app does not.
 *
 * The `shortcuts` CLI (run / list / view / sign) exposes no consent or run
 * history, so this cannot be detected up front without touching Shortcuts'
 * private store; the hint is attached to the stalled-run failure instead.
 */
export function shortcutConsentHint(shortcut?: string): string {
  const target = shortcut ? `"${shortcut}"` : "the bridge Shortcut";
  return (
    `This may be an unanswered first-run Shortcuts consent prompt, which a background run cannot display: ` +
    `run ${target} once in the foreground in Shortcuts.app and choose Always Allow.`
  );
}
