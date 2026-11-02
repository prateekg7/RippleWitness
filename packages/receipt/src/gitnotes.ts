import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
export const NOTES_REF = "refs/notes/ripplewitness";

/** Store a signed receipt as a git note on headRef. */
export async function writeNote(repoPath: string, headRef: string, receiptJson: string): Promise<void> {
  await execFileP("git", ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", receiptJson, headRef], { cwd: repoPath });
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
