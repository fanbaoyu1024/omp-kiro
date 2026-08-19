# omp-kiro

Kiro (AWS) provider plugin for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`), reusing the current `kiro.dev` runtime and management APIs. Built on the OMP extension interface: `pi.registerProvider("kiro", config)` with device-code OAuth (`/login`), profile-scoped model discovery (`fetchDynamicModels`), and a custom EventStream runtime (`streamSimple`).

## Install

Directly from npm:

```sh
omp plugin install omp-kiro
```

Or through this repository's OMP marketplace:

```sh
omp plugin marketplace add fanbaoyu1024/omp-kiro
omp plugin install omp-kiro@fanbaoyu-kiro
```

OMP loads the entry declared in `package.json#omp.extensions` (`./dist/extension.js`). Then log in:

```sh
omp /login
# choose: Kiro (AWS Builder ID / IAM Identity Center plugin)
```

The login prompts for your IAM Identity Center start URL (leave blank for AWS Builder ID), opens the device-code verification URL, and polls until you authorize. Credentials refresh automatically; the resolved profile ARN routes requests to the right Kiro profile.

## Provider identity

The plugin registers the canonical Kiro surfaces:

- provider id: `kiro`
- stream API id: `kiro-api`
- display name: `Kiro (AWS Builder ID / IAM Identity Center plugin)`

When enabled, this plugin replaces or extends OMP's built-in Kiro registration. Do not install another Kiro provider extension alongside it.

## How it works

- **OAuth**: OIDC device authorization flow (`client/register` → `device_authorization` → token polling) against `oidc.<region>.amazonaws.com`. `oauth.getApiKey` returns a structured JSON API key (`{token, region, profileArn}`) that the stream layer parses.
- **Dynamic catalog**: only `fetchDynamicModels` is configured — never `models` (OMP's registry ignores `fetchDynamicModels` when `models` is non-empty). The function returns the offline bootstrap catalog when unauthenticated and queries the profile-scoped management API (`List-Available-Profiles` + `List-Available-Models`) when authenticated.
- **Runtime**: `streamSimple` posts to `https://runtime.<region>.kiro.dev/generateAssistantResponse` and decodes AWS `application/vnd.amazon.eventstream` frames (CRC-checked prelude/message framing) into OMP assistant events.
- **Cache safety**: only standard `ProviderModelConfig` fields are emitted. The region travels on the per-model `baseUrl`, the profile ARN in the standard `x-amzn-kiro-profile-arn` header, and the thinking surface in the standard `thinking` metadata — custom fields would be dropped by OMP's SQLite model cache.

## Known limitations

- OMP resolves the API key for `fetchDynamicModels` from the stored credential. When it is a plain bearer token (not the structured JSON this plugin's `getApiKey` produces for streaming), catalog discovery falls back to the default `us-east-1` management region. Structured keys — including the one produced by `oauth.getApiKey` — carry the region and are honored when present.
- The raw Kiro request-field schema cannot survive OMP's model cache; the wire effort vocabulary is approximated by the standard low→max ladder and the `reasoning`/`output_config` field choice is encoded in `thinking.mode`.
- If the structured API key carries no profile ARN yet, the first stream resolves one via `List-Available-Profiles`; afterwards the resolved ARN is cached on the models' headers.

## Development

```sh
bun install
bun run typecheck
bun run test
bun run build   # dist/ with bun + declaration files
```

## License

MIT
