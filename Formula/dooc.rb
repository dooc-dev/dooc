class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.21"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.21/dooc-darwin-arm64.tar.gz"
      sha256 "edcedd81856f97f42712da4670f59e4647cfd573ce5151ed9a0a5ef9c18f7ee2"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.21/dooc-darwin-x64.tar.gz"
      sha256 "2d4cdc90ebde6d5e42fa3ba69d7482cffa7a229a292d62b350a8c15740eeb351"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.21/dooc-linux-arm64.tar.gz"
      sha256 "8619fc0a96328423777b3e2c4af313754eeb0968ffbf21e59e9cea7fbfd3a81d"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.21/dooc-linux-x64.tar.gz"
      sha256 "a232b9c4a1403cd383905f0073c5804348f65fa252351011cf6d88c49c263e6c"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
