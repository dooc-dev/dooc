class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.17"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.17/dooc-darwin-arm64.tar.gz"
      sha256 "3e1aa1e3b231e5511305b099b22310e84ffd8d38872ec3271a8e28d99f88a8d0"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.17/dooc-darwin-x64.tar.gz"
      sha256 "2989bcfb51de8b0cee05f65b97bfca00794fad4736b2bba66012cd57ce536a2e"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.17/dooc-linux-arm64.tar.gz"
      sha256 "321bc7af53207656c9fa1d1022e584edd660ef6614bc351c783947171982b73c"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.17/dooc-linux-x64.tar.gz"
      sha256 "bd2f43d2b66bada3799b5650270abfcc36082fc12bff09a397a0bda17e0d3bd8"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
