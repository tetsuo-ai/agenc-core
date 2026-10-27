# Building a broker for older Linux distributions

`npm run build` uses the local C compiler and libc headers. Its native broker
can therefore require a newer GLIBC than the system where a copied build will
run. The release workflow already builds Linux runtimes in a pinned glibc 2.28
container and checks the complete artifact's GLIBC ceiling. Use those verified
release artifacts for general distribution.

For a source build intended for Debian bullseye, preload this immutable native
x64 builder image:

```
docker pull node@sha256:42ba460c07a41a9d140eba352dd24658522bd2a060e6544b7f5dfcace92097ad
AGENC_LINUX_BROKER_PORTABLE=1 npm run build
```

Alternatively, after an ordinary build, run
`npm run build:linux-broker:portable --workspace=@tetsuo-ai/runtime` to replace
only its broker, embedded namespace-init entry and session-sandbox helper.
Run this step last, since another ordinary build replaces native outputs.

The portable command does not pull images or use the network. It mounts the
native sources read-only, compiles as the invoking UID with the image's fixed
GCC 10 compiler, and checks a GLIBC ceiling of 2.31, PIE, full RELRO, NX stack
and stack protection before installing the outputs. Failed builds preserve the
previous broker. `dist/linux-broker-build.json` records the immutable builder,
compiler, ABI requirement and source/artifact hashes. This receipt is build
evidence, not runtime authentication or a signature.

The shared compiler also supplies a missing SYS_close_range alias for older
libc headers, preferring the kernel header's __NR_close_range definition.
This changes no syscall behavior. Unsupported kernels still fail the existing
containment checks; the build does not provide an emulation fallback.

The C sources, bootstrap protocol and runtime owner/mode trust check are
unchanged. The broker remains dynamically linked, allowing system libc security
updates; no extra statically linked libc or licensing requirement is introduced.
The embedded namespace init and session helper keep their existing static
linkage. Native x64 is the only architecture supported by this convenience
command. The existing release workflow retains its x64 and arm64 glibc 2.28
builders.

This command repairs the broker ABI. It does not make other native modules,
including SQLite, compatible with bullseye or guarantee full application
startup. Use the release artifact or rebuild all required native modules against
the intended baseline. Compatibility with an older libc also does not provide
missing kernel features, writable cgroups or namespace permissions.
