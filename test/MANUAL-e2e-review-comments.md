# Manual e2e — Review Comments

Run `npm start` and complete each numbered step. Each step is a single assertion.

1. Open a project that has uncommitted changes.
2. Spawn a Claude column. Wait until its session id appears (sidebar updates within ~5s).
3. Click a changed file in the Git tab. A diff column opens.
4. Verify the diff column header shows the file name.
5. Click line 5 in the diff's gutter (the line-number cell). A comment box appears anchored below line 5.
6. Type "test comment" in the textarea. Click Save.
7. Verify a 💬 indicator appears in the gutter next to line 5.
8. Click-drag from the gutter at line 8 down to the gutter at line 11. A comment box appears for the range.
9. Type "multi-line test". Click Save.
10. Verify 💬 indicators on lines 8 and 11 with a vertical connector between them.
11. Open a SECOND changed file from the Git tab. A new diff column opens (does not replace the first).
12. Comment on a line in this second file.
13. Verify the Git tab now shows "Copy (3)" and "Copy and Clear" buttons.
14. Click Copy. Paste into a scratch buffer. Verify the format:
    ```
    <fileA>:5
    test comment

    <fileA>:8-11
    multi-line test

    <fileB>:<n>
    <text>
    ```
15. Spawn a SECOND Claude column. Let it issue its own session id. Focus it.
16. From the Git tab (with column 2 focused), click the same file as in step 3. A NEW diff column opens (not the existing one).
17. Comment on a line in column 2's diff.
18. Verify Copy button reflects only column 2's session's comment count.
19. Re-focus column 1's diff. Verify Copy button reverts to step-13's count.
20. With column 1 focused, click "Copy and Clear". Clipboard contains the same text as step 14.
21. Verify all 💬 indicators in column 1's diff columns are gone, buttons hide, and `<project>/.claudes/review-comments-<wsId>-<sessionId>.json` no longer exists on disk.
22. Restart the app. Reopen the file from column 2's session. The 💬 indicator from step 17 re-renders.
23. Inspect `<project>/.claudes/`: no `.tmp` files left over.
