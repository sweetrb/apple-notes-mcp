# Markdown export templates

`export-notes-markdown` can render notes through a template instead of its
fixed Markdown renderer. A template is portable JSON that says how each block
style, inline format, attachment, per-note header and footer, and the
separator between notes are written. It is data only: there are no
expressions, conditions or scripts. Each rule picks one of five modes and may
use `{{placeholder}}` tokens, which are replaced literally.

Templates change only the exported Markdown. They never change a note.

## Choosing a template

Built-in and saved templates are managed with `list-markdown-templates`,
`show-markdown-template`, `validate-markdown-template`,
`save-markdown-template` and `delete-markdown-template`. Saved templates live
in `~/Library/Application Support/apple-notes-mcp/templates` (or the absolute
directory in `APPLE_NOTES_MCP_TEMPLATE_DIR`) as `<name>.json`, where the name
is a lowercase slug of `a-z`, `0-9`, `-` and `_`. Saving is create-only unless
`force` is true, and the built-in names are reserved. The library skips files
it cannot read or validate instead of trusting them.

Pass exactly one of these to `export-notes-markdown`:

| Parameter | Meaning |
| --- | --- |
| `template` | A built-in name (`standard-markdown` or `obsidian`) or a saved template's name |
| `templateFile` | An absolute path to a JSON template file ending in `.json` (home, a temp directory, or `/Volumes`; at most 256 KiB; symlinks refused). Hidden paths and `~/Library` other than iCloud Drive and `~/Library/CloudStorage` are refused unless the server sets `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1`. Errors name the file, never its contents |

The template is read and validated before any note is opened. An invalid
template is refused with `[invalid-template]` and one line per problem, each
with a JSON path:

```text
Error exporting Markdown [invalid-template]: the template is invalid:
$.rules["inline.bold"].after: is required when mode is "wrap"
$.inlineOrder: must list every inline format; missing "link"
```

Errors never quote the file's contents. A JSON syntax error reports only its
line and column, a wrong value reports the allowed values but not the one
given, and a file without `"schemaVersion": 1` is reported only as missing
it, with nothing else about the file.

### Built-in templates

- **`standard-markdown`** reproduces the default export exactly. Use it as the
  base for your own templates.
- **`obsidian`** extends `standard-markdown` with YAML front matter for every
  note (title, created, modified, folder, tags, note id), renders link cards
  whose URL is an image file as images (taking a following all-italic
  paragraph as the alt text), and copies attachments into `<file>.assets`
  beside `outputPath`.

## A first template

This template keeps every standard rule and wraps blue highlights in a
callout. Listing `highlight` last in `inlineOrder` makes it the outermost
wrapper, so a bold blue run renders as `[callout]**text**[/callout]`.

```json
{
  "schemaVersion": 1,
  "name": "editorial",
  "inlineOrder": [
    "subscript",
    "superscript",
    "underline",
    "strikethrough",
    "bold",
    "italic",
    "color",
    "link",
    "highlight"
  ],
  "rules": {
    "inline.highlight.blue": { "mode": "wrap", "before": "[callout]", "after": "[/callout]" }
  }
}
```

## Schema version 1

| Key | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | The integer `1` |
| `name` | no | Display name, at most 512 characters |
| `description` | no | At most 512 characters |
| `extends` | no | `standard-markdown` (the default) or `obsidian` |
| `assets` | no | Merged field by field with the base |
| `inlineOrder` | no | Every inline format exactly once, innermost first |
| `rules` | no | Rule overrides keyed by rule id; each replaces the whole base rule |
| `options` | no | Merged field by field with the base |

Unknown keys, rule ids, rule fields, placeholders and modifiers are errors.

### Rule modes

| Mode | Fields | Output |
| --- | --- | --- |
| `wrap` | `before`, `after` | `before` + content + `after` |
| `linePrefix` | `value` | `value` before every line of the content (a blank line gets the trimmed prefix) |
| `pattern` | `value` | `value`, with `{{content}}` where the content goes |
| `plain` | none | The content unchanged |
| `omit` | none | Nothing |

