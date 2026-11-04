import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
export const NOTES_REF = "refs/notes/ripplewitness";

/** Store a signed receipt as a git note on headRef. */
export async function writeNote(repoPath: string, headRef: string, receiptJson: string): Promise<void> {
  // Supply an identity per-invocation: hosted containers and fresh clones
  // often have no git user configured, and a note must not fail (or crash
  // the caller) for that reason.
  await execFileP(
    "git",
    ["-c", "user.name=RippleWitness", "-c", "user.email=ripplewitness@localhost", "notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", receiptJson, headRef],
    { cwd: repoPath },
  );
}

/** Read the receipt note for headRef, or null when absent. */
export async function readNote(repoPath: string, headRef: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["notes", `--ref=${NOTES_REF}`, "show", headRef], { cwd: repoPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
