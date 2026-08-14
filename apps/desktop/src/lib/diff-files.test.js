import { describe, expect, test } from "bun:test";
import { splitDiffByFile } from "./diff-files.ts";

describe("splitDiffByFile", () => {
  test("indexes each file and removes unparseable conflict markers", () => {
    const result = splitDiffByFile(`* Unmerged path conflicted.txt
diff --git a/first.txt b/first.txt
--- a/first.txt
+++ b/first.txt
@@ -1 +1 @@
-before
+after
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new
`);

    expect(Object.keys(result)).toEqual(["first.txt", "new.txt"]);
    expect(result["first.txt"]).not.toContain("Unmerged path");
    expect(result["new.txt"]).toContain("+new");
  });
});
