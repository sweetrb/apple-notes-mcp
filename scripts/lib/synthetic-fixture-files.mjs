// File operations for private, quiescent synthetic fixture directories only.
// Check the opened object, then read that same descriptor, never a checked path.
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

export function readSingleLinkFile(path) {
  // NONBLOCK prevents opening a substituted FIFO from hanging before fstat.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Fixture file must be a regular file with exactly one link");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function archiveIsolatedPreference(path, archiveRoot) {
  // Move first into a fresh private directory. A symlink is moved as a link,
  // never followed. An unsafe object remains here for recovery if validation
  // fails. Separate directories prevent identical ByHost/domain names from
  // replacing an earlier archived preference.
  const directory = mkdtempSync(join(archiveRoot, "preference-"));
  chmodSync(directory, 0o700);
  const archivePath = join(directory, "preference.plist");
  renameSync(path, archivePath);
  try {
    return { archivePath, bytes: readSingleLinkFile(archivePath) };
  } catch (cause) {
    const error = new Error(`Unsafe isolated preference preserved at ${archivePath}`, { cause });
    error.archivePath = archivePath;
    throw error;
  }
}
