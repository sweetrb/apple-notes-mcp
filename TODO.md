# Apple Notes MCP - Improvement Roadmap

Based on technical research into Apple Notes internals and analysis of other implementations, here are remaining improvements.

## Future Considerations

### Hybrid SQLite + AppleScript Approach
**Problem**: AppleScript is slow and limited; direct SQLite is read-only.

**Solution**:
- Use SQLite for fast read operations (search, list, get content)
- Use AppleScript only for write operations (create, update, delete)
- Requires copying database for reads (safety)
- Significant performance improvement for large note collections

**Complexity**: High - requires protobuf parsing
**Dependencies**: `better-sqlite3`, `protobufjs`

---

### Watch for macOS API Changes
- Apple may deprecate AppleScript entirely
- Monitor for new Notes.app APIs in future macOS versions
- Consider Shortcuts integration as potential future path

---

## Implementation Notes

### Testing Strategy
- Unit tests with mocked AppleScript responses (existing)
- Integration tests against real Notes.app (manual, documented)
- Test matrix: macOS versions (Sonoma, Sequoia), note types (simple, attachments, locked)

### Backwards Compatibility
- All new parameters should be optional
- Existing tool signatures must not change
- Use feature detection for new capabilities

### Performance Targets
- Simple operations (get, create): < 500ms
- Search operations: < 2s for 1000 notes
- Batch operations: Linear scaling with count

*Created: December 2024*
*Based on research in [TECHNICAL_NOTES.md](./TECHNICAL_NOTES.md)*
