# piped-player-n-decoder

A small service that deciphers YouTube streaming URLs for the [Piped backend](https://github.com/noahbroyles/Piped-Backend), so that it can hand out SABR URLs.

YouTube's streaming URLs carry an obfuscated `n` parameter. Only YouTube's own player JavaScript can work out its real value, and googlevideo answers SABR requests with a 403 without it. NewPipeExtractor can no longer extract that code from current players, so this service runs the player with [youtubei.js](https://github.com/LuanRT/YouTube.js) instead.

## API

| Request | Response |
|---|---|
| `GET /sts` | `{"signatureTimestamp": 20737}`, which the backend puts in its player request so that the URL matches the player used below |
| `POST /decipher` with `{"url": "...", "signatureTimestamp": 20737}` | `{"url": "..."}` with the `n` parameter deciphered |
| `GET /healthz` | `{"ok": true}` |

Only `googlevideo.com` and `youtube.com` URLs are accepted. The player is refreshed every hour, and the last three are kept, so URLs fetched just before a refresh still decipher with the right one.

## Running

It is meant to run next to the backend in [Piped-Docker](https://github.com/noahbroyles/Piped-Docker), which sets it up for you. On its own:

```sh
docker run -d --name piped-player-n-decoder ghcr.io/noahbroyles/piped-player-n-decoder
```

Then set `PLAYER_N_DECODER_URL:http://piped-player-n-decoder:3001` in the backend's `config.properties`. Keep it on the internal network: it has no authentication, and nothing outside your stack needs it.

| Variable | Default | |
|---|---|---|
| `PORT` | `3001` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to listen on |
| `PLAYER_REFRESH_MINUTES` | `60` | How often to fetch YouTube's current player |

## Security

Deciphering means running JavaScript that YouTube serves, and youtubei.js puts the `n` value from the URL into that script's source. So `n` may only contain `A-Z`, `a-z`, `0-9`, `_` and `-`, and URLs with a nested `url` parameter (which youtubei.js would decipher instead) are refused. The service runs it in an empty `node:vm` context (no `require`, `process` or network access) with a 5 second time limit. The image is based on [distroless](https://github.com/GoogleContainerTools/distroless) Node.js, which has no shell or package manager, and runs as an unprivileged user. `node:vm` is not a complete sandbox, so keep the container on its own with no secrets or volumes, as Piped-Docker does.

## License

[AGPL-3.0](LICENSE), like Piped.
