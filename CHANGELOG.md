# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.16] - 2025-01-01

### Added
- **Collaboration Awareness**
  - `list-shared-notes` tool to find all notes shared with collaborators
  - Warnings on `update-note` when modifying shared notes
  - Warnings on `delete-note` when removing shared notes
  - `listSharedNotes()` method in AppleNotesManager

## [1.2.15] - 2025-01-01

### Added
- **iCloud Sync Awareness**
  - `get-sync-status` tool to check if iCloud sync is active
  - Sync warnings integrated into `search-notes`, `list-notes`, `list-folders`
  - Detection of pending uploads and recent database activity
  - Follow-up verification to detect sync interference

- **JXA Research** (utilities only, not primary executor)
  - `src/utils/jxa.ts` - JavaScript for Automation execution utilities
  - Research documented in `docs/JXA_RESEARCH.md`
  - Finding: JXA is 7.6x slower than AppleScript, not recommended for primary use

## [1.2.14] - 2024-12-31

### Added
- **Markdown Export**
  - `get-note-markdown` tool to retrieve note content as Markdown
  - Uses Turndown library for HTML to Markdown conversion

## [1.2.13] - 2024-12-31

### Added
- **Database Export**
  - `export-notes-json` tool for complete notes backup as JSON

## [1.2.12] - 2024-12-31

### Added
- **Batch Operations**
  - `batch-delete-notes` tool to delete multiple notes by ID
  - `batch-move-notes` tool to move multiple notes to a folder

## [1.2.11] - 2024-12-31

### Added
- **Attachment Listing**
  - `list-attachments` tool to see attachments in a note

## [1.2.10] - 2024-12-31

### Added
- **Verbose Logging**
  - DEBUG environment variable support for troubleshooting

## [1.2.9] - 2024-12-31

### Added
- **Statistics**
  - `get-notes-stats` tool for comprehensive notes statistics

## [1.2.8] - 2024-12-31

### Changed
- Validate note existence before destructive operations
- Better error messages for missing notes

## [1.2.7] - 2024-12-31

### Added
- Retry logic for transient failures (Notes.app not responding)
- Improved error message mapping

## [1.2.6] - 2024-12-31

### Added
- `health-check` tool to verify Notes.app connectivity and permissions

## [1.2.5] - 2024-12-31

### Added
- `folder` parameter to `search-notes` for filtering by folder

## [1.2.4] - 2024-12-31

### Added
- Timeout handling for AppleScript operations (30 second default)
- Password-protected note detection with clear error messages

## [1.1.2] - 2024-12-31

### Fixed

- Search functionality crash when notes have inaccessible containers (orphaned/corrupted notes)
  - Added error handling in AppleScript loop to skip problematic notes instead of failing entirely
  - Search now returns all accessible matching notes even if some cannot be processed

## [1.1.0] - 2025-12-27

### Added

- **Folder Operations**
  - `list-folders` - List all folders in an account
  - `create-folder` - Create a new folder
  - `delete-folder` - Delete a folder

- **Multiple Account Support**
  - `list-accounts` - List all available accounts
  - All tools now accept optional `account` parameter

- **Enhanced Search**
  - `searchContent` option to search note bodies instead of just titles

- **Note Management**
  - `get-note-by-id` - Retrieve note by unique ID
  - `get-note-details` - Get full note metadata (dates, shared status)
  - `update-note` - Update existing note title and content
  - `delete-note` - Delete notes by title
  - `move-note` - Move notes between folders (copy-then-delete)

- **Developer Experience**
  - Comprehensive JSDoc documentation
  - Unit tests with Vitest (121 tests)
  - Integration tests for all MCP tool handlers
  - ESLint and Prettier configuration
  - TypeScript strict mode

### Fixed

- AppleScript escaping for apostrophes (shell quoting issue)
- Newline handling in note content (now converts to HTML breaks)
- Date parsing in getNoteById (handles commas in AppleScript date format)

### Changed

- Complete rewrite of all source code with new architecture
- Updated to Node.js 20+ requirement
- Improved error messages throughout

## [1.0.0] - 2025-01-01

Initial release.

### Features

- Create notes with title and content
- Search notes by title
- Retrieve note content by title
- iCloud account support
