Find gives agents a `find` tool: describe a behaviour in words and get ranked files and line ranges with a confidence each, in seconds and for fractions of a cent.

Off by default. Semantic ranking needs `classify` (and its `TYPESAFE_API_KEY`) **and** the project's opt-in in its own `.ultimate/settings.json`; user settings never opt a project in:

```json
{ "find": { "sendSource": true } }
```

With the opt-in, file names, keyword-dense sketches and full passages of up to 20 files **leave the machine** for TypeSafe (see [classify](../classify/README.md)). Without it, or without classify, `find` returns the lexical ranking and says why on its first line; nothing is sent.

## How it searches

A port of oh-my-pi's `find` cascade.

1. **Files**: `git ls-files --cached --others --exclude-standard` under `path`, minus tracked files the ignore rules now match, hidden files, build output, lockfiles, binaries (by extension, and a NUL byte in the first 8 KB), empty files and credential material: any file or folder on the path named like `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `id_rsa*`, `*secret*`, `*credential*`, `.npmrc`, `.netrc` or `secrets.json`. Symlinks are never followed (a file or folder reached through one is skipped), and the cascade reads only files the listing admitted. Reads stop at 4 MB.
2. **Lexical**: keywords from the query (stopwords, short tokens and numbers dropped, light stemming) plus the given `keywords`; one `rg` pass counts them per file over its first 4 MB, at most 200 matching lines per file and the first 400 characters of a long line; score = Σ idf·log(1+count), idf clamped to [0.5, 6], plus a bonus for a keyword in the path.
3. **Filenames**: the 128 best files, 64 per request, one yes/no probability each over a compact tree listing.
4. **Sketches**: 20 files are read (the two lexically strongest, then by name probability), cut into 8 KB whole-line windows; the 24 best windows per file are each sketched to their 384 most keyword-dense bytes and judged, 46 per request.
5. **Verification**: sketches at 0.45 or above (40 at most) are judged as full windows, 3 per request; ranges at 0.20 or above merge, and a file is a hit when its best passage reaches 0.20.

Each wave runs 16 requests in flight and drains before the next. The whole call stops at 20 s and returns what was verified with a `partial` line, or the lexical ranking when nothing was (ranked by file names only, and marked partial, when the cap hits during the `rg` pass; a cap during listing fails the call, since nothing can be ranked). Repository content is framed to the judge as untrusted data. There is no cache.

The tool text lists hits strongest first, up to three `path:start-end  p  snippet` ranges each, and a footer with files listed and judged, requests, bytes sent, input tokens, cost ($0.042 per million input tokens) and wall time. `details` carries the same for the card in `web.tsx`.
