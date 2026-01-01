# JXA (JavaScript for Automation) Research

This document summarizes research into using JXA as an alternative to AppleScript for interacting with Apple Notes.

## Background

JXA was introduced in OS X Yosemite (10.10) as an alternative scripting language for the OSA (Open Scripting Architecture) framework. It allows JavaScript to be used instead of AppleScript for automation tasks.

**Hypothesis**: JXA might provide advantages over AppleScript:
- Simpler string escaping (standard JavaScript)
- Better Unicode handling
- Familiar syntax for developers
- Native JSON support

## Implementation

Created `src/utils/jxa.ts` with:
- `executeJXA(script, options)` - Execute JXA via `osascript -l JavaScript`
- `escapeForJXA(str)` - Standard JavaScript string escaping
- `buildNotesJXA(code)` - Wrapper for Notes.app context

## Test Results

### Performance Comparison

| Operation | AppleScript | JXA | Ratio |
|-----------|-------------|-----|-------|
| List Accounts | 124ms | 152ms | 0.8x |
| List Folders | 141ms | 153ms | 0.9x |
| Count Notes | 148ms | 138ms | 1.1x |
| Get First Note Title | 154ms | 155ms | 1.0x |
| Get Creation Date | 152ms | 150ms | 1.0x |
| **Unicode Search** | **155ms** | **4129ms** | **0.04x** |
| **Text Search** | **311ms** | **4115ms** | **0.08x** |

**Overall**: JXA is **0.13x the speed of AppleScript** (7.6x slower)

### Why Search is So Slow in JXA

AppleScript's `whose` clause is optimized at the OSA/Notes.app level:
```applescript
-- Fast: filtered server-side
notes whose name contains "test"
```

JXA must iterate in JavaScript:
```javascript
// Slow: fetches all notes, filters client-side
Notes.notes().filter(n => n.name().includes("test"))
```

The 347-note test database showed search operations taking 4+ seconds in JXA vs ~300ms in AppleScript.

### Output Format Comparison

| Aspect | AppleScript | JXA |
|--------|-------------|-----|
| **Dates** | Locale-dependent ("Wednesday, December 31, 2025 at 5:33:09 PM") | ISO format with `.toISOString()` |
| **Arrays** | Comma-separated string | Native JavaScript arrays |
| **Null handling** | "missing value" | JavaScript null/undefined |

### String Escaping Comparison

**AppleScript** (complex, multi-layer):
```typescript
// Must escape for: shell → AppleScript → HTML
str.replace(/\\/g, "&#92;")       // HTML entity for backslash
   .replace(/"/g, "\\\"")          // AppleScript quote escape
   .replace(/'/g, "'\\''")         // Shell quote escape
```

**JXA** (simpler, standard JavaScript):
```typescript
str.replace(/\\/g, "\\\\")         // Standard JS escaping
   .replace(/"/g, '\\"')
   .replace(/\n/g, "\\n")
```

### Unicode Handling

Both handle Unicode identically - they share the same underlying OSA framework. No advantage either way.

### Error Messages

Both produce similar error messages from the OSA framework:
- AppleScript: `execution error: Notes got an error: Can't get note "X". (-1728)`
- JXA: `execution error: Error: Error: Can't get object. (-1728)`

## Recommendation

**Do NOT migrate to JXA for Apple Notes operations.**

### Reasons

1. **Critical Performance Penalty**: Search operations are 10-26x slower due to client-side filtering
2. **No Significant Escaping Advantage**: While JXA escaping is simpler, our AppleScript escaping is already robust and well-tested
3. **Same Underlying Limitations**: Both use OSA, so neither can access locked notes, sync state, etc.
4. **Maintenance Burden**: Would require maintaining two scripting approaches

### Limited Use Cases for JXA

JXA could be useful for:
1. **Date formatting**: Returns ISO dates instead of locale-dependent strings (but we can parse AppleScript dates)
2. **JSON output**: Native `JSON.stringify()` for complex data (but our current parsing works fine)
3. **One-off scripts**: Developer tools/scripts where performance isn't critical

### Conclusion

The current AppleScript implementation should remain the primary execution method. The simpler escaping in JXA doesn't justify the 7.6x performance penalty, especially for operations involving filtering or searching.

The JXA utilities (`src/utils/jxa.ts`) have been created and tested, and can be used for specific scenarios where its advantages (ISO dates, simpler escaping) outweigh the performance cost.

## Files Created

- `src/utils/jxa.ts` - JXA execution utilities
- `src/utils/jxa.test.ts` - Unit tests (16 tests)
- `scripts/jxa-comparison.ts` - Real-world comparison script
- `docs/JXA_RESEARCH.md` - This document

## Test Environment

- macOS Sequoia 26.2.0
- Notes.app with 347 notes across 4 accounts
- Node.js with tsx for TypeScript execution

---

*Research completed: January 2025*
*Branch: feature/jxa-alternative*
