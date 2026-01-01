#!/usr/bin/env npx ts-node
/**
 * JXA vs AppleScript Comparison Script
 *
 * This script runs identical operations using both AppleScript and JXA
 * to compare behavior, performance, and output format.
 *
 * Run with: npx tsx scripts/jxa-comparison.ts
 */

import { execSync } from "child_process";

interface TestResult {
  name: string;
  applescript: { success: boolean; output: string; time: number; error?: string };
  jxa: { success: boolean; output: string; time: number; error?: string };
  comparison: string;
}

function runAppleScript(script: string): {
  success: boolean;
  output: string;
  time: number;
  error?: string;
} {
  const escaped = script.trim().replace(/'/g, "'\\''");
  const start = Date.now();
  try {
    const output = execSync(`osascript -e '${escaped}'`, { encoding: "utf8", timeout: 30000 });
    return { success: true, output: output.trim(), time: Date.now() - start };
  } catch (e) {
    return { success: false, output: "", time: Date.now() - start, error: (e as Error).message };
  }
}

function runJXA(script: string): {
  success: boolean;
  output: string;
  time: number;
  error?: string;
} {
  const escaped = script.trim().replace(/'/g, "'\\''");
  const start = Date.now();
  try {
    const output = execSync(`osascript -l JavaScript -e '${escaped}'`, {
      encoding: "utf8",
      timeout: 30000,
    });
    return { success: true, output: output.trim(), time: Date.now() - start };
  } catch (e) {
    return { success: false, output: "", time: Date.now() - start, error: (e as Error).message };
  }
}

const tests: Array<{ name: string; applescript: string; jxa: string }> = [
  {
    name: "List Accounts",
    applescript: `tell application "Notes" to get name of every account`,
    jxa: `
      const Notes = Application("Notes");
      Notes.accounts().map(a => a.name()).join(", ");
    `,
  },
  {
    name: "List Folders (iCloud)",
    applescript: `tell application "Notes" to tell account "iCloud" to get name of every folder`,
    jxa: `
      const Notes = Application("Notes");
      const iCloud = Notes.accounts.byName("iCloud");
      iCloud.folders().map(f => f.name()).join(", ");
    `,
  },
  {
    name: "Count Notes",
    applescript: `tell application "Notes" to count notes`,
    jxa: `
      const Notes = Application("Notes");
      Notes.notes().length;
    `,
  },
  {
    name: "Get First Note Title",
    applescript: `tell application "Notes" to get name of first note`,
    jxa: `
      const Notes = Application("Notes");
      Notes.notes()[0].name();
    `,
  },
  {
    name: "Get First Note Creation Date",
    applescript: `tell application "Notes" to get creation date of first note`,
    jxa: `
      const Notes = Application("Notes");
      Notes.notes()[0].creationDate().toISOString();
    `,
  },
  {
    name: "Unicode Test - Get Note with Emoji (if exists)",
    applescript: `
      tell application "Notes"
        set noteList to notes whose name contains "🎉"
        if (count of noteList) > 0 then
          return name of first item of noteList
        else
          return "No emoji notes found"
        end if
      end tell
    `,
    jxa: `
      const Notes = Application("Notes");
      const emojiNotes = Notes.notes().filter(n => n.name().includes("🎉"));
      emojiNotes.length > 0 ? emojiNotes[0].name() : "No emoji notes found";
    `,
  },
  {
    name: "Search Notes",
    applescript: `
      tell application "Notes"
        set matchingNotes to notes whose name contains "test"
        return count of matchingNotes
      end tell
    `,
    jxa: `
      const Notes = Application("Notes");
      Notes.notes().filter(n => n.name().toLowerCase().includes("test")).length;
    `,
  },
  {
    name: "Error Handling - Non-existent Note",
    applescript: `tell application "Notes" to get note "ThisNoteShouldNotExist12345"`,
    jxa: `
      const Notes = Application("Notes");
      Notes.notes.byName("ThisNoteShouldNotExist12345").name();
    `,
  },
];

console.log("=".repeat(80));
console.log("JXA vs AppleScript Comparison");
console.log("=".repeat(80));
console.log("");

const results: TestResult[] = [];

for (const test of tests) {
  console.log(`\n📋 ${test.name}`);
  console.log("-".repeat(40));

  const asResult = runAppleScript(test.applescript);
  const jxaResult = runJXA(test.jxa);

  let comparison: string;
  if (asResult.success === jxaResult.success) {
    if (asResult.output === jxaResult.output) {
      comparison = "✅ Identical output";
    } else {
      comparison = "⚠️ Different format (both succeeded)";
    }
  } else {
    comparison = "❌ Different success status";
  }

  console.log(`AppleScript: ${asResult.success ? "✓" : "✗"} (${asResult.time}ms)`);
  if (asResult.success) {
    console.log(
      `  Output: ${asResult.output.substring(0, 100)}${asResult.output.length > 100 ? "..." : ""}`
    );
  } else {
    console.log(`  Error: ${asResult.error?.substring(0, 100)}`);
  }

  console.log(`JXA:         ${jxaResult.success ? "✓" : "✗"} (${jxaResult.time}ms)`);
  if (jxaResult.success) {
    console.log(
      `  Output: ${jxaResult.output.substring(0, 100)}${jxaResult.output.length > 100 ? "..." : ""}`
    );
  } else {
    console.log(`  Error: ${jxaResult.error?.substring(0, 100)}`);
  }

  console.log(`Comparison: ${comparison}`);

  results.push({ name: test.name, applescript: asResult, jxa: jxaResult, comparison });
}

// Performance summary
console.log("\n" + "=".repeat(80));
console.log("Performance Summary");
console.log("=".repeat(80));

const successfulTests = results.filter((r) => r.applescript.success && r.jxa.success);
if (successfulTests.length > 0) {
  const asTotal = successfulTests.reduce((sum, r) => sum + r.applescript.time, 0);
  const jxaTotal = successfulTests.reduce((sum, r) => sum + r.jxa.time, 0);

  console.log(`\nSuccessful tests: ${successfulTests.length}`);
  console.log(
    `AppleScript total time: ${asTotal}ms (avg: ${Math.round(asTotal / successfulTests.length)}ms)`
  );
  console.log(
    `JXA total time: ${jxaTotal}ms (avg: ${Math.round(jxaTotal / successfulTests.length)}ms)`
  );
  console.log(
    `\nPerformance ratio: JXA is ${(asTotal / jxaTotal).toFixed(2)}x ${jxaTotal < asTotal ? "faster" : "slower"} than AppleScript`
  );
}

console.log("\n" + "=".repeat(80));
console.log("Key Findings");
console.log("=".repeat(80));
console.log(`
1. Date Format:
   - AppleScript: "date Saturday, December 27, 2025 at 3:44:02 PM" (locale-dependent)
   - JXA: ISO format when using .toISOString() (consistent, parseable)

2. Array Output:
   - AppleScript: Comma-separated string "item1, item2, item3"
   - JXA: Native JavaScript arrays, can be formatted as needed

3. Error Messages:
   - Both provide similar error messages from OSA framework

4. Unicode:
   - Both should handle Unicode equally (same underlying framework)

5. String Escaping:
   - AppleScript: Complex escaping for shell + AppleScript + HTML
   - JXA: Standard JavaScript escaping (simpler)
`);
