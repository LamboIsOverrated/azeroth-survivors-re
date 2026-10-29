# Headless login-cycle fixture

```sh
cargo test --locked --manifest-path crates/benilla-app/tests/io-fixture/Cargo.toml
```

This test workspace compiles the actual `net/io.rs` login-cycle and outer
sequencer functions, their actual park request types, and the same native
SRP/world fixture used by the app tests. The build script extracts those source
items verbatim and fails if their boundaries change. Renderer logging and packet
census adapters are no-ops; authentication, encrypted packets, TCP connections,
channel waiting and cycle outcomes use production code. It does not build Bevy
or need client game assets.

The idle test shortens the gateway's inactivity deadline and sends the same
keepalive park request as the browser frame pump. It checks that encrypted PONGs
buffered during select do not disrupt character creation or roster refresh. A
separate close-at-entry fixture preserves the `SessionEnd::Lost` boundary; it
never submits credentials again. The pure frame-pump cadence test checks the
30-second interval, login-screen queue suppression and writer handover timing.

Browser WASM compilation and the existing app login-policy tests remain separate
checks. This harness does not stand in for a live browser/world acceptance run.
