import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHunks } from "../lib/run.js";

const DIFF = `diff --git a/app/models/user.rb b/app/models/user.rb
index 1111111..2222222 100644
--- a/app/models/user.rb
+++ b/app/models/user.rb
@@ -3,0 +4,2 @@ class User
+  # added
++++ added line whose content begins with "++ "
@@ -10 +12 @@ def name
-old
+new
@@ -20,3 +23,0 @@
-gone
-gone
-gone
diff --git a/old.rb b/old.rb
deleted file mode 100644
--- a/old.rb
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git a/lib/path with space.rb b/lib/path with space.rb
--- a/lib/path with space.rb
+++ b/lib/path with space.rb
@@ -1 +1,3 @@
-x
+y
+z
+w
`;

test("parseHunks reads the new-side ranges of a -U0 diff", () => {
  const ranges = parseHunks(DIFF);
  assert.deepEqual(ranges.get("app/models/user.rb"), [ [ 4, 5 ], [ 12, 12 ] ], "a pure deletion adds no range");
  assert.equal(ranges.has("old.rb"), false, "a deleted file has no new lines");
  assert.equal(ranges.has("++ added line whose content begins with \"++ \""), false, "body lines are never headers");
  assert.deepEqual(ranges.get("lib/path with space.rb"), [ [ 1, 3 ] ]);
});

test("parseHunks of nothing is an empty map", () => {
  assert.equal(parseHunks("").size, 0);
});
