# @tetsuo-ai/desktop-server

Private desktop control server for AgenC.

This workspace owns the desktop-side server that pairs the runtime with the
desktop contract package in `contracts/desktop-tool-contracts/`.

Local commands:

```bash
npm --prefix containers/desktop/server run build
npm --prefix containers/desktop/server run start
npm --prefix containers/desktop/server run test
```

`prebuild` automatically rebuilds the desktop contract package before the
server compiles.

