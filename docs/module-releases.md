# Publishing official module releases

Official module downloads are public. Users do not need a GitHub account, PAT,
private-repository membership, publisher workstation, or CI/CD credential.
The publisher's authenticated CI/Release access is separate from consumer HTTPS
downloads and Ed25519 package verification.

The official channel is:

```text
https://github.com/waksana/cockpit/releases/download/modules-stable/modules.signed.json
```

The public key is pinned in `packages/core/src/modules/official-channel.ts`.
Its private key is operator-owned protected storage, never a repository file,
runtime credential, browser value, artifact or log. Rotating this trust root is
an explicit release/installer change, not something the downloaded catalog can
authorize itself.

## Publish immutable packages

1. Integrate the exact source into the appropriate repository target and wait
   for its fixed-SHA CI run. The existing Actions build identity belongs only
   to this publishing step.
2. Download that run's `runtime-<full-source-sha>` ZIP through GitHub's official
   authenticated publisher API. Do not rebuild it from a mutable worktree,
   copy production data, or put a temporary signed download URL in metadata.
3. Write a small specification `{moduleId,version,sourceSha}` and run:

   ```sh
   node scripts/package-module-release.mjs CI_RUNTIME_ZIP SPECIFICATION_JSON NEW_OUTPUT_DIRECTORY
   ```

   The publisher validates the complete CI inventory, source SHA and host
   platform/toolchain. Task and WeChat ZIPs are preserved byte-for-byte.
   Assistant is extracted only from the verified main CI package's
   `modules/assistant`; no main program, authentication or user data is added.
   The output includes the archive, `target.json` and a provenance receipt.
4. Publish the archive to the output's exact repository and tag using
   `gh release create <tag> --target <full-source-sha> ...` and
   `gh release upload <tag> <archive>`. A draft can be populated before
   publication. An existing package version is immutable: never overwrite
   its archive or edit installed release directories. On uncertain upload,
   read the original release/asset identity before acting again.
5. Anonymous HTTPS download of each final `target.url` must return the exact
   signed size and digest. Testing only `gh release download` with the
   publisher's credentials is insufficient.

Task tags use `v<version>` in `waksana/cockpit-task`, WeChat tags use
`v<version>` in `waksana/cockpit-wechat-connector`, and the bundled Assistant
uses `assistant-v<version>` in `waksana/cockpit`.

## Publish the signed catalog

Combine the exact `target.json` objects with:

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "sequence": 1,
  "issuedAt": "RFC3339 UTC timestamp",
  "expiresAt": "a later bounded UTC expiry",
  "targets": []
}
```

Use a strictly increasing sequence for each changed catalog. The consumer
binds the accepted sequence to the envelope digest, so a publisher cannot
reuse a counter for different bytes. Include only fully published and
anonymously downloadable packages, then sign:

```sh
node scripts/sign-module-release.mjs CATALOG_JSON PROTECTED_PRIVATE_KEY modules.signed.json
```

Publish `modules.signed.json` on the fixed `modules-stable` Release. Updating
this discovery asset is explicit; old package Releases remain unchanged.
Preserve the previous signed catalog and publisher receipt for diagnosis,
but do not roll consumers below their accepted sequence floor.

Finally exercise `modules/updates/check` and a selected install through the
same backend API used by Web and MCP, with **no download credential**. Confirm
signature/expiry/sequence, archive identity, installation receipt and actual
service/session application separately. No check or download turns on periodic
installation or automatically starts a previously stopped service.

## Optional private channels

A host may explicitly override `releaseChannel` and supply a protected
`tokenFile` for a custom private distribution. This is not the official
default. That token is sent only to its configured metadata origin and never
forwarded to another redirect origin. 401, 403 and 404 remain distinct errors;
404 can mean a resource hidden from that identity, not proof of absence.
The downloader neither retries anonymously nor disables signature verification.
