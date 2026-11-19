class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.19"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.19/dooc-darwin-arm64.tar.gz"
      sha256 "7d5c6aad3a5e390de613d40041a2474334853c34a90f55ad4bb14fb88f0d06cf"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.19/dooc-darwin-x64.tar.gz"
      sha256 "417cde6e1d8c2b2070594087c13b307d6b6ec549ab9e2716592e921822e9438e"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.19/dooc-linux-arm64.tar.gz"
      sha256 "d817198583c8912565dee7de4dc87ff3ddb08bcb6e1bc9e62993e0204f4df04b"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.19/dooc-linux-x64.tar.gz"
      sha256 "41468b3107730eeb3de33282d5c3f3a9cfe0d5d43678303c74574fd5cce8a9c4"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
