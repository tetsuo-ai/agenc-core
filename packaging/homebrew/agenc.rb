# Homebrew formula template for the self-contained AgenC runtime.
#
# OWNER-PUBLISH STEP — this file remains deliberately unpublishable until the
# two placeholder digests are replaced from an immutable agenc-v0.14.1
# manifest and the formula is copied to tetsuo-ai/homebrew-agenc.
class Agenc < Formula
  desc "Daemon-backed, terminal-native coding agent"
  homepage "https://github.com/tetsuo-ai/agenc-core"
  url "https://github.com/tetsuo-ai/agenc-releases/releases/download/agenc-v0.14.1/agenc-runtime-0.14.1-darwin-#{Hardware::CPU.arm? ? "arm64" : "x64"}-node26-abi147.tar.gz"
  version "0.14.1"
  arm64_sha256 = "REPLACE_WITH_DARWIN_ARM64_SHA256"
  x64_sha256 = "REPLACE_WITH_DARWIN_X64_SHA256"
  sha256 Hardware::CPU.arm? ? arm64_sha256 : x64_sha256
  license "MIT"

  # The runtime artifact includes its reviewed Node 26.5.0 executable. Keep
  # ripgrep as the only host tool dependency used by the coding-agent surface.
  depends_on macos: :ventura
  depends_on "ripgrep"

  def install
    odie "AgenC requires macOS 13.5 or newer." if MacOS.full_version < "13.5"
    (libexec/"node_modules").install buildpath.children

    node_bin = libexec/"node_modules/.agenc-node/bin/node"
    runtime_bin = libexec/"node_modules/@tetsuo-ai/runtime/bin/agenc"
    odie "runtime artifact is missing private Node" unless node_bin.executable?
    odie "runtime artifact is missing AgenC" unless runtime_bin.file?

    (bin/"agenc").write <<~SH
      #!/bin/sh
      if [ -z "${AGENC_HOME:-}" ]; then
        export AGENC_HOME="${HOME}/.agenc"
      fi
      if [ -n "${PATH:-}" ]; then
        export PATH="#{node_bin.dirname}:$PATH"
      else
        export PATH="#{node_bin.dirname}"
      fi
      case " ${NODE_OPTIONS:-} " in
        *heapsnapshot-near-heap-limit*)
          exec "#{node_bin}" "#{runtime_bin}" "$@"
          ;;
        *)
          mkdir -p "${AGENC_HOME}/oom-snapshots" 2>/dev/null || :
          exec "#{node_bin}" --heapsnapshot-near-heap-limit=1 \
            --diagnostic-dir="${AGENC_HOME}/oom-snapshots" "#{runtime_bin}" "$@"
          ;;
      esac
    SH
  end

  service do
    run [opt_bin/"agenc", "daemon", "start", "--foreground"]
    keep_alive true
    process_type :interactive
    working_dir Dir.home
    log_path var/"log/agenc.log"
    error_log_path var/"log/agenc.error.log"
  end

  def caveats
    <<~EOS
      Start the daemon as a user service:
        brew services start agenc
      Guided setup:
        agenc onboard
      Security posture:
        agenc security audit

      Homebrew upgrades the complete AgenC + private Node runtime together.
      Use `brew upgrade agenc`, not `agenc update`, for this installation.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agenc --version")
  end
end