A field that the mode does not use is an error. Any rule may add
`"join": "line"` or `"join": "paragraph"`. Adjacent blocks whose rule joins by
`line` and that share a group stay on consecutive lines; everything else is
separated by a blank line. All list styles share one group, so a bulleted item
followed by a numbered item stays tight. For `attachment.gallery`, `join` sets
the spacing between gallery items.

Inline rules apply to a run's text without its leading and trailing
whitespace, which stays outside the wrapper. An inline rule set to `plain`
does not split runs, and one set to `omit` drops the text it covers.

### Rules and their standard values

| Rule | Standard |
| --- | --- |
| `document.header` | `pattern` `""` (runs once per note, before it) |
| `document.footer` | `pattern` `""` (once per note, after it) |
| `document.separator` | `pattern` `"\n\n---\n\n"` (between notes; placeholders describe the next note) |
| `block.title` | `wrap` `"# "`, paragraph join |
| `block.heading` | `wrap` `"## "`, paragraph join |
| `block.subheading` | `wrap` `"### "`, paragraph join |
| `block.body` | `plain`, paragraph join |
| `block.bulleted`, `block.dashed` | `wrap` `"- "`, line join |
| `block.numbered` | `pattern` `"{{index}}. {{content}}"`, line join |
| `block.checklist.checked` | `wrap` `"- [x] "`, line join |
| `block.checklist.unchecked` | `wrap` `"- [ ] "`, line join |
| `block.code` | `wrap` `"{{fence}}\n"` / `"\n{{fence}}"`, paragraph join |
| `paragraph.quote` | `linePrefix` `"> "` (applied after the block's own rule) |
| `inline.bold` / `inline.italic` | `wrap` `**` / `*` |
| `inline.underline` / `inline.strikethrough` | `wrap` `<u>`…`</u>` / `~~` |
| `inline.superscript` / `inline.subscript` | `wrap` `<sup>`…`</sup>` / `<sub>`…`</sub>` |
| `inline.highlight.purple`, `.pink`, `.orange`, `.mint`, `.blue`, `.other` | `wrap` `==` |
| `inline.color` | `plain` |
| `inline.link` | `pattern` `"[{{content}}]({{url}})"` |
| `attachment.image`, `attachment.drawing.classic`, `attachment.drawing.paper` | `pattern` `"![{{alt}}]({{path}})"` |
| `attachment.scan`, `.pdf`, `.audio`, `.video`, `.other` | `pattern` `"[{{linkText}}]({{path}})"` |
| `attachment.table` | `plain` (content is a GitHub table) |
| `attachment.divider` | `pattern` `"---"` |
| `attachment.gallery` | `plain`, paragraph join (content is the gallery's items) |
| `attachment.url` / `attachment.map` | `pattern` `"[{{alt}}]({{url}})"` |
| `attachment.url.image` | `pattern` `"![{{alt}}]({{url}})"` |
| `attachment.placeholder` | `pattern` `"\\[{{content}}\\]"` (an attachment with no file, or a missing one) |

Drawings are exported through the image Notes stores for them. A link card to
`maps.apple.com` uses `attachment.map`. A link card whose URL is not http(s),
`notes:`, `applenotes:` or `mailto:` is always written as plain text. Hashtags
and mentions keep their text; inline note links use `inline.link`.

The standard `inlineOrder`, innermost first, is:

```json
["subscript", "superscript", "highlight", "underline", "strikethrough", "bold", "italic", "color", "link"]
```

### Placeholders

| Placeholder | Value |
| --- | --- |
| `{{content}}` | The rule's input |
| `{{title}}`, `{{id}}`, `{{uuid}}` | Note title, `x-coredata` id, and Notes UUID |
| `{{folder}}`, `{{account}}` | Folder and account names |
| `{{created}}`, `{{modified}}` | ISO 8601 UTC dates |
| `{{tags}}` | The note's hashtags without `#`, comma-separated |
| `{{exportStem}}` | `outputPath`'s file name without its extension (`export` without one) |
| `{{index}}`, `{{checked}}` | Numbered-list position; `true`/`false` for checklists |
| `{{url}}`, `{{path}}` | Link target; asset path (both escaped for a Markdown link) |
| `{{alt}}`, `{{linkText}}`, `{{caption}}` | Attachment name; its name or preview image; image-link caption |
| `{{filename}}`, `{{kind}}`, `{{uti}}` | Attachment file name, kind, and type identifier |
| `{{color}}`, `{{highlight}}` | Run color (`#RRGGBB`) and highlight name |
| `{{fence}}` | A backtick fence longer than any backtick run in the code |

Text values are escaped for Markdown. Add a modifier for other contexts:
`{{title:raw}}` inserts the value as stored, and `{{title:yaml}}` inserts a
double-quoted YAML string (tags become a YAML list, and a missing value becomes
`null`). A missing value is otherwise empty. This header writes YAML front
matter that stays valid whatever the title contains:

```json
{
  "schemaVersion": 1,
  "rules": {
    "document.header": {
      "mode": "pattern",
      "value": "---\ntitle: {{title:yaml}}\ncreated: {{created:yaml}}\ntags: {{tags:yaml}}\n---\n\n"
    }
  }
}
```

### Options

| Option | Standard | Meaning |
| --- | --- | --- |
| `titleFallback` | `true` | Add a `block.title` line when the body does not start with the note's title |
| `richLinkImages` | `false` | Render http(s) link cards whose URL path ends in an image extension through `attachment.url.image` |
| `richLinkImageCaption` | `"none"` | `"followingItalicParagraph"`: use the next paragraph as the image's alt text (and `{{caption}}`) when the card stands alone in its paragraph and every character of the next body paragraph is italic; that paragraph is then not repeated |
| `listIndent` | four spaces | Added once per indent level before list items (at most 16 spaces or tabs) |

## Assets

| Field | Standard | Values |
| --- | --- | --- |
| `mode` | `"copy"` | `copy` attachment files, link to the originals in place (`reference`), or `omit` file attachments entirely |
| `pathStyle` | `"relative"` | Links relative to `outputPath`'s directory, or `absolute` |
| `directory` | `null` | A relative directory beneath `outputPath`'s directory, with note placeholders such as `{{exportStem}}`, `{{folder}}` or `{{title}}` |

- In `copy` mode, files go to `assetsDir` when it is passed; otherwise to
  `directory` when it is set and there is an `outputPath`. With neither,
  attachments render through `attachment.placeholder`, and a template that
  sets `directory` reports an `assets_dir_required` warning for each one.
- Copies are named with a sanitized stem and the first eight hex digits of
  the file's SHA-256 (`photo-1a2b3c4d.jpg`), so a repeated export reuses the
  same file. An existing file is never replaced: a different file under the
  same name is reported as `asset_copy_failed`.
- `directory` must be relative with no `..` component. Placeholder values are
  made safe as single path components, and the result must stay inside
  `outputPath`'s directory, or the export is refused before anything is
  written.
- `reference` writes links to the files inside the Notes library. Those links
  work only on this Mac. `assetsDir` is refused in `reference` and `omit`
  modes.
- Relative links need `outputPath`; without it, links are absolute.

## Results and warnings

A templated export returns the usual receipt plus `template` (`name` and
`source`: `builtin`, `saved` or `file`), `warnings`, and `assetFiles` (the
absolute paths of the files copied or reused). Warnings do not stop the
export:

| Code | Meaning |
| --- | --- |
| `attachment_not_found` | The body names an attachment the note does not have |
| `inline_token_metadata_missing` | A hashtag, mention or note link has no text |
| `table_decode_failed` | A table could not be decoded |
| `missing_asset` | An attachment's file was not found |
| `asset_copy_failed` | A file could not be read or copied safely |
| `assets_dir_required` | The template wants copies but there is nowhere to put them |
| `gallery_children_missing` | A gallery has no items |

Each warning carries `noteId` and, when known, `attachmentId`. At most 200
are listed; `warningsOmitted` counts the rest.

## Editing in a browser

`apple-notes-mcp templates edit` starts a small local web editor for
templates. It is a command-line tool, not an MCP tool, and it runs only while
you leave it running.

```bash
npx apple-notes-mcp templates edit               # start from standard-markdown
npx apple-notes-mcp templates edit obsidian      # open a built-in or saved template
npx apple-notes-mcp templates edit --note "x-coredata://…/ICNote/p123"
```

It prints one address, such as
`http://127.0.0.1:52817/?token=3f9c…`. Open it in a browser. The page shows
the template JSON on the left and the rendered Markdown on the right. Each
edit is checked by the same validator as `validate-markdown-template`, and
problems are listed with their JSON paths. The preview uses the same renderer
as `export-notes-markdown`, against three built-in sample notes (headings and
lists, inline formatting and links, attachments and tags). Attachments render
as placeholders; the preview never copies files.

Real notes are not read unless you pass `--note` with one note id. That note
is read once, read-only, from the Notes database when the editor starts, so
it needs the same Full Disk Access as `export-notes-markdown`. It appears as
an extra preview choice.

**Save** writes the template to the library through the same path as
`save-markdown-template`: it validates first, is create-only, and replaces an
existing template only when you tick "Replace an existing template". The
editor never writes to Notes.

| Option | Meaning |
| --- | --- |
| `name` | Template to open first (default `standard-markdown`) |
| `--port N` | Port to listen on (default: any free port) |
| `--idle-minutes N` | Stop after N minutes with no requests (default 30; `0` turns it off) |
| `--note ID` | Also preview one real note, read-only |
| `--tailnet` | Listen on this Mac's Tailscale address instead of `127.0.0.1` (see below) |

Press Ctrl-C to stop the editor. It also stops by itself after the idle
period.

### What the editor exposes

- It listens on `127.0.0.1` only, unless you pass `--tailnet`.
- Every request must carry the random token from the printed address, either
  as `?token=` or as an `Authorization: Bearer` header. A new token is made
  each run, and the editor never logs it. Anyone who has the address can
  read and save templates until the editor stops, so treat it like a
  password.
- Requests whose `Host` header is not the editor's own address are refused,
  which blocks DNS rebinding. Requests from another origin are refused, and
  saves must come from the editor's own page with a JSON body, so another web
  page cannot drive it.
- The page loads nothing from the network. Its script and style carry a
  per-page nonce under a strict Content-Security-Policy, and responses send
  `Referrer-Policy: no-referrer` so the token does not leak in a referrer.

### On your tailnet

`--tailnet` binds the editor to this Mac's [Tailscale](https://tailscale.com)
IPv4 address (the `100.64.0.0/10` address on its `utun` interface) so you
can edit from an iPad or another computer on your tailnet. It is off unless
you pass the flag, and it refuses to start when this Mac has no Tailscale
address.

The editor finds the address by reading the network interfaces. It does not
run the `tailscale` command, and it never changes Tailscale settings, Serve
or Funnel, ACLs, or the macOS firewall. Whether other devices can reach the
port is decided by your tailnet's access rules. The traffic is carried inside
Tailscale's encrypted tunnel, but the editor itself speaks plain HTTP.

With `--tailnet`, every device on your tailnet that is allowed to reach this
Mac can connect to the port, and any of them that has the printed address can
read and save templates. Share the address only with yourself, and stop the
editor when you are done.
