# Repository Rules

## Release versions

- Default to patch-only releases: increment the current version by exactly `0.0.1`.
- Do not increment the major or minor component unless the user explicitly requests it.
- The release after `1.2.5` is `1.2.6`.
- Create and push the release tag only after the final fix commit and verification are complete.
