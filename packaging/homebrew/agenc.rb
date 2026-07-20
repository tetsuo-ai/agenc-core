# Homebrew formula template for the AgenC CLI (TODO task 4).
#
# OWNER-PUBLISH STEP — this file is a template, not a live formula:
#   1. Cut a release (agenc-v<version>) with the darwin tarballs + manifest
#      uploaded as assets (see docs/install.md).
#   2. Fill url/sha256 below from the release manifest (one bottle-style block
#      per platform, or point at install.sh's contract).
#   3. Push to the tap repo (tetsuo-ai/homebrew-agenc) as Formula/agenc.rb.
#
# The formula deliberately reuses scripts/install/install.sh so every install
# path shares one verified contract (manifest -> sha256 -> runtime tree).
class Agenc < Formula
  desc "Daemon-backed, terminal-native coding agent"
  homepage "https://github.com/tetsuo-ai/agenc-core"
  # OWNER: point at the released installer script (or vendor it via the tap).
  url "https://github.com/tetsuo-ai/agenc-core/releases/download/agenc-vX.Y.Z/agenc-installer.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_ASSET_SHA256"
  license "MIT"

  # AgenC 0.8.1 is the deliberately narrow Node 25.9.0 compatibility bridge.
  # Homebrew/core does not retain a node@25 formula, so publishing an enabled
  # formula would silently select an unsupported ABI. Re-enable only after the
  # runtime release contract moves to a supported Node line with bottles.
  disable! date: "2026-07-19", because: "AgenC 0.8.1 requires unavailable Node 25.9.0"

  depends_on "ripgrep"

  def install
    # The installer speaks the runtime-manager contract: manifest fetch,
    # sha256 verify, extract to AGENC_HOME/runtime/<version>/, wrapper.
    system "sh", "install.sh",
           "--prefix", prefix.to_s,
           "--no-daemon",
           "--version", version.to_s
  end

  def caveats
    <<~EOS
      Start the daemon as a user service:
        agenc daemon start
      Guided setup:
        agenc onboard
      Security posture:
        agenc security audit
    EOS
  end

  test do
    assert_match "agenc", shell_output("#{bin}/agenc --version")
  end
end
