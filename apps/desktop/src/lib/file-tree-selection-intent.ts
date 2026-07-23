/**
 * Distinguishes user-driven tree selection from selection used only to reveal
 * an already-open file.
 */
export class FileTreeSelectionIntent {
  private programmaticDepth = 0;

  runProgrammaticSelection(action: () => void): void {
    this.programmaticDepth += 1;
    try {
      action();
    } finally {
      this.programmaticDepth -= 1;
    }
  }

  shouldOpenSelection(): boolean {
    return this.programmaticDepth === 0;
  }
}
