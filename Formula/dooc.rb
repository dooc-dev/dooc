class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.20"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.20/dooc-darwin-arm64.tar.gz"
      sha256 "d2566fecf4ec384bf344ac2e2a0f906cb95bd2567b2a4d3dd69c92640d6c8d7c"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.20/dooc-darwin-x64.tar.gz"
      sha256 "16fd70fd239e57742b2052b3b5e22b2db09863d574a8a29fc4ce6a3613f0f0d1"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.20/dooc-linux-arm64.tar.gz"
      sha256 "3055fcaec2e73ad7156e27545e84209fc11749a8bd28309a54420616b089501d"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.20/dooc-linux-x64.tar.gz"
      sha256 "9500ac351594922982003c7b1cdd3a63731ca6d606fc788f61ab2103f7263109"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
