# Session listing cache

`SessionManager.list()` and `SessionManager.listAll()` cache the complete result of a journal scan. The resume picker uses these APIs. Exact message counts, names, activity dates, first-message previews, and full user and assistant search text are unchanged. Search still includes abandoned branches and excludes tool output.

Each source directory can contain a private `.session-list-cache-v1` directory. A journal named `example.jsonl` has a derived `example.json` record there. Cache records contain plaintext conversation text. On POSIX systems the directory has mode `0700`, and records have mode `0600`. Windows uses inherited directory permissions. Keep the cache private with the session directory.

A cache hit requires the same device, inode, byte length, nanosecond modification time, and nanosecond change time. Pi checks the current source revision before and after cache reads. These checks detect ordinary external appends, truncations, replacements, and same-size edits with restored modification times. They are filesystem metadata checks, not cryptographic proof against hostile metadata-preserving changes.

Records also identify the date-parser context: Node, ICU and timezone-data versions, `TZ`, and the effective timezone. A different runtime or timezone rescans the source, preserving accepted timestamps that omit a zone. Unavailable date context disables caching rather than hiding a session.

The first listing, or a listing after a source change, still scans the complete journal. Pi does not approximate counts, truncate searchable text, or resume parsing from an old byte offset. A valid unterminated record and a malformed final fragment therefore keep their original behavior. Listing does not repair or rewrite journals.

Cache publication uses an exclusive temporary file and atomic rename. A scan whose source revision changes is not cached. Independent writers need no shared manifest or lock. An older record cannot authorize a hit for a newer source revision. Listing remains a best-effort observation during concurrent writes, not an atomic filesystem snapshot.

Every listing discovers current source files again. A renamed path appears under its new name, and a deleted journal is not returned. Listing removes orphaned records and temporary publications in each discovered source directory, including records for dangling journal symlinks. Successful picker deletion also removes the associated final and temporary records. Writers recheck the source around publication so a running writer does not recreate a deleted journal's cache.

Deleting an entire source directory removes its cache. An external single-file deletion leaves its derived records until the next listing of that directory. Cleanup is best-effort: permissions or storage errors can delay removal. A crashed writer's temporary file can remain while its source still exists; listing does not indiscriminately delete publications that another writer may still own.

Missing, invalid, unsupported, or unavailable cache records fall back to source scans. Read-only source directories remain listable but cannot populate a cache. Unsupported date values remain on the uncached path. No cache file is a session or a substitute for a journal.

Warm listing cost still includes directory discovery, revision checks, cache reads, and the complete search text. Storage grows with that text, not just the session count. The cache does not change per-keystroke search normalization, provider behavior, or session-open parsing. See the [synthetic Linux measurement record](../../../docs/performance/issue-251/README.md) for measured workloads and limits.
