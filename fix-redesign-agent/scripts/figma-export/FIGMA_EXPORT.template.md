# Figma export: {{WRAPPER}}

Exact copy of this run's React Preview as editable Figma layers (frame `{{WRAPPER}}` on page `{{PAGE}}`). Generated from the rendered preview, so it matches the page the
user approves. Images are the real pictures; hover/animation are not part of a static Figma frame.

Target Figma file: **the run's audit Figma file** `{{FILE_KEY}}` ({{FILE_URL}}), read from the audit project (`figmaFileKey`). Build the page `{{PAGE}}` in THAT file, never in the
Design System file (`1Vb8PFA1diOTDD3HT43peS`, read-only reference). The Ken DS is not a library in the audit files, so step 0 recreates its tokens there.

Run these from a session that has the Figma tools (the pipeline code itself cannot call Figma); every `use_figma` call uses `fileKey` = `{{FILE_KEY}}` and the skill `figma-use`.
The builder, the page chunks and the image hashes are stored in the file (plugin data `fra/*`), so only the first page of a file pays for the install, and pictures already
uploaded by an earlier page are reused. A frame `fra pictures (...)` on the page keeps the images alive: do not delete it.

0. **Tokens (once per file):** send `figma-export/tokens.js` as `code`. It creates `Ken / Colors`, `Spacing`, `Border Radius / Scale`, `Typography`, the DS text styles and the
   `Button / Brand` component, and skips whatever exists. Check the result (`made`) is plausible and no collection got duplicated.
1. **Install (once per file):** send `figma-export/install.js` as `code`. No-op when the file already has this version.
2. **Build:** send `figma-export/chunks/01.js` ... `{{CHUNKS}}`.js in order, one call each (each is below the 50 KB code limit). **Paste each file verbatim** (a typo changes the design).
   Each result has `firstBySrc` (picture slots that still need an image). Merge all `firstBySrc` objects into `figma-export/first-by-src.json`.
3. **Images:** `node scripts/figma-export/upload.mjs plan {{RUN}}` prints `{count, nodeIds}` -> call `upload_assets` with that `count` and `nodeIds` (scaleMode FILL),
   save its JSON result to `figma-export/uploads.json`, then `node scripts/figma-export/upload.mjs send {{RUN}} {{RUN}}/figma-export/uploads.json`.
   When `count` is 0 (all pictures already in the file) skip this step.
4. **Apply:** `use_figma` with code
   `const AF = Object.getPrototypeOf(async function () {}).constructor; return await new AF(figma.root.getSharedPluginData('fra', 'post'))();`
   It copies each picture to every slot, binds icon colours/font sizes to tokens, links exact-match text styles and clips the sections. `missing` must be empty.
5. **Verify:** `get_screenshot` of each section frame next to the live preview (no clipped buttons, no grey images, same layout). Compare text sizes with the preview. Fix a
   difference in `scripts/figma-export/` (not by hand in Figma), except a one-off paste typo. Report token coverage (fills/texts/buttons bound).

Re-running the export for the same run replaces the sections with the same names in place. After a builder fix, `figma-export/replay.js` (one `use_figma` call) rebuilds the
page from the chunks stored in the file and re-applies the pictures, with no data re-sent and no upload.
